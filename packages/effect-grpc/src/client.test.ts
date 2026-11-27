// packages/effect-grpc/src/client.test.ts
import { Cause, Effect, Option } from "effect";

import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "@effect/vitest";

import { HelloWorldAPIClientTag } from "./generated/com/example/v1/hello_world_api_effect.js";
import { greet, helloWorld } from "./testing/harness.js";

const faceTheError = (name: string) =>
  Effect.flatMap(HelloWorldAPIClientTag, (client) => client.faceTheError({ name }, {}));

describe("generated client calls", () => {
  it.live("answers a unary getGreeting call with the greeting for the name", () =>
    Effect.gen(function* () {
      expect((yield* greet("TestUser")).greeting).toBe("Hello, TestUser!");
    }).pipe(Effect.provide(helloWorld())),
  );

  it.live("dies with the code and message of the GrpcException that the handler failed with", () =>
    Effect.gen(function* () {
      const refusal = yield* faceTheError("TestUser").pipe(
        Effect.sandbox,
        Effect.flip,
        Effect.map((cause) => Option.map(Cause.dieOption(cause), ConnectError.from)),
      );

      expect(Option.map(refusal, ({ code, rawMessage }) => ({ code, rawMessage }))).toEqual(
        Option.some({
          code: Code.FailedPrecondition,
          rawMessage: "Sorry TestUser, you must face the consequences!",
        }),
      );
    }).pipe(Effect.provide(helloWorld())),
  );
});
