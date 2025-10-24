import { Context, Effect, Layer } from "effect";

import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import type { CallOptions, Client, Transport } from "@connectrpc/connect";
import { createClient, createContextValues } from "@connectrpc/connect";
import { Http2SessionManager, createGrpcTransport } from "@connectrpc/connect-node";

import type * as T from "./client.js";
import * as protoRuntime from "./protoRuntime.js";

export const grpcClientRuntimeTypeId = Symbol("@dr_nikson/effect-grpc/GrpcClientRuntime");

export const grpcClientRuntimeTag = Context.GenericTag<T.GrpcClientRuntime, T.GrpcClientRuntime>(
  grpcClientRuntimeTypeId.toString(),
);

/**
 * @internal
 * Creates a managed HTTP/2 session manager as an Effect resource.
 * The session manager is automatically aborted when the scope closes.
 * This is important because otherwise we might stuck waiting for the connections to timeout
 */
function createManagedSessionManager(config: T.GrpcClientConfig<any>) {
  return Effect.acquireRelease(
    Effect.sync(
      () => new Http2SessionManager(config.baseUrl, config.pingOptions, config.http2SessionOptions),
    ),
    (sessionManager) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("ManagedSessionManager is being released...");

        return yield* Effect.sync(() => sessionManager.abort());
      }),
  );
}

export function liveGrpcClientRuntime(): Layer.Layer<T.GrpcClientRuntime> {
  const instance: T.GrpcClientRuntime = {
    Type: grpcClientRuntimeTypeId,

    makeExecutor<Shape extends GenServiceMethods>(
      serviceDefinition: GenService<Shape>,
      methodNames: ReadonlyArray<keyof GenService<Shape>["method"]>,
      config: T.GrpcClientConfig<any>,
    ) {
      return Effect.gen(function* () {
        // Create managed HTTP/2 session manager as a resource
        // This will be released when the scope closes
        const sessionManager = yield* createManagedSessionManager(config);

        // Build transport options
        const transportOptions = {
          httpVersion: "2" as const,
          baseUrl: config.baseUrl.toString(),
          sessionManager,
          ...(config.binaryOptions && { binaryOptions: config.binaryOptions }),
          ...(config.acceptCompression && { acceptCompression: config.acceptCompression }),
          ...(config.sendCompression && { sendCompression: config.sendCompression }),
          ...(config.compressMinBytes && { compressMinBytes: config.compressMinBytes }),
          ...(config.defaultTimeoutMs && { defaultTimeoutMs: config.defaultTimeoutMs }),
        };

        // Create transport with the managed session manager
        const transport: Transport = yield* Effect.sync(() =>
          createGrpcTransport(transportOptions),
        );

        // Create the client
        const client: Client<GenService<Shape>> = createClient(serviceDefinition, transport);

        // Build executor methods
        const executor: protoRuntime.ClientExecutor<Shape> = methodNames.reduce(
          (acc, methodName) => {
            const method = makeExecutorMethod(client, methodName, serviceDefinition);

            return method === null ? acc : { ...acc, [methodName]: method };
          },
          {} as any,
        );

        return executor;
      });
    },
  };

  return Layer.succeed(grpcClientRuntimeTag, instance);
}

type UnaryFn<I extends DescMessage, O extends DescMessage> = (
  request: MessageInitShape<I>,
  options: CallOptions,
) => Promise<MessageShape<O>>;

function makeExecutorMethod<Shape extends GenServiceMethods>(
  client: Client<GenService<Shape>>,
  methodName: keyof GenService<Shape>["method"],
  serviceDefinition: GenService<Shape>,
) {
  const method = serviceDefinition.method[methodName];

  switch (method.methodKind) {
    case "unary":
      return (req: any, opts: T.RequestMeta): Effect.Effect<any> => {
        return Effect.promise((signal) => {
          const method = client[methodName].bind(client) as UnaryFn<any, any>;

          return method(req, {
            // timeoutMs: null,
            // TODO: tracing
            headers: opts.headers,
            signal,
            // onHeader: null,
            // onTrailer: null,
            contextValues: createContextValues(),
          } as CallOptions);
        });
      };
    default:
      return null;
  }
}

export function makeGrpcClientConfigTag<Service extends string>(service: Service) {
  return Context.GenericTag<T.GrpcClientConfig<Service>, T.GrpcClientConfig<Service>>(
    `@dr_nikson/effect-grpc/GrpcClientConfig<${service}>`,
  );
}

export function makeGrpcClientConfig<Service extends string>(
  opts: Omit<T.GrpcClientConfig<Service>, "_Service">,
) {
  return {
    ...opts,
    _Service: () => void 0,
  } as T.GrpcClientConfig<Service>;
}
