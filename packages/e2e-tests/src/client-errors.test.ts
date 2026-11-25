// packages/e2e-tests/src/client-errors.test.ts
import { Cause, Effect, Exit, Fiber, Layer, Option, Ref } from "effect";

import { Code, createClient } from "@connectrpc/connect";
import { EffectGrpcClient, EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import { HelloWorldAPI } from "./generated/com/example/v1/hello_world_api_pb.js";
import { overEachProtocol } from "./test-fixtures.js";

const consequences = (name: string) => ({
  name,
  reasons: ["late", "Grüße ✓"],
  attempts: 3,
  appeal: null,
});

const service: effectProto.HelloWorldAPIService = {
  getGreeting: (request) =>
    Effect.sleep("1 second").pipe(Effect.as({ greeting: `Hello, ${request.name}!` })),
  faceTheError: (request) =>
    Effect.fail(
      GrpcException.create(Code.FailedPrecondition, `Sorry ${request.name}, no greeting`).pipe(
        GrpcException.withData(consequences(request.name)),
      ),
    ),
};

const serve = Effect.gen(function* () {
  const grpcService = yield* effectProto.HelloWorldAPIServiceTag;
  const server = EffectGrpcServer.GrpcServerBuilder().withService(grpcService).build();
  return yield* server.listen({ host: "127.0.0.1", port: 0 });
}).pipe(
  Effect.provide(
    effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, service),
  ),
);

const clientAt = (url: string, defaultTimeoutMs = 0) =>
  effectProto.helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag).pipe(
    Layer.provide(
      Layer.succeed(
        effectProto.HelloWorldAPIConfigTag,
        EffectGrpcClient.GrpcClientConfig({
          baseUrl: new URL(url),
          ...(defaultTimeoutMs > 0 && { defaultTimeoutMs }),
        }),
      ),
    ),
    Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
  );

const faceTheError = Effect.flatMap(effectProto.HelloWorldAPIClientTag, (client) =>
  client.faceTheError({ name: "Ada" }, {}),
);
const getGreeting = Effect.flatMap(effectProto.HelloWorldAPIClientTag, (client) =>
  client.getGreeting({ name: "Ada" }, {}),
);

describe("a failed call of the generated client", () => {
  it.live("fails with the handler's GrpcException: its code, its message and its data", () =>
    Effect.gen(function* () {
      const address = yield* serve;

      const error = yield* Effect.flip(faceTheError).pipe(Effect.provide(clientAt(address.url)));

      expect(error).toBeInstanceOf(GrpcException.GrpcException);
      expect(error.code).toBe(Code.FailedPrecondition);
      expect(error.message).toBe("Sorry Ada, no greeting");
      expect(Option.getOrThrow(error.data)).toEqual(consequences("Ada"));
    }),
  );

  it.live("fails with Unavailable when nothing listens on the port", () =>
    Effect.gen(function* () {
      const closed = yield* Effect.scoped(serve);

      const error = yield* Effect.flip(getGreeting).pipe(Effect.provide(clientAt(closed.url)));

      expect(error).toBeInstanceOf(GrpcException.GrpcException);
      expect(error.code).toBe(Code.Unavailable);
      expect(error.data).toEqual(Option.none());
    }),
  );

  it.live("fails with DeadlineExceeded when the deadline passes first", () =>
    Effect.gen(function* () {
      const address = yield* serve;

      const error = yield* Effect.flip(getGreeting).pipe(
        Effect.provide(clientAt(address.url, 200)),
      );

      expect(error).toBeInstanceOf(GrpcException.GrpcException);
      expect(error.code).toBe(Code.DeadlineExceeded);
    }),
  );

  it.live("ends interrupted, not failed, when its fiber is interrupted", () =>
    Effect.gen(function* () {
      const address = yield* serve;

      const exit = yield* Effect.gen(function* () {
        const call = yield* Effect.forkChild(getGreeting);
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(call);
        return yield* Fiber.await(call);
      }).pipe(Effect.provide(clientAt(address.url)));

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  it.live("reaches Effect.retry, which calls again until its schedule ends", () =>
    Effect.gen(function* () {
      const closed = yield* Effect.scoped(serve);
      const attempts = yield* Ref.make(0);

      const error = yield* Ref.update(attempts, (n) => n + 1).pipe(
        Effect.andThen(getGreeting),
        Effect.retry({ times: 2, while: (failure) => failure.code === Code.Unavailable }),
        Effect.flip,
        Effect.provide(clientAt(closed.url)),
      );

      expect(error.code).toBe(Code.Unavailable);
      expect(yield* Ref.get(attempts)).toBe(3);
    }),
  );
});

describe("the data of a handler's failure", () => {
  it.live(
    "reaches Connect's gRPC, gRPC-web and Connect clients, read with GrpcException.from",
    () =>
      Effect.gen(function* () {
        const address = yield* serve;

        const failures = yield* overEachProtocol(address.url, (transport) =>
          Effect.tryPromise({
            try: () => createClient(HelloWorldAPI, transport).faceTheError({ name: "Ada" }),
            catch: (error) => GrpcException.from(Code.Unknown, error),
          }).pipe(
            Effect.flip,
            Effect.map((error) => ({
              code: error.code,
              message: error.message,
              data: Option.getOrThrow(error.data),
            })),
            Effect.orDie,
          ),
        );

        const expected = {
          code: Code.FailedPrecondition,
          message: "Sorry Ada, no greeting",
          data: consequences("Ada"),
        };
        expect(failures).toEqual({ grpc: expected, grpcWeb: expected, connect: expected });
      }),
  );
});
