// packages/e2e-tests/src/index.test.ts
import { Cause, Effect, Exit, Layer, LogLevel, Logger, Option } from "effect";

import { describe, expect, it } from "@effect/vitest";

import * as namingTestProto from "./generated/com/example/v1/naming_test_service_effect.js";
import {
  Port,
  PortLive,
  clientLayer,
  createServer,
  effectProto,
  serverServiceLayer,
} from "./test-fixtures.js";

describe("E2E gRPC Client-Server Tests", () => {
  it.scopedLive("should successfully call getGreeting RPC", () =>
    Effect.gen(function* () {
      // Get port from context
      const port = yield* Port;
      yield* Effect.logInfo(`Starting test server on port ${port}`);

      // Create and start server
      const server = yield* createServer();
      yield* Effect.forkScoped(server.run({ host: "localhost", port }));

      // Small delay to ensure server is ready
      yield* Effect.sleep("1 second");

      const result = yield* Effect.gen(function* () {
        // Get client and make request that should fail
        const client = yield* effectProto.HelloWorldAPIClientTag;
        const result = yield* client.getGreeting({ name: "TestUser" }, {});

        return result;
      }).pipe(Effect.provide(clientLayer), Effect.scoped);

      // Verify response
      expect(result.greeting).toContain("Hello, TestUser!");
      expect(result.greeting).toContain("E2E test");
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(PortLive),
          Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug)),
        ),
      ),
    ),
  );

  it.scopedLive("should handle error from faceTheError RPC", () =>
    Effect.gen(function* () {
      // Get port from context
      const port = yield* Port;
      yield* Effect.logInfo(`Starting test server on port ${port}`);

      // Create and start server
      const server = yield* createServer();
      yield* Effect.forkScoped(server.run({ host: "localhost", port }));

      // Small delay to ensure server is ready
      yield* Effect.sleep("1 second");

      const result = yield* Effect.gen(function* () {
        // Get client and make request that should fail
        const client = yield* effectProto.HelloWorldAPIClientTag;
        const result = yield* Effect.exit(client.faceTheError({ name: "TestUser" }, null));

        return result;
      }).pipe(Effect.provide(clientLayer), Effect.scoped);

      // Verify it failed with expected error
      if (!Exit.isFailure(result)) {
        return expect(false, "The result should be a failure").toBeTruthy();
      }

      const errorOption = Cause.dieOption(result.cause);
      if (Option.isNone(errorOption)) {
        return expect(false, "The result should be Cause#Die").toBeTruthy();
      }

      const error = errorOption.value;
      const errorString = String(error);
      return expect(errorString).toContain("face the consequences");
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug)),
          Layer.provideMerge(PortLive),
        ),
      ),
    ),
  );
});

/**
 * Tests for service naming to ensure generated code doesn't have duplicate suffixes.
 * See: https://github.com/Dr-Nikson/effect-grpc/issues/30
 */
describe("Service Naming - No Duplicate Suffixes (Issue #30)", () => {
  /**
   * This test verifies that when a proto service is named "NamingTestService"
   * (already ending with "Service"), the generated code does NOT produce
   * "NamingTestServiceService" or similar duplicated names.
   */
  it("should generate correct export names for services ending with 'Service'", () => {
    // These would fail to import if naming were broken
    expect(namingTestProto.NamingTestServiceTag).toBeDefined();
    expect(namingTestProto.NamingTestServiceClientTag).toBeDefined();
    expect(namingTestProto.namingTestServiceLiveLayer).toBeDefined();
    expect(namingTestProto.namingTestServiceClientLiveLayer).toBeDefined();
    expect(namingTestProto.NamingTestServiceConfigTag).toBeDefined();
    expect(namingTestProto.NamingTestServiceProtoId).toBe("com.example.v1.NamingTestService");
  });
});
