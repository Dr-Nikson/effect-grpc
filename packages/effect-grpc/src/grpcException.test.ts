// packages/effect-grpc/src/grpcException.test.ts
import { Effect } from "effect";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { Code, ConnectError } from "@connectrpc/connect";

import * as GrpcException from "./grpcException.js";

describe("GrpcException.create", () => {
  it("makes a tagged Error with the code and message, and no description or cause", () => {
    const error = GrpcException.create(Code.NotFound, "User not found");

    expect(error).toBeInstanceOf(GrpcException.GrpcException);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      _tag: "@dr_nikson/effect-grpc/grpcException/GrpcException",
      code: Code.NotFound,
      message: "User not found",
    });
    expect(error.description).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it("keeps the cause it is given", () => {
    const cause = new Error("disk full");

    expect(GrpcException.create(Code.Internal, "Operation failed", cause).cause).toBe(cause);
  });
});

describe("GrpcException.from", () => {
  it("keeps a ConnectError's code and message over the code it is given, with the ConnectError as the cause", () => {
    const connectError = new ConnectError("Not found", Code.NotFound);

    const error = GrpcException.from(Code.Internal, connectError);

    expect(error).toMatchObject({ code: Code.NotFound, message: "Not found" });
    expect(error.cause).toBe(connectError);
  });

  it("takes the code it is given and an Error's message, with the Error as the cause", () => {
    const cause = new Error("Network timeout");

    const error = GrpcException.from(Code.Unavailable, cause);

    expect(error).toMatchObject({ code: Code.Unavailable, message: "Network timeout" });
    expect(error.cause).toBe(cause);
  });

  it.each([
    ["a string", "boom", "boom"],
    ["a number", 42, "42"],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a plain object", { reason: "quota" }, "[object Object]"],
  ])("makes the message from String() of %s, with the value as the cause", (_, value, message) => {
    const error = GrpcException.from(Code.Unknown, value);

    expect(error).toMatchObject({ code: Code.Unknown, message });
    expect(error.cause).toBe(value);
  });
});

describe("GrpcException.withDescription", () => {
  it("returns a new exception with the description and the same code, message and cause", () => {
    const cause = new Error("connection reset");
    const original = GrpcException.create(Code.NotFound, "User not found", cause);

    const described = GrpcException.withDescription(original, "Database query failed");

    expect(described).not.toBe(original);
    expect(described).toMatchObject({
      code: Code.NotFound,
      message: "User not found",
      description: "Database query failed",
    });
    expect(described.cause).toBe(cause);
    expect(original.description).toBeUndefined();
  });

  it("replaces an earlier description", () => {
    const first = GrpcException.withDescription(GrpcException.create(Code.NotFound, "m"), "first");

    expect(GrpcException.withDescription(first, "second").description).toBe("second");
  });
});

describe("GrpcException.toConnectError", () => {
  it("carries the code, the message and the cause, drops the description, and adds no metadata or details", () => {
    const cause = new Error("connection reset");
    const error = GrpcException.withDescription(
      GrpcException.create(Code.NotFound, "User not found", cause),
      "Database query failed",
    );

    const connectError = GrpcException.toConnectError(error);

    expect(connectError).toBeInstanceOf(ConnectError);
    expect(connectError.code).toBe(Code.NotFound);
    expect(connectError.rawMessage).toBe("User not found");
    expect(connectError.cause).toBe(cause);
    expect(connectError).not.toHaveProperty("description");
    expect([...connectError.metadata.keys()]).toEqual([]);
    expect(connectError.details).toEqual([]);
  });

  it("comes back through from with the same code and message", () => {
    const original = GrpcException.create(Code.PermissionDenied, "Not yours");

    const back = GrpcException.from(Code.Unknown, GrpcException.toConnectError(original));

    expect(back).toMatchObject({ code: Code.PermissionDenied, message: "Not yours" });
  });
});

describe("GrpcException as text", () => {
  it("prints the numeric code and the message, then the description in parentheses", () => {
    const error = GrpcException.create(Code.NotFound, "User not found");

    expect(String(error)).toBe("[5] User not found");
    expect(String(GrpcException.withDescription(error, "Database query failed"))).toBe(
      "[5] User not found (Database query failed)",
    );
  });

  it("prints the same text through util.inspect", () => {
    expect(inspect(GrpcException.create(Code.NotFound, "User not found"))).toBe(
      "[5] User not found",
    );
  });
});

describe("GrpcException in an Effect", () => {
  it("fails the Effect with itself when yielded, and Effect.catchTag catches it by its tag", () =>
    Effect.gen(function* () {
      const error = GrpcException.create(Code.FailedPrecondition, "Face the consequences!");

      const failure = yield* Effect.flip(
        Effect.gen(function* () {
          return yield* error;
        }),
      );
      const caughtCode = yield* Effect.fail(error).pipe(
        Effect.catchTag("@dr_nikson/effect-grpc/grpcException/GrpcException", (caught) =>
          Effect.succeed(caught.code),
        ),
      );

      expect(failure).toBe(error);
      expect(caughtCode).toBe(Code.FailedPrecondition);
    }).pipe(Effect.runPromise));
});
