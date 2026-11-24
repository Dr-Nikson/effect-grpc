// packages/effect-grpc/src/grpcException.ts
import { Data } from "effect";
import type { Option, Schema } from "effect";

import type { Code, ConnectError } from "@connectrpc/connect";

import * as internal from "./grpcException.internal.js";

/**
 * A high-level error type for gRPC operations in Effect programs.
 *
 * GrpcException is a tagged error that extends Data.TaggedError, designed as part of the DSL
 * for gRPC error handling. It focuses on application-level concerns (code, message, data,
 * description, cause) rather than low-level wire-format details.
 *
 * A handler fails with it, and the server sends its code, its message and its data. A generated
 * client method fails with it for every failed call: a status the server sent, a transport failure
 * such as a closed port, and a passed deadline.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import { GrpcException } from "@dr_nikson/effect-grpc";
 * import { Code } from "@connectrpc/connect";
 *
 * // Create an exception with a code and message
 * const notFoundError = GrpcException.create(
 *   Code.NotFound,
 *   "User not found"
 * );
 *
 * // Use in Effect programs with catchTag
 * const program = Effect.gen(function* () {
 *   yield* notFoundError; // The error is yieldable
 * }).pipe(
 *   Effect.catchTag("@dr_nikson/effect-grpc/grpcException/GrpcException", (error) =>
 *     Effect.succeed(`recovered from ${Code[error.code]}: ${error.message}`)
 *   )
 * );
 *
 * // Attach JSON data, which the client of the call receives
 * const withData = GrpcException.withData(notFoundError, { userId: "u-1" });
 *
 * // Convert from unknown error
 * const fromUnknown = (error: unknown) => GrpcException.from(Code.Internal, error);
 *
 * // Add context with description
 * const enriched = GrpcException.withDescription(
 *   notFoundError,
 *   "Database query failed"
 * );
 * ```
 *
 * @category Error Handling
 * @since 0.2.0
 */
export class GrpcException extends Data.TaggedError(
  "@dr_nikson/effect-grpc/grpcException/GrpcException",
)<{
  /**
   * The gRPC status code for this error.
   */
  readonly code: Code;

  /**
   * The error message describing what went wrong.
   */
  readonly message: string;

  /**
   * JSON data that travels with the status, or `Option.none()` when there is none.
   *
   * A handler sets it with `withData`. The server sends it as one `google.protobuf.Value` in the
   * status details, over gRPC, gRPC-web and Connect, and the client of the call reads it here.
   */
  readonly data: Option.Option<Schema.Json>;

  /**
   * Optional description providing additional context about the error.
   * This can be used to add higher-level context without modifying the original message.
   *
   * Unlike the message field, description can be easily modified as errors bubble up
   * through the call stack using withDescription.
   */
  readonly description?: string;

  /**
   * Optional cause of this error.
   * Used to chain errors and preserve the original error that caused this exception.
   * Can be a native Error, Effect tagged error.
   */
  readonly cause?: unknown;
}> {
  /**
   * Takes the fields of the exception. `data` is optional, and an exception made without it has
   * `Option.none()`.
   */
  constructor(init: {
    readonly code: Code;
    readonly message: string;
    readonly data?: Option.Option<Schema.Json>;
    readonly description?: string;
    readonly cause?: unknown;
  }) {
    super(internal.withDefaultData(init));
  }

  /**
   * Returns a formatted error message including the status code, message, and description (if present).
   * This is called automatically when the error is converted to a string.
   *
   * Format:
   * - Without description: "[code] message"
   * - With description: "[code] message (description)"
   *
   * @example
   * ```typescript
   * import { GrpcException } from "@dr_nikson/effect-grpc";
   * import { Code } from "@connectrpc/connect";
   *
   * const error1 = GrpcException.create(
   *   Code.NotFound,
   *   "User not found"
   * );
   * console.log(error1.toString());
   * // Output: "[not_found] User not found"
   *
   * const error2 = GrpcException.withDescription(
   *   error1,
   *   "Database query failed"
   * );
   * console.log(error2.toString());
   * // Output: "[not_found] User not found (Database query failed)"
   * ```
   */
  toString(): string {
    return internal.toString(this);
  }

  /**
   * Custom inspection for Node.js util.inspect
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return internal.inspect(this);
  }
}

/**
 * Creates a new GrpcException from the provided parameters.
 *
 * This is the primary constructor for creating GrpcException instances.
 * Code and message are required; cause is optional.
 *
 * @param code - The gRPC status code (required)
 * @param message - The error message (required)
 * @param cause - Optional cause of the error
 * @returns A new GrpcException instance
 *
 * @example
 * ```typescript
 * import { GrpcException } from "@dr_nikson/effect-grpc";
 * import { Code } from "@connectrpc/connect";
 *
 * // Simple error
 * const error1 = GrpcException.create(
 *   Code.NotFound,
 *   "User not found"
 * );
 *
 * // With cause
 * try {
 *   // some operation
 * } catch (err) {
 *   const error2 = GrpcException.create(
 *     Code.Internal,
 *     "Operation failed",
 *     err
 *   );
 * }
 * ```
 */
export const create: {
  (code: Code, message: string, cause?: unknown): GrpcException;
} = internal.create;

/**
 * Converts any value into a GrpcException, following these rules:
 * - If the cause is a ConnectError, wraps it preserving code and message, and reads the data from
 *   the first `google.protobuf.Value` detail that decodes. With no such detail there is no data.
 * - For other Errors, creates a GrpcException with the error message and sets it as cause
 * - For other values, converts to string and uses as message
 *
 * @param fallbackCode - The gRPC status code for a cause that is not a ConnectError (required)
 * @param cause - The error/value to convert (native Error, ConnectError, or any value)
 * @returns A GrpcException instance
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import { GrpcException } from "@dr_nikson/effect-grpc";
 * import { Code, ConnectError } from "@connectrpc/connect";
 *
 * const handleError = (error: unknown) =>
 *   Effect.fail(GrpcException.from(Code.Internal, error));
 *
 * // From ConnectError - preserves code and message
 * const connectErr = new ConnectError("Not found", Code.NotFound);
 * const grpcErr1 = GrpcException.from(Code.Internal, connectErr);
 * // grpcErr1.code === Code.NotFound (from ConnectError, not the parameter)
 * // grpcErr1.message === "Not found"
 *
 * // From regular Error - sets as cause
 * const regularErr = new Error("Network timeout");
 * const grpcErr2 = GrpcException.from(Code.Unavailable, regularErr);
 * // grpcErr2.code === Code.Unavailable
 * // grpcErr2.message === "Network timeout"
 * // grpcErr2.cause === regularErr
 * ```
 */
export const from: {
  (fallbackCode: Code, cause: unknown): GrpcException;
} = internal.from;

/**
 * Sets or replaces the description field of a GrpcException.
 * Returns a new GrpcException with the specified description.
 *
 * @param error - The GrpcException to modify
 * @param description - The description to set
 * @returns A new GrpcException with the description
 *
 * @example
 * ```typescript
 * import { GrpcException } from "@dr_nikson/effect-grpc";
 * import { Code } from "@connectrpc/connect";
 *
 * const error = GrpcException.create(
 *   Code.NotFound,
 *   "User not found"
 * );
 * const enriched = GrpcException.withDescription(
 *   error,
 *   "Database query failed"
 * );
 * // enriched.description === "Database query failed"
 * ```
 */
export const withDescription: {
  (error: GrpcException, description: string): GrpcException;
} = internal.withDescription;

/**
 * Sets or replaces the data of a GrpcException. The data is any JSON value, and it travels to the
 * client of the call. Returns a new GrpcException with the same code, message, description and
 * cause.
 *
 * The server sends the data as one `google.protobuf.Value` in the status details: in the
 * `grpc-status-details-bin` trailer over gRPC and gRPC-web, and in the error body over Connect.
 * Over gRPC the trailer counts against HTTP/2's header limits, so keep the data small. The data
 * goes out as `JSON.stringify` writes it, so `NaN` becomes `null`. Data that `JSON.stringify`
 * refuses, such as a cycle, and objects nested about 100 levels deep are not sent.
 *
 * @param error - The GrpcException to modify
 * @param data - The JSON data to send
 * @returns A new GrpcException with the data
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import { GrpcException } from "@dr_nikson/effect-grpc";
 * import { Code } from "@connectrpc/connect";
 *
 * const failure = Effect.fail(
 *   GrpcException.create(Code.FailedPrecondition, "Account is locked").pipe(
 *     GrpcException.withData({ accountId: "a-1", unlocksAt: "2026-12-01" })
 *   )
 * );
 * ```
 *
 * @category Error Handling
 * @since 4.0.0
 */
export const withData: {
  (data: Schema.Json): (error: GrpcException) => GrpcException;
  (error: GrpcException, data: Schema.Json): GrpcException;
} = internal.withData;

/**
 * Converts a GrpcException to a ConnectError for use with Connect-RPC.
 * This is useful when you need to throw or return errors in Connect-RPC handlers.
 *
 * The code, the message and the cause are preserved, and the data becomes one
 * `google.protobuf.Value` detail, except data that `withData` says is not sent. Description is not
 * included as ConnectError doesn't have a corresponding field.
 *
 * @param error - The GrpcException to convert
 * @returns A ConnectError instance
 *
 * @example
 * ```typescript
 * import { GrpcException } from "@dr_nikson/effect-grpc";
 * import { Code } from "@connectrpc/connect";
 *
 * const error = GrpcException.create(
 *   Code.NotFound,
 *   "User not found"
 * );
 * const withDesc = GrpcException.withDescription(
 *   error,
 *   "Database query failed"
 * );
 *
 * const connectError = GrpcException.toConnectError(withDesc);
 * // connectError.code === Code.NotFound
 * // connectError.rawMessage === "User not found"
 * // Note: description is lost in conversion
 *
 * // Can be thrown in Connect-RPC handlers
 * throw GrpcException.toConnectError(error);
 * ```
 */
export const toConnectError: {
  (error: GrpcException): ConnectError;
} = internal.toConnectError;
