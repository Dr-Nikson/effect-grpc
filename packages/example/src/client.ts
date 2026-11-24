// packages/example/src/client.ts
import { Effect, Layer, LogLevel, Logger } from "effect";

import { EffectGrpcClient } from "@dr_nikson/effect-grpc";
import { NodeRuntime } from "@effect/platform-node";

import * as address from "./address.js";
import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";

const HelloWorldAPIClientTag = effectProto.HelloWorldAPIClientTag<object>("{}");
type HelloWorldAPIClientTag = typeof HelloWorldAPIClientTag;

const debugApiClientLayer = effectProto.helloWorldAPIClientLiveLayer(HelloWorldAPIClientTag).pipe(
  Layer.provideMerge(
    // We provide config for local deployment: the address the example server binds
    Layer.effect(
      effectProto.HelloWorldAPIConfigTag,
      Effect.map(address.port, (port) =>
        EffectGrpcClient.GrpcClientConfig({
          baseUrl: new URL(`http://${address.host}:${port}`),
        }),
      ),
    ),
  ),
);

const prog = Effect.gen(function* () {
  const client = yield* HelloWorldAPIClientTag;
  const request = {
    name: "Meowucher",
  };

  const response = yield* client.getGreeting(request, {});

  yield* Effect.logInfo(`Got some response from gRPC: ${response.greeting}`);

  const neverActuallyHappen = yield* client.faceTheError(request, {});

  yield* Effect.logInfo(`What is never happen? huh?: ${neverActuallyHappen.greeting}`);
});

const deps = Layer.empty.pipe(
  Layer.provideMerge(debugApiClientLayer),
  Layer.provideMerge(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
  Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Trace)),
);

NodeRuntime.runMain(Effect.provide(prog, deps).pipe(Effect.scoped));
