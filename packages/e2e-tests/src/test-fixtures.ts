// packages/e2e-tests/src/test-fixtures.ts
import { Brand, Context, Effect, Layer } from "effect";
import { getPort } from "get-port-please";

import { Code } from "@connectrpc/connect";
import { EffectGrpcClient, EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import type * as proto from "./generated/com/example/v1/hello_world_api_pb.js";

// Branded Port type
export type Port = number & Brand.Brand<"Port">;
export const Port = Context.GenericTag<Port>("Port");

// Port layer - gets available port dynamically
export const PortLive = Layer.effect(
  Port,
  Effect.promise(() => getPort()).pipe(Effect.map((port) => port as Port)),
);

// Server service implementation
export const HelloWorldAPIServiceLive: effectProto.HelloWorldAPIService = {
  getGreeting(request: proto.GetGreetingRequest) {
    return Effect.logInfo("getGreeting called in E2E test").pipe(
      Effect.as({
        greeting: `Hello, ${request.name}! This is an E2E test.`,
      }),
    );
  },

  faceTheError: Effect.fn("HelloWorldAPIServiceLive.faceTheError")(function* (
    request: proto.GetGreetingRequest,
  ) {
    yield* Effect.logInfo(`faceTheError called for ${request.name}`);

    return yield* GrpcException.create(
      Code.FailedPrecondition,
      `Sorry ${request.name}, you must face the consequences!`,
    );
  }),
};

export const serverServiceLayer = effectProto.helloWorldAPIServiceLiveLayer(
  effectProto.HelloWorldAPIServiceTag,
  HelloWorldAPIServiceLive,
);

export function createServer(): Effect.Effect<
  EffectGrpcServer.GrpcServer<"com.example.v1.HelloWorldAPI">,
  never,
  effectProto.HelloWorldAPIServiceTag["Identifier"]
> {
  return Effect.gen(function* () {
    const service: effectProto.HelloWorldAPIGrpcService =
      yield* effectProto.HelloWorldAPIServiceTag;

    return EffectGrpcServer.GrpcServerBuilder().withService(service).build();
  });
}

// Client config layer - depends on Port using flatMap
export const ClientConfigLayer = Layer.service(Port).pipe(
  Layer.flatMap((ctx) =>
    Layer.succeed(
      effectProto.HelloWorldAPIConfigTag,
      EffectGrpcClient.GrpcClientConfig({
        baseUrl: new URL(`http://localhost:${Context.get(ctx, Port)}`),
      }),
    ),
  ),
);

// Client layer - depends on ClientConfig and GrpcClientRuntime
export const clientLayer = effectProto
  .helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag)
  .pipe(
    Layer.provide(ClientConfigLayer),
    Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
  );

// Re-export proto types for convenience
export { effectProto };
