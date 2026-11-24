// packages/effect-grpc/src/grpcException.test-d.ts
import type { Option, Schema } from "effect";
import { expectTypeOf, test } from "vitest";

import { Code } from "@connectrpc/connect";

import * as GrpcException from "./grpcException.js";

declare const error: GrpcException.GrpcException;
declare const decoded: { readonly userId: string; readonly tags: ReadonlyArray<string> };

test("the data of a GrpcException is an Option of JSON", () => {
  expectTypeOf(error.data).toEqualTypeOf<Option.Option<Schema.Json>>();
});

test("withData takes readonly JSON, such as a Schema-decoded value, in both forms", () => {
  expectTypeOf(GrpcException.withData(error, decoded)).toEqualTypeOf<GrpcException.GrpcException>();
  expectTypeOf(
    GrpcException.create(Code.NotFound, "m").pipe(GrpcException.withData(decoded)),
  ).toEqualTypeOf<GrpcException.GrpcException>();
});

test("withData refuses values that are not JSON", () => {
  // @ts-expect-error undefined is not JSON
  GrpcException.withData(error, undefined);
  // @ts-expect-error a function is not JSON
  GrpcException.withData(error, () => 1);
  // @ts-expect-error a bigint is not JSON
  GrpcException.withData(error, 1n);
});
