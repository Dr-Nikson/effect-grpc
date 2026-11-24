// packages/e2e-tests/src/typed-tags.test.ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { EffectGrpcClient, EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";

import { clientLayer, effectProto, serverServiceLayer } from "./test-fixtures.js";

interface AuthMeta {
  readonly token: string;
}

interface AuthContext {
  readonly authorization: string;
}

const configLayer = (address: EffectGrpcServer.GrpcServerAddress) =>
  Layer.succeed(
    effectProto.HelloWorldAPIConfigTag,
    EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL(address.url) }),
  );

describe("generated service and client tags (#55)", () => {
  it("a default tag is a tag, not a factory", () => {
    expectTypeOf(effectProto.HelloWorldAPIServiceTag).not.toBeFunction();
    expectTypeOf(effectProto.HelloWorldAPIClientTag).not.toBeFunction();
  });

  it.scopedLive(
    "one Context holds the default service and the default client, each under its own key",
    () =>
      Effect.gen(function* () {
        const service = yield* effectProto.HelloWorldAPIServiceTag;
        const address = yield* EffectGrpcServer.GrpcServerBuilder()
          .withService(service)
          .build()
          .listen({ host: "127.0.0.1", port: 0 });

        yield* Effect.gen(function* () {
          expect(effectProto.HelloWorldAPIClientTag.key).not.toBe(
            effectProto.HelloWorldAPIServiceTag.key,
          );
          expect(yield* effectProto.HelloWorldAPIServiceTag).toBe(service);

          const client = yield* effectProto.HelloWorldAPIClientTag;
          const response = yield* client.getGreeting({ name: "Ada" }, {});
          expect(response.greeting).toBe("Hello, Ada! This is an E2E test.");
        }).pipe(Effect.provide(clientLayer(address)), Effect.scoped);
      }).pipe(Effect.provide(serverServiceLayer)),
  );

  it.scopedLive(
    "factory tags resolve to their own values beside the default tags, and a typed client sends its meta",
    () => {
      const AuthServiceTag = effectProto.makeHelloWorldAPIServiceTag<AuthContext>("AuthContext");
      const AuthClientTag = effectProto.makeHelloWorldAPIClientTag<AuthMeta>("AuthMeta");
      const answer = (request: { readonly name: string }, ctx: AuthContext) =>
        Effect.succeed({ greeting: `${request.name} as ${ctx.authorization}` });

      return Effect.gen(function* () {
        const authService = yield* AuthServiceTag;
        const address = yield* EffectGrpcServer.GrpcServerBuilder()
          .withContextTransformer((handlerCtx) =>
            Effect.succeed<AuthContext>({
              authorization: handlerCtx.requestHeader.get("authorization") ?? "nobody",
            }),
          )
          .withService(authService)
          .build()
          .listen({ host: "127.0.0.1", port: 0 });

        const clients = Layer.mergeAll(
          effectProto.helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag),
          effectProto.helloWorldAPIClientLiveLayer(
            (meta: AuthMeta) => ({
              headers: new Headers({ authorization: `Bearer ${meta.token}` }),
            }),
            AuthClientTag,
          ),
        ).pipe(
          Layer.provide(configLayer(address)),
          Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
        );

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
        }).pipe(Effect.provide(clients), Effect.scoped);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            serverServiceLayer,
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
