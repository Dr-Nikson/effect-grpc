import { Context, Effect, Layer } from "effect";

import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import {
  CallOptions,
  Client,
  Transport,
  createClient,
  createContextValues,
} from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";

import type * as T from "./client.js";
import * as protoRuntime from "./protoRuntime.js";

export const grpcClientRuntimeTypeId = Symbol("@dr_nikson/effect-grpc/GrpcClientRuntime");

export const grpcClientRuntimeTag = Context.GenericTag<T.GrpcClientRuntime, T.GrpcClientRuntime>(
  grpcClientRuntimeTypeId.toString(),
);

// TODO: this abstraction is kinda useless, right? We can make more in use .. can we?
export function liveGrpcClientRuntime(): Layer.Layer<T.GrpcClientRuntime> {
  const instance: T.GrpcClientRuntime = {
    Type: grpcClientRuntimeTypeId,

    makeExecutor<Shape extends GenServiceMethods>(
      serviceDefinition: GenService<Shape>,
      methodNames: ReadonlyArray<keyof GenService<Shape>["method"]>,
    ) {
      return Effect.gen(function* () {
        const transport: Transport = yield* Effect.sync(() =>
          createGrpcTransport({
            baseUrl: "http://localhost:8000",
          }),
        );
        const client: Client<GenService<Shape>> = createClient(serviceDefinition, transport);
        const instance: protoRuntime.ClientExecutor<Shape> = methodNames.reduce(
          (acc, methodName) => {
            const method = makeExecutorMethod(client, methodName, serviceDefinition);

            return method === null ? acc : { ...acc, [methodName]: method };
          },
          {} as any,
        );

        return instance;
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
