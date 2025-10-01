import { Effect, Layer, LogLevel, Logger } from "effect";

import { EffectGrpcClient } from "@dr_nikson/effect-grpc";
import { NodeRuntime } from "@effect/platform-node";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";

const HelloWorldAPIClientTag = effectProto.HelloWorldAPIClient.makeTag<object>("{}");
type HelloWorldAPIClientTag = typeof HelloWorldAPIClientTag;

const debugApiClientLayer = effectProto.HelloWorldAPIClient.liveLayer(HelloWorldAPIClientTag).pipe(
  Layer.provideMerge(
    // We provide config for local deployment http://localhost:8000
    Layer.succeed(
      effectProto.HelloWorldAPIConfigTag,
      EffectGrpcClient.GrpcClientConfig({
        baseUrl: "http://localhost:8000",
      }),
    ),
  ),
);

const prog = Effect.gen(function* () {
  const client = yield* HelloWorldAPIClientTag;

  const response = yield* client.getGreeting(
    {
      name: "Meowucher",
    },
    {},
  );

  yield* Effect.logInfo(`Got some response from gRPC: ${response.greeting}`);
});

const deps = Layer.empty.pipe(
  Layer.provideMerge(debugApiClientLayer),
  Layer.provideMerge(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
  Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Trace)),
);

NodeRuntime.runMain(Effect.provide(prog, deps));
