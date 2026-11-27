// packages/effect-grpc/src/typed-tags.test.ts
import { Effect, Layer } from "effect";

import { EffectGrpcClient, EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import { clientConfig, greet, greeter, helloWorld, testServer } from "./testing/harness.js";

interface AuthMeta {
  readonly token: string;
}

interface AuthContext {
  readonly authorization: string;
}

const serviceLayer = effectProto.helloWorldAPIServiceLiveLayer(
  effectProto.HelloWorldAPIServiceTag,
  greeter,
);

describe("generated service and client tags (#55)", () => {
  it("a default tag is a tag, not a factory", () => {
    expectTypeOf(effectProto.HelloWorldAPIServiceTag).not.toBeFunction();
    expectTypeOf(effectProto.HelloWorldAPIClientTag).not.toBeFunction();
  });

  it.live(
    "one Context holds the default service and the default client, each under its own key",
    () =>
      Effect.gen(function* () {
        const service = yield* effectProto.HelloWorldAPIServiceTag;

        yield* Effect.gen(function* () {
          expect(effectProto.HelloWorldAPIClientTag.key).not.toBe(
            effectProto.HelloWorldAPIServiceTag.key,
          );
          expect(yield* effectProto.HelloWorldAPIServiceTag).toBe(service);
          expect((yield* greet("Ada")).greeting).toBe("Hello, Ada!");
        }).pipe(Effect.provide(helloWorld()));
      }).pipe(Effect.provide(serviceLayer)),
  );

  it.live(
    "factory tags resolve to their own values beside the default tags, and a typed client sends its meta",
    () => {
      const AuthServiceTag = effectProto.makeHelloWorldAPIServiceTag<AuthContext>("AuthContext");
      const AuthClientTag = effectProto.makeHelloWorldAPIClientTag<AuthMeta>("AuthMeta");
      const answer = (request: { readonly name: string }, ctx: AuthContext) =>
        Effect.succeed({ greeting: `${request.name} as ${ctx.authorization}` });

      const authServer = testServer(
        Effect.map(AuthServiceTag, (authService) =>
          EffectGrpcServer.GrpcServerBuilder()
            .withContextTransformer((handlerCtx) =>
              Effect.succeed<AuthContext>({
                authorization: handlerCtx.requestHeader.get("authorization") ?? "nobody",
              }),
            )
            .withService(authService)
            .build(),
        ),
      );

      const clients = Layer.mergeAll(
        effectProto.helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag),
        effectProto.helloWorldAPIClientLiveLayer(
          (meta: AuthMeta) => ({
            headers: new Headers({ authorization: `Bearer ${meta.token}` }),
          }),
          AuthClientTag,
        ),
      ).pipe(
        Layer.provide([
          clientConfig(effectProto.HelloWorldAPIConfigTag),
          EffectGrpcClient.liveGrpcClientRuntimeLayer(),
        ]),
        Layer.provide(authServer),
      );

      return Effect.gen(function* () {
        const authService = yield* AuthServiceTag;

        yield* Effect.gen(function* () {
          const keys = [
            effectProto.HelloWorldAPIServiceTag.key,
            AuthServiceTag.key,
            effectProto.HelloWorldAPIClientTag.key,
            AuthClientTag.key,
          ];
          expect(new Set(keys).size).toBe(keys.length);
          expect(yield* AuthServiceTag).toBe(authService);
          expect(yield* effectProto.HelloWorldAPIServiceTag).not.toBe(authService);

          const typed = yield* (yield* AuthClientTag).getGreeting(
            { name: "Ada" },
            { token: "t0k" },
          );
          const plain = yield* (yield* effectProto.HelloWorldAPIClientTag).getGreeting(
            { name: "Ada" },
            {},
          );
          expect(typed.greeting).toBe("Ada as Bearer t0k");
          expect(plain.greeting).toBe("Ada as nobody");
        }).pipe(Effect.provide(clients));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            serviceLayer,
            effectProto.helloWorldAPIServiceLiveLayer(AuthServiceTag, {
              getGreeting: answer,
              faceTheError: answer,
            }),
          ),
        ),
      );
    },
  );
});
