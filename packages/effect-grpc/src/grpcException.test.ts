// packages/effect-grpc/src/grpcException.test.ts
import { Effect, Option } from "effect";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { create, toJson } from "@bufbuild/protobuf";
import { EmptySchema, ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";

import * as GrpcException from "./grpcException.js";

const data = { userId: "u-1", reasons: ["missing", "Grüße ✓"], attempts: 3, appeal: null };

describe("GrpcException.create", () => {
  it("makes a tagged Error with the code and message, and no data, description or cause", () => {
    const error = GrpcException.create(Code.NotFound, "User not found");

    expect(error).toBeInstanceOf(GrpcException.GrpcException);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      _tag: "@dr_nikson/effect-grpc/grpcException/GrpcException",
      code: Code.NotFound,
      message: "User not found",
    });
    expect(error.data).toEqual(Option.none());
    expect(error.description).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it("keeps the cause it is given", () => {
    const cause = new Error("disk full");

    expect(GrpcException.create(Code.Internal, "Operation failed", cause).cause).toBe(cause);
  });
});

describe("new GrpcException", () => {
  it("defaults the data to none when the fields leave it out, and keeps data that they give", () => {
    const without = new GrpcException.GrpcException({ code: Code.NotFound, message: "m" });
    const withData = new GrpcException.GrpcException({
      code: Code.NotFound,
      message: "m",
      data: Option.some(data),
    });

    expect(without.data).toEqual(Option.none());
    expect(withData.data).toEqual(Option.some(data));
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

  it("keeps the data", () => {
    const withData = GrpcException.withData(GrpcException.create(Code.NotFound, "m"), data);

    expect(GrpcException.withDescription(withData, "d").data).toEqual(Option.some(data));
  });
});

describe("GrpcException.withData", () => {
  it("returns a new exception with the data and the same code, message, description and cause", () => {
    const cause = new Error("connection reset");
    const original = GrpcException.withDescription(
      GrpcException.create(Code.FailedPrecondition, "Account is locked", cause),
      "Checked before the transfer",
    );

    const withData = GrpcException.withData(original, data);

    expect(withData).not.toBe(original);
    expect(withData).toMatchObject({
      code: Code.FailedPrecondition,
      message: "Account is locked",
      description: "Checked before the transfer",
    });
    expect(withData.data).toEqual(Option.some(data));
    expect(withData.cause).toBe(cause);
    expect(original.data).toEqual(Option.none());
  });

  it("works in a pipe, and replaces earlier data", () => {
    const error = GrpcException.create(Code.NotFound, "m").pipe(
      GrpcException.withData("first"),
      GrpcException.withData(null),
    );

    expect(error.data).toEqual(Option.some(null));
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
    expect(back.data).toEqual(Option.none());
  });

  it.each([
    ["an object with non-ASCII text", data],
    ["an array", [1, "two", false]],
    ["a string", "Grüße ✓"],
    ["a number", 42.5],
    ["null", null],
  ])("sends %s as one google.protobuf.Value detail, which from reads back", (_, json) => {
    const connectError = GrpcException.toConnectError(
      GrpcException.withData(GrpcException.create(Code.FailedPrecondition, "m"), json),
    );

    expect(connectError.details).toHaveLength(1);
    expect(
      connectError.findDetails(ValueSchema).map((value) => toJson(ValueSchema, value)),
    ).toEqual([json]);
    expect(GrpcException.from(Code.Unknown, connectError).data).toEqual(Option.some(json));
  });

  it("sends what JSON.stringify writes, so NaN and Infinity arrive as null", () => {
    const connectError = GrpcException.toConnectError(
      GrpcException.withData(GrpcException.create(Code.FailedPrecondition, "m"), {
        score: NaN,
        limit: Infinity,
        kept: 1,
      }),
    );

    expect(GrpcException.from(Code.Unknown, connectError).data).toEqual(
      Option.some({ score: null, limit: null, kept: 1 }),
    );
  });

  it("sends no detail, and keeps the code and the message, for data that JSON.stringify refuses", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    const connectError = GrpcException.toConnectError(
      GrpcException.withData(GrpcException.create(Code.FailedPrecondition, "m"), cyclic as never),
    );

    expect(connectError.code).toBe(Code.FailedPrecondition);
    expect(connectError.rawMessage).toBe("m");
    expect(connectError.details).toEqual([]);
  });
});

describe("GrpcException.from, reading the data of a ConnectError", () => {
  it("reads the first google.protobuf.Value detail as the data", () => {
    const connectError = new ConnectError("m", Code.Aborted, undefined, [
      { desc: EmptySchema, value: {} },
      { desc: ValueSchema, value: { kind: { case: "stringValue", value: "first" } } },
      { desc: ValueSchema, value: { kind: { case: "stringValue", value: "second" } } },
    ]);

    expect(GrpcException.from(Code.Unknown, connectError).data).toEqual(Option.some("first"));
  });

  it.each([
    ["no details", []],
    ["a detail of another type", [{ desc: EmptySchema, value: {} }]],
    [
      "a Value that JSON cannot hold",
      [
        {
          desc: ValueSchema,
          value: create(ValueSchema, { kind: { case: "numberValue", value: NaN } }),
        },
      ],
    ],
    ["a Value with no kind", [{ desc: ValueSchema, value: {} }]],
  ])("gives no data, and keeps the code and the message, for %s", (_, details) => {
    const error = GrpcException.from(
      Code.Unknown,
      new ConnectError("Account is locked", Code.FailedPrecondition, undefined, details),
    );

    expect(error).toMatchObject({ code: Code.FailedPrecondition, message: "Account is locked" });
    expect(error.data).toEqual(Option.none());
  });

  it("gives no data for a Value detail from the wire whose bytes do not decode", () => {
    const connectError = new ConnectError("m", Code.FailedPrecondition);
    connectError.details.push({
      type: "google.protobuf.Value",
      value: new Uint8Array([0xff, 0xff]),
    });

    expect(GrpcException.from(Code.Unknown, connectError).data).toEqual(Option.none());
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
