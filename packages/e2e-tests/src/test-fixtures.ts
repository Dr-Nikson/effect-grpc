// packages/e2e-tests/src/test-fixtures.ts
import { Context, Effect, Layer } from "effect";

import { Code } from "@connectrpc/connect";
import { EffectGrpcClient, EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import type * as proto from "./generated/com/example/v1/hello_world_api_pb.js";

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

export function clientLayer(
  address: EffectGrpcServer.GrpcServerAddress,
): Layer.Layer<effectProto.HelloWorldAPIClientTag["Identifier"]> {
  return effectProto
    .helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag)
    .pipe(
      Layer.provide(
        Layer.succeed(
          effectProto.HelloWorldAPIConfigTag,
          EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL(address.url) }),
        ),
      ),
      Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
    );
}

export class TestServer extends Context.Tag("e2e/TestServer")<
  TestServer,
  EffectGrpcServer.GrpcServerAddress
>() {}

export function testServer(listen: {
  readonly host: string;
  readonly port: number;
}): Layer.Layer<
  TestServer,
  EffectGrpcServer.GrpcServerBindError,
  effectProto.HelloWorldAPIServiceTag["Identifier"]
> {
  return Layer.scoped(
    TestServer,
    Effect.flatMap(createServer(), (server) => server.listen(listen)),
  );
}

/**
 * Provide it inside `testServer`. The server's stop waits for open sessions, so the client's
 * session has to close first. Build no server inside it: the generated client and service tags
 * share one key, so a server built there would read the client as its service.
 */
export const testClient: Layer.Layer<
  effectProto.HelloWorldAPIClientTag["Identifier"],
  never,
  TestServer
> = Layer.unwrapEffect(Effect.map(TestServer, clientLayer));

// Re-export proto types for convenience
export { effectProto };
