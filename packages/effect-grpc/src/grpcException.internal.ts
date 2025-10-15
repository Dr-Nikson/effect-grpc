// packages/effect-grpc/src/grpcException.internal.ts
import { ConnectError } from "@connectrpc/connect";
import type { Code } from "@connectrpc/connect";

import { GrpcException } from "./grpcException.js";

/**
 * @internal
 */
export const create = (code: Code, message: string, cause?: unknown): GrpcException => {
  return new GrpcException({ code, message, cause });
};

/**
 * @internal
 */
export const from = (code: Code, cause: unknown): GrpcException => {
  // Handle ConnectError - preserve code and message
  if (cause instanceof ConnectError) {
    return new GrpcException({
      code: cause.code,
      message: cause.rawMessage,
      cause,
    });
  }

  // Handle regular Error - use error message and set as cause
  if (cause instanceof Error) {
    return new GrpcException({
      code,
      message: cause.message,
      cause,
    });
  }

  // For other values, convert to string and use as message
  const message = String(cause);

  return new GrpcException({
    code,
    message,
    cause,
  });
};

/**
 * @internal
 */
export const withDescription = (error: GrpcException, description: string): GrpcException => {
  return new GrpcException({
    code: error.code,
    message: error.message,
    description,
    cause: error.cause,
  });
};

/**
 * @internal
 */
export const toConnectError = (error: GrpcException): ConnectError => {
  return new ConnectError(error.message, error.code, undefined, undefined, error.cause);
};

/**
 * @internal
 */
export const toString = (error: GrpcException): string => {
  const codeStr = error.code;
  const parts = [`[${codeStr}]`, error.message];
  if (error.description) {
    parts.push(`(${error.description})`);
  }
  return parts.join(" ");
};

/**
 * @internal
 */
export const inspect = (error: GrpcException): string => {
  return toString(error);
};
