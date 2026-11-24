// packages/e2e-tests/src/test-fixtures.ts
import { Effect, Layer } from "effect";
import type { Scope } from "effect";

import type { Transport } from "@connectrpc/connect";
import { Code } from "@connectrpc/connect";
import {
  Http2SessionManager,
  createConnectTransport,
  createGrpcTransport,
  createGrpcWebTransport,
} from "@connectrpc/connect-node";
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

/**
 * On Node 22, `server.close()` waits for every open HTTP/2 session, so each client session is
 * aborted in a finalizer that runs before the server's scope closes (#101).
 */
const sessionTo = (baseUrl: string): Effect.Effect<Http2SessionManager, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new Http2SessionManager(baseUrl)),
    (sessionManager) => Effect.sync(() => sessionManager.abort()),
  );

export const overEachProtocol = <A>(
  baseUrl: string,
  run: (transport: Transport) => Effect.Effect<A>,
): Effect.Effect<{ grpc: A; grpcWeb: A; connect: A }, never, Scope.Scope> =>
  Effect.gen(function* () {
    return {
      grpc: yield* run(createGrpcTransport({ baseUrl, sessionManager: yield* sessionTo(baseUrl) })),
      grpcWeb: yield* run(
        createGrpcWebTransport({
          baseUrl,
          httpVersion: "2",
          sessionManager: yield* sessionTo(baseUrl),
        }),
      ),
      connect: yield* run(
        createConnectTransport({
          baseUrl,
          httpVersion: "2",
          sessionManager: yield* sessionTo(baseUrl),
        }),
      ),
    };
  });

// Re-export proto types for convenience
export { effectProto };
