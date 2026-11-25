// packages/effect-grpc/src/grpcException.internal.ts
import { Array as Arr, Option } from "effect";
import type { Schema } from "effect";
import { dual } from "effect/Function";

import { fromJsonString, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { Value } from "@bufbuild/protobuf/wkt";
import { ConnectError } from "@connectrpc/connect";
import type { Code } from "@connectrpc/connect";

import { GrpcException } from "./grpcException.js";

/**
 * Going through JSON text gives every reader what `JSON.stringify` writes: NaN and Infinity arrive
 * as null, where a Value holding them would make the reader's `toJson` throw.
 */
const jsonToValue = Option.liftThrowable(
  (json: Schema.Json): Value => fromJsonString(ValueSchema, JSON.stringify(json)),
);

/**
 * `toJson` throws on a Value it cannot write as JSON, such as NaN, Infinity or an unset kind.
 */
const valueToJson = Option.liftThrowable((value: Value): Schema.Json => toJson(ValueSchema, value));

const dataOf = (error: ConnectError): Option.Option<Schema.Json> =>
  Arr.head(error.findDetails(ValueSchema)).pipe(Option.flatMap(valueToJson));

const detailsOf = (data: Option.Option<Schema.Json>) =>
  Option.flatMap(data, jsonToValue).pipe(
    Option.match({ onNone: () => [], onSome: (value) => [{ desc: ValueSchema, value }] }),
  );

const descriptionOf = (error: GrpcException) =>
  Option.match(Option.fromNullishOr(error.description), {
    onNone: () => ({}),
    onSome: (description) => ({ description }),
  });

/**
 * @internal
 */
export const withDefaultData = <Init extends { readonly data?: Option.Option<Schema.Json> }>(
  init: Init,
) => ({ ...init, data: Option.flatten(Option.fromNullishOr(init.data)) });

/**
 * @internal
 */
export const create = (code: Code, message: string, cause?: unknown): GrpcException => {
  return new GrpcException({ code, message, cause });
};

/**
 * @internal
 */
export const from = (fallbackCode: Code, cause: unknown): GrpcException => {
  if (cause instanceof ConnectError) {
    return new GrpcException({
      code: cause.code,
      message: cause.rawMessage,
      data: dataOf(cause),
      cause,
    });
  }

  // Handle regular Error - use error message and set as cause
  if (cause instanceof Error) {
    return new GrpcException({
      code: fallbackCode,
      message: cause.message,
      cause,
    });
  }

  // For other values, convert to string and use as message
  const message = String(cause);

  return new GrpcException({
    code: fallbackCode,
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
    data: error.data,
    description,
    cause: error.cause,
  });
};

/**
 * @internal
 */
export const withData: {
  (data: Schema.Json): (error: GrpcException) => GrpcException;
  (error: GrpcException, data: Schema.Json): GrpcException;
} = dual(
  2,
  (error: GrpcException, data: Schema.Json): GrpcException =>
    new GrpcException({
      code: error.code,
      message: error.message,
      data: Option.some(data),
      ...descriptionOf(error),
      cause: error.cause,
    }),
);

/**
 * @internal
 */
export const toConnectError = (error: GrpcException): ConnectError => {
  return new ConnectError(error.message, error.code, undefined, detailsOf(error.data), error.cause);
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
