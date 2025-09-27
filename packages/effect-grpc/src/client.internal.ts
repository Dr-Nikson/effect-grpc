import { Effect, Layer } from "effect";

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

import { Executor, GrpcClient, RequestMeta } from "./client.js";

export const grpcClientTypeId = Symbol("@tipizzato/effect-grpc/GrpcClient");

export function liveGrpcClient(): Layer.Layer<GrpcClient> {
  const prog = Effect.gen(function* () {
    const transport: Transport = yield* Effect.sync(() =>
      createGrpcTransport({
        baseUrl: "http://localhost:8000",
      }),
    );
    const instance: GrpcClient = {
      Type: grpcClientTypeId,

      makeExecutor<Shape extends GenServiceMethods>(
        serviceDefinition: GenService<Shape>,
        methodNames: ReadonlyArray<keyof GenService<Shape>["method"]>,
      ) {
        const client: Client<GenService<Shape>> = createClient(serviceDefinition, transport);
        const instance: Executor<Shape> = methodNames.reduce((acc, methodName) => {
          const method = makeExecutorMethod(client, methodName, serviceDefinition);

          return method === null ? acc : { ...acc, [methodName]: method };
        }, {} as any);

        return instance;
      },
    };

    return instance;
  });

  return Layer.effect(GrpcClient, prog);
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
      return (req: any, opts: RequestMeta): Effect.Effect<any> => {
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
