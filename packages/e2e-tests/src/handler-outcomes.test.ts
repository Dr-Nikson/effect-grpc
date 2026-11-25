// packages/e2e-tests/src/handler-outcomes.test.ts
import { Cause, Deferred, Effect, Fiber, Option } from "effect";
import type { Schema } from "effect";

import type { HandlerContext } from "@connectrpc/connect";
import { Code } from "@connectrpc/connect";
import { EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as raw from "./raw-unary.js";
import { clientLayer, effectProto, greet, serverFor } from "./test-fixtures.js";

interface Sent {
  readonly code: Code;
  readonly message: string;
  readonly data: Option.Option<Schema.Json>;
}

interface Outcome {
  readonly outcome: string;
  readonly handler: effectProto.HelloWorldAPIService["getGreeting"];
  readonly contextTransformer: Option.Option<
    (handlerCtx: HandlerContext) => Effect.Effect<unknown, GrpcException.GrpcException>
  >;
  readonly sends: Sent;
}

const greeter: effectProto.HelloWorldAPIService = {
  getGreeting: ({ name }) => Effect.succeed({ greeting: `Hello, ${name}!` }),
  faceTheError: () => Effect.fail(GrpcException.create(Code.FailedPrecondition, "not called")),
};

const secret = new Error("the database password is hunter2");
const finalizerDies = Effect.die(new Error("the finalizer died"));
const failure = (code: Code, message: string, data: Schema.Json) =>
  GrpcException.create(code, message).pipe(GrpcException.withData(data));
const internalError: Sent = {
  code: Code.Internal,
  message: "Internal server error",
  data: Option.none(),
};

const outcomes: ReadonlyArray<Outcome> = [
  {
    outcome: "fails with a GrpcException, and a finalizer dies",
    handler: () =>
      Effect.fail(failure(Code.NotFound, "no greeting for Ada", { name: "Ada" })).pipe(
        Effect.ensuring(finalizerDies),
      ),
    contextTransformer: Option.none(),
    sends: {
      code: Code.NotFound,
      message: "no greeting for Ada",
      data: Option.some({ name: "Ada" }),
    },
  },
  {
    outcome: "fails with two GrpcExceptions in one cause",
    handler: () =>
      Effect.failCause(
        Cause.combine(
          Cause.fail(failure(Code.NotFound, "first", "first data")),
          Cause.fail(failure(Code.AlreadyExists, "second", "second data")),
        ),
      ),
    contextTransformer: Option.none(),
    sends: { code: Code.NotFound, message: "first", data: Option.some("first data") },
  },
  {
    outcome: "dies",
    handler: () => Effect.die(secret),
    contextTransformer: Option.none(),
    sends: internalError,
  },
  {
    outcome: "dies, and a finalizer dies",
    handler: () => Effect.die(secret).pipe(Effect.ensuring(finalizerDies)),
    contextTransformer: Option.none(),
    sends: internalError,
  },
  {
    outcome: "dies with a GrpcException, as Effect.orDie makes it",
    handler: () => Effect.orDie(Effect.fail(GrpcException.create(Code.NotFound, "not sent"))),
    contextTransformer: Option.none(),
    sends: internalError,
  },
  {
    outcome: "throws",
    handler: () => {
      throw secret;
    },
    contextTransformer: Option.none(),
    sends: internalError,
  },
  {
    outcome: "interrupts itself",
    handler: () => Effect.interrupt,
    contextTransformer: Option.none(),
    sends: { code: Code.Aborted, message: expect.any(String), data: Option.none() },
  },
  {
    outcome: "fails with an empty cause",
    handler: () => Effect.failCause(Cause.empty),
    contextTransformer: Option.none(),
    sends: { code: Code.Unknown, message: expect.any(String), data: Option.none() },
  },
  {
    outcome: "runs after a context transformer that fails with a GrpcException",
    handler: greeter.getGreeting,
    contextTransformer: Option.some(() =>
      Effect.fail(GrpcException.create(Code.Unauthenticated, "no token")),
    ),
    sends: { code: Code.Unauthenticated, message: "no token", data: Option.none() },
  },
  {
    outcome: "runs after a context transformer that throws",
    handler: greeter.getGreeting,
    contextTransformer: Option.some(() => {
      throw secret;
    }),
    sends: internalError,
  },
];

const serve = (row: Outcome) =>
  Effect.gen(function* () {
    const service = yield* effectProto.HelloWorldAPIServiceTag;
    const builder = Option.match(row.contextTransformer, {
      onNone: () => EffectGrpcServer.GrpcServerBuilder(),
      onSome: (transformer) =>
        EffectGrpcServer.GrpcServerBuilder().withContextTransformer(transformer),
    });
    return yield* builder.withService(service).build().listen({ host: "127.0.0.1", port: 0 });
  }).pipe(
    Effect.provide(
      effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, {
        ...greeter,
        getGreeting: row.handler,
      }),
    ),
  );

describe("what the generated client receives when the handler", () => {
  for (const row of outcomes) {
    it.live(row.outcome, () =>
      Effect.gen(function* () {
        const address = yield* serve(row);

        const error = yield* Effect.flip(greet(address, "Ada"));

        expect({ code: error.code, message: error.message, data: error.data }).toEqual(row.sends);
      }),
    );
  }
});

const signalInterruption = (interrupted: Deferred.Deferred<void>) =>
  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid));

describe("a call whose deadline passes while its handler waits", () => {
  it.live.each([
    { waits: "on its own", wait: Effect.never },
    {
      waits: "in Effect.all, with a finalizer that dies",
      wait: Effect.all([Effect.never, Effect.never], { concurrency: "unbounded" }).pipe(
        Effect.ensuring(finalizerDies),
      ),
    },
  ])(
    "gets DEADLINE_EXCEEDED from the server, which interrupts the handler that waits $waits",
    ({ wait }) =>
      Effect.gen(function* () {
        const interrupted = yield* Deferred.make<void>();
        const server = yield* serverFor({
          ...greeter,
          getGreeting: () => wait.pipe(signalInterruption(interrupted), Effect.as({})),
        });
        const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
        const session = yield* raw.connect(address.url);

        const reply = yield* raw.getGreeting(
          session,
          "grpc",
          new URL(address.url).host,
          "Ada",
          "application/grpc",
          ":authority",
          { "grpc-timeout": "100m" },
        );

        expect({ status: reply.grpcStatus, message: reply.grpcMessage }).toEqual({
          status: String(Code.DeadlineExceeded),
          message: "the operation timed out",
        });
        expect(yield* Deferred.isDone(interrupted), "the handler was interrupted").toBe(true);
      }),
  );
});

describe("a call that its client cancels", () => {
  it.live("interrupts its handler", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const server = yield* serverFor({
        ...greeter,
        getGreeting: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            signalInterruption(interrupted),
          ),
      });
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });

      const handlerInterrupted = yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        const call = yield* Effect.forkChild(client.getGreeting({ name: "Ada" }, {}));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(call);
        return yield* Deferred.await(interrupted).pipe(Effect.timeoutOption("2 seconds"));
      }).pipe(Effect.provide(clientLayer(address)));

      expect(Option.isSome(handlerInterrupted), "the handler was interrupted").toBe(true);
    }),
  );
});
