// packages/example/src/client.ts
import { Effect, Layer, References } from "effect";

import { EffectGrpcClient } from "@dr_nikson/effect-grpc";
import { NodeRuntime } from "@effect/platform-node";

import * as address from "./address.js";
import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";

const HelloWorldAPIClientTag = effectProto.makeHelloWorldAPIClientTag<object>("{}");
type HelloWorldAPIClientTag = typeof HelloWorldAPIClientTag;

const debugApiClientLayer = effectProto.helloWorldAPIClientLiveLayer(HelloWorldAPIClientTag).pipe(
  Layer.provideMerge(
    Layer.effect(
      effectProto.HelloWorldAPIConfigTag,
      Effect.map(address.baseUrl, (baseUrl) => EffectGrpcClient.GrpcClientConfig({ baseUrl })),
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
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Trace")),
);

NodeRuntime.runMain(Effect.provide(prog, deps).pipe(Effect.scoped));
