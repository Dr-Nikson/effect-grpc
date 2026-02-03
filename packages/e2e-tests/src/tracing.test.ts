// packages/e2e-tests/src/tracing.test.ts
import { Context, Effect, Layer, LogLevel, Logger } from "effect";

import { NodeSdk } from "@effect/opentelemetry";
import { describe, expect, it } from "@effect/vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  Port,
  PortLive,
  clientLayer,
  createServer,
  effectProto,
  serverServiceLayer,
} from "./test-fixtures.js";

// InMemorySpanExporter tag for tests
const SpanExporter = Context.GenericTag<InMemorySpanExporter>("SpanExporter");

/**
 * Creates a tracing layer with an InMemorySpanExporter for testing.
 * Uses NodeSdk.layer which properly handles the OpenTelemetry SDK lifecycle.
 */
function createTestTracingLayer() {
  const exporter = new InMemorySpanExporter();

  // NodeSdk.layer handles all the OpenTelemetry setup and teardown
  const sdkLayer = NodeSdk.layer(() => ({
    spanProcessor: new SimpleSpanProcessor(exporter),
    resource: {
      serviceName: "test-service",
    },
    // Set a reasonable shutdown timeout to prevent test hangs
    shutdownTimeout: "2 seconds",
  }));

  // Provide the exporter to tests so they can inspect spans
  const exporterLayer = Layer.succeed(SpanExporter, exporter);

  return Layer.merge(sdkLayer, exporterLayer);
}

describe("OpenTelemetry Tracing E2E", () => {
  it.scopedLive("server creates span with correct name from gRPC method", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;
      const port = yield* Port;

      yield* Effect.logInfo(`Starting test server on port ${port}`);

      // Create and start server
      const server = yield* createServer();
      yield* Effect.forkScoped(server.run({ host: "localhost", port }));

      // Small delay to ensure server is ready
      yield* Effect.sleep("500 millis");

      // Make the request
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "TracingTest" }, {});
      }).pipe(Effect.provide(clientLayer), Effect.scoped);

      // Wait a bit for spans to be exported
      yield* Effect.sleep("100 millis");

      // Check the spans
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);

      // Find the server span by name
      const serverSpan = spans.find((s) => s.name === "com.example.v1.HelloWorldAPI/GetGreeting");
      expect(serverSpan).toBeDefined();

      // Check span attributes
      expect(serverSpan!.attributes["method"]).toBe("com.example.v1.HelloWorldAPI/GetGreeting");
      expect(serverSpan!.attributes["protocol"]).toBe("gRPC");
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(PortLive),
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug)),
        ),
      ),
    ),
  );

  it.scopedLive("client creates span that becomes parent of server span", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;
      const port = yield* Port;

      yield* Effect.logInfo(`Starting test server on port ${port}`);

      // Create and start server
      const server = yield* createServer();
      yield* Effect.forkScoped(server.run({ host: "localhost", port }));

      // Small delay to ensure server is ready
      yield* Effect.sleep("500 millis");

      // Make the request without any explicit parent span context
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "ClientSpanTest" }, {});
      }).pipe(Effect.provide(clientLayer), Effect.scoped);

      // Wait a bit for spans to be exported
      yield* Effect.sleep("100 millis");

      // Check the spans
      const spans = exporter.getFinishedSpans();

      // Client span has format: GrpcClient.makeUnaryRequest({service}/{method})
      const clientRpcSpan = spans.find(
        (s) => s.name === "GrpcClient.makeUnaryRequest(com.example.v1.HelloWorldAPI/GetGreeting)",
      );
      // Server span has format: {service}/{method}
      const serverSpan = spans.find((s) => s.name === "com.example.v1.HelloWorldAPI/GetGreeting");

      expect(clientRpcSpan).toBeDefined();
      expect(serverSpan).toBeDefined();

      // Server span's parent should be the client RPC span
      expect(serverSpan!.parentSpanContext?.spanId).toBe(clientRpcSpan!.spanContext().spanId);
      expect(serverSpan!.spanContext().traceId).toBe(clientRpcSpan!.spanContext().traceId);
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(PortLive),
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug)),
        ),
      ),
    ),
  );

  it.scopedLive("trace context propagates through full span hierarchy", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;
      const port = yield* Port;

      yield* Effect.logInfo(`Starting test server on port ${port}`);

      // Create and start server
      const server = yield* createServer();
      yield* Effect.forkScoped(server.run({ host: "localhost", port }));

      // Small delay to ensure server is ready
      yield* Effect.sleep("500 millis");

      // Make the request from within a span context
      // Expected hierarchy: test-span -> client-rpc-span -> server-span
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "TracePropagationTest" }, {});
      }).pipe(Effect.withSpan("test-parent-span"), Effect.provide(clientLayer), Effect.scoped);

      // Wait a bit for spans to be exported
      yield* Effect.sleep("100 millis");

      // Check the spans
      const spans = exporter.getFinishedSpans();

      // Find all three spans in the hierarchy
      const testSpan = spans.find((s) => s.name === "test-parent-span");
      const clientRpcSpan = spans.find(
        (s) => s.name === "GrpcClient.makeUnaryRequest(com.example.v1.HelloWorldAPI/GetGreeting)",
      );
      const serverSpan = spans.find((s) => s.name === "com.example.v1.HelloWorldAPI/GetGreeting");

      expect(testSpan).toBeDefined();
      expect(clientRpcSpan).toBeDefined();
      expect(serverSpan).toBeDefined();

      // Client RPC span's parent should be the test span
      expect(clientRpcSpan!.parentSpanContext?.spanId).toBe(testSpan!.spanContext().spanId);

      // Server span's parent should be the client RPC span
      expect(serverSpan!.parentSpanContext?.spanId).toBe(clientRpcSpan!.spanContext().spanId);

      // All spans should have the same traceId (full context propagation)
      expect(clientRpcSpan!.spanContext().traceId).toBe(testSpan!.spanContext().traceId);
      expect(serverSpan!.spanContext().traceId).toBe(testSpan!.spanContext().traceId);
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(PortLive),
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug)),
        ),
      ),
    ),
  );

  it.scopedLive("span names follow {service}/{method} convention", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;
      const port = yield* Port;

      // Create and start server
      const server = yield* createServer();
      yield* Effect.forkScoped(server.run({ host: "localhost", port }));

      // Small delay to ensure server is ready
      yield* Effect.sleep("500 millis");

      // Make request
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "NamingTest" }, {});
      }).pipe(Effect.provide(clientLayer), Effect.scoped);

      // Wait a bit for spans to be exported
      yield* Effect.sleep("100 millis");

      // Check the spans
      const spans = exporter.getFinishedSpans();
      const serverSpan = spans.find((s) => s.name === "com.example.v1.HelloWorldAPI/GetGreeting");
      expect(serverSpan).toBeDefined();

      // Verify the span name matches the gRPC convention
      // Format: {fully.qualified.service.name}/{MethodName}
      expect(serverSpan!.name).toMatch(/^[\w.]+\/[A-Z][a-zA-Z0-9]*$/);
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(PortLive),
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug)),
        ),
      ),
    ),
  );
});
