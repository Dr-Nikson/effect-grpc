import { Context, Effect, Layer, LogLevel, Logger } from "effect";

import type { HandlerContext } from "@connectrpc/connect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { NodeRuntime } from "@effect/platform-node";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import * as proto from "./generated/com/example/v1/hello_world_api_pb.js";

const HelloWorldAPITag = effectProto.HelloWorldAPIService.makeTag<HandlerContext>(
  "HandlerContext" as const,
);
type HelloWorldAPITag = Context.Tag.Identifier<typeof HelloWorldAPITag>;

const HelloWorldAPIServiceLive: effectProto.HelloWorldAPIService<HandlerContext> = {
  getGreeting(request: proto.GetGreetingRequest) {
    return Effect.logInfo("getGreeting called, this is really cool!").pipe(
      Effect.as({
        greeting: `Hey there! Your name is ${request.name}, right?`,
      }),
    );
  },
};

const debugApiLayer =
  effectProto.HelloWorldAPIService.liveLayer(HelloWorldAPIServiceLive)(HelloWorldAPITag);

function gRpcServer(): Effect.Effect<
  EffectGrpcServer.GrpcServer<"com.example.v1.HelloWorldAPI">,
  never,
  HelloWorldAPITag
> {
  return Effect.gen(function* () {
    const debugApi: effectProto.HelloWorldAPIGrpcService = yield* HelloWorldAPITag;

    return EffectGrpcServer.GrpcServerBuilder().withService(debugApi).build();
  });
}

const prog = Effect.gen(function* () {
  const server = yield* gRpcServer();

  return yield* server.run({
    host: "localhost",
    port: 8000,
  });
});

const layer = Layer.empty.pipe(
  Layer.provideMerge(debugApiLayer),
  Layer.provideMerge(Layer.scope),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Trace)),
);

NodeRuntime.runMain(Effect.provide(prog, layer));
