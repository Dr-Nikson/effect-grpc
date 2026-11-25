// packages/e2e-tests/src/handler-context.test.ts
import { Effect } from "effect";

import type { HandlerContext } from "@connectrpc/connect";
import { Code, createClient, createContextKey } from "@connectrpc/connect";
import { EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import { HelloWorldAPI } from "./generated/com/example/v1/hello_world_api_pb.js";
import { greet, overEachProtocol } from "./test-fixtures.js";

const describeContext = (ctx: HandlerContext): string =>
  [
    `${ctx.service.typeName}/${ctx.method.name}`,
    ctx.protocolName,
    ctx.requestHeader.get("x-e2e-probe") ?? "no x-e2e-probe header",
  ].join(" ");

const ContextEchoLive: effectProto.HelloWorldAPIService<HandlerContext> = {
  getGreeting: (_request, ctx) => Effect.sync(() => ({ greeting: describeContext(ctx) })),
  faceTheError: () => Effect.fail(GrpcException.create(Code.FailedPrecondition, "not called")),
};

const serve = Effect.gen(function* () {
  const service = yield* effectProto.HelloWorldAPIServiceTag;
  return yield* EffectGrpcServer.GrpcServerBuilder()
    .withService(service)
    .build()
    .listen({ host: "127.0.0.1", port: 0 });
}).pipe(
  Effect.provide(
    effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, ContextEchoLive),
  ),
);

describe("The context a handler receives with no context transformer", () => {
  it.live(
    "is the call's HandlerContext, which a handler typed for HandlerContext reads over gRPC, gRPC-web and Connect",
    () =>
      Effect.gen(function* () {
        const { url } = yield* serve;
        const greetings = yield* overEachProtocol(url, (transport) =>
          Effect.promise(() =>
            createClient(HelloWorldAPI, transport).getGreeting(
              { name: "context" },
              { headers: { "x-e2e-probe": "sent by the client" } },
            ),
          ).pipe(Effect.map(({ greeting }) => greeting)),
        );

        expect(greetings, "each handler's view of its context, echoed in the reply").toEqual({
          grpc: "com.example.v1.HelloWorldAPI/GetGreeting grpc sent by the client",
          grpcWeb: "com.example.v1.HelloWorldAPI/GetGreeting grpc-web sent by the client",
          connect: "com.example.v1.HelloWorldAPI/GetGreeting connect sent by the client",
        });
      }),
  );
});

describe("Context transformers", () => {
  it.live(
    "run in order, the first with the call's HandlerContext as its current context, and each call starts with fresh context values",
    () =>
      Effect.gen(function* () {
        const visits = createContextKey(0, { description: "how often a transformer saw the call" });
        const stepsTag = effectProto.makeHelloWorldAPIServiceTag<Array<string>>("Steps");
        const echoSteps: effectProto.HelloWorldAPIService<Array<string>> = {
          getGreeting: (_request, steps) => Effect.succeed({ greeting: steps.join("; ") }),
          faceTheError: () =>
            Effect.fail(GrpcException.create(Code.FailedPrecondition, "not called")),
        };
        const address = yield* Effect.gen(function* () {
          const service = yield* stepsTag;
          return yield* EffectGrpcServer.GrpcServerBuilder()
            .withContextTransformer((handlerCtx, current) => {
              const before = handlerCtx.values.get(visits);
              handlerCtx.values.set(visits, before + 1);
              return Effect.succeed([
                `first saw ${handlerCtx.method.name}`,
                `its current context is the HandlerContext: ${current === handlerCtx}`,
                `visits before it: ${before}`,
              ]);
            })
            .withContextTransformer((handlerCtx, steps) =>
              Effect.succeed([...steps, `second saw ${handlerCtx.protocolName}`]),
            )
            .withService(service)
            .build()
            .listen({ host: "127.0.0.1", port: 0 });
        }).pipe(Effect.provide(effectProto.helloWorldAPIServiceLiveLayer(stepsTag, echoSteps)));

        const first = yield* greet(address, "Ada");
        const second = yield* greet(address, "Bob");

        const steps =
          "first saw GetGreeting; its current context is the HandlerContext: true; visits before it: 0; second saw grpc";
        expect([first.greeting, second.greeting]).toEqual([steps, steps]);
      }),
  );
});
