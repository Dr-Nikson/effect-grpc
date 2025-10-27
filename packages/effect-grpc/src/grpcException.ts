// packages/effect-grpc/src/grpcException.ts
import { Data } from "effect";

import type { Code, ConnectError } from "@connectrpc/connect";

import * as internal from "./grpcException.internal.js";

/**
 * A high-level error type for gRPC operations in Effect programs.
 *
 * GrpcException is a tagged error that extends Data.TaggedError, designed as part of the DSL
 * for gRPC error handling. It focuses on application-level concerns (code, message, description, cause)
 * rather than low-level wire-format details.
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
 *   yield* Effect.fail(notFoundError);
 * }).pipe(
 *   Effect.catchTag(GrpcException, (error) => {
 *     console.log(`gRPC error [${Code[error.code]}]: ${error.message}`);
 *     return Effect.succeed("recovered");
 *   })
 * );
 *
 * // Convert from unknown error
 * try {
 *   // some operation
 * } catch (error) {
 *   yield* GrpcException.from(Code.Internal, error);
 * }
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
 * - If the cause is a ConnectError, wraps it preserving code and message
 * - For other Errors, creates a GrpcException with the error message and sets it as cause
 * - For other values, converts to string and uses as message
 *
 * @param code - The gRPC status code to use (required)
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
  (code: Code, cause: unknown): GrpcException;
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
 * Converts a GrpcException to a ConnectError for use with Connect-RPC.
 * This is useful when you need to throw or return errors in Connect-RPC handlers.
 *
 * Only the code, message, and cause are preserved. Description is not included
 * as ConnectError doesn't have a corresponding field.
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
