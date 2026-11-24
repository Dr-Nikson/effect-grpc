// packages/e2e-tests/src/tracing.test.ts
import { Context, Effect, Layer, Logger, References } from "effect";

import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { createClient } from "@connectrpc/connect";
import { describe, expect, it } from "@effect/vitest";
import { SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

import { HelloWorldAPI } from "./generated/com/example/v1/hello_world_api_pb.js";
import {
  clientLayer,
  createServer,
  effectProto,
  overEachProtocol,
  serverServiceLayer,
} from "./test-fixtures.js";

// InMemorySpanExporter tag for tests
const SpanExporter = Context.Service<InMemorySpanExporter>("SpanExporter");

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

const HandlerLogs = Context.Service<Array<Record<string, unknown>>>("HandlerLogs");

/**
 * Keeps the annotations of each `getGreeting called in E2E test` line, which the handler logs.
 */
function captureHandlerLogsLayer() {
  const annotations: Array<Record<string, unknown>> = [];
  const logger = Logger.make(({ message, fiber }) => {
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    if (text === "getGreeting called in E2E test") {
      annotations.push({ ...fiber.getRef(References.CurrentLogAnnotations) });
    }
  });
  return Layer.merge(Logger.layer([logger]), Layer.succeed(HandlerLogs, annotations));
}

describe("OpenTelemetry Tracing E2E", () => {
  it.live("server creates span with correct name from gRPC method", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;

      // Create and start server
      const server = yield* createServer();
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
      yield* Effect.logInfo(`Test server listening on port ${address.port}`);

      // Make the request
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "TracingTest" }, {});
      }).pipe(Effect.provide(clientLayer(address)), Effect.scoped);

      // Wait a bit for spans to be exported
      yield* Effect.sleep("100 millis");

      // Check the spans
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);

      // Find the server span by name
      const serverSpan = spans.find((s) => s.name === "com.example.v1.HelloWorldAPI/GetGreeting");
      expect(serverSpan).toBeDefined();

      expect(serverSpan!.kind, "a server span").toBe(SpanKind.SERVER);
      expect(
        serverSpan!.attributes,
        "the server span uses the client's attribute names",
      ).toMatchObject({
        "rpc.system": "grpc",
        "rpc.service": "com.example.v1.HelloWorldAPI",
        "rpc.method": "GetGreeting",
        protocol: "gRPC",
      });
      expect(serverSpan!.attributes).not.toHaveProperty("method");
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
        ),
      ),
    ),
  );

  it.live("client creates span that becomes parent of server span", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;

      // Create and start server
      const server = yield* createServer();
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
      yield* Effect.logInfo(`Test server listening on port ${address.port}`);

      // Make the request without any explicit parent span context
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "ClientSpanTest" }, {});
      }).pipe(Effect.provide(clientLayer(address)), Effect.scoped);

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

      expect(clientRpcSpan!.kind, "the client span keeps its kind").toBe(SpanKind.INTERNAL);
      expect(clientRpcSpan!.attributes, "the client span keeps its attributes").toMatchObject({
        "rpc.system": "grpc",
        "rpc.service": "com.example.v1.HelloWorldAPI",
        "rpc.method": "GetGreeting",
      });
    }).pipe(
      Effect.provide(
        Layer.empty.pipe(
          Layer.provideMerge(serverServiceLayer),
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
        ),
      ),
    ),
  );

  it.live("trace context propagates through full span hierarchy", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;

      // Create and start server
      const server = yield* createServer();
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
      yield* Effect.logInfo(`Test server listening on port ${address.port}`);

      // Make the request from within a span context
      // Expected hierarchy: test-span -> client-rpc-span -> server-span
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "TracePropagationTest" }, {});
      }).pipe(
        Effect.withSpan("test-parent-span"),
        Effect.provide(clientLayer(address)),
        Effect.scoped,
      );

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
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
        ),
      ),
    ),
  );

  it.live("span names follow {service}/{method} convention", () =>
    Effect.gen(function* () {
      const exporter = yield* SpanExporter;

      // Create and start server
      const server = yield* createServer();
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });

      // Make request
      yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        yield* client.getGreeting({ name: "NamingTest" }, {});
      }).pipe(Effect.provide(clientLayer(address)), Effect.scoped);

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
          Layer.provideMerge(createTestTracingLayer()),
          Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
        ),
      ),
    ),
  );

  it.live(
    "names the protocol each call used in the server span and the handler's log annotations",
    () =>
      Effect.gen(function* () {
        const exporter = yield* SpanExporter;
        const handlerLogs = yield* HandlerLogs;

        const server = yield* createServer();
        const { url } = yield* server.listen({ host: "127.0.0.1", port: 0 });
        yield* overEachProtocol(url, (transport) =>
          Effect.promise(() =>
            createClient(HelloWorldAPI, transport).getGreeting({ name: "ProtocolTest" }),
          ),
        );

        yield* Effect.sleep("100 millis");

        const serverSpans = exporter
          .getFinishedSpans()
          .filter((span) => span.name === "com.example.v1.HelloWorldAPI/GetGreeting");
        expect(
          serverSpans.map(({ attributes }) => ({
            system: attributes["rpc.system"],
            protocol: attributes["protocol"],
          })),
          "the server spans of the gRPC, gRPC-web and Connect calls, in order",
        ).toEqual([
          { system: "grpc", protocol: "gRPC" },
          { system: "grpc", protocol: "gRPC-web" },
          { system: "connect_rpc", protocol: "Connect" },
        ]);
        expect(
          handlerLogs.map(({ method, protocol }) => ({ method, protocol })),
          "the handler's log annotations for the same calls",
        ).toEqual([
          { method: "com.example.v1.HelloWorldAPI/GetGreeting", protocol: "gRPC" },
          { method: "com.example.v1.HelloWorldAPI/GetGreeting", protocol: "gRPC-web" },
          { method: "com.example.v1.HelloWorldAPI/GetGreeting", protocol: "Connect" },
        ]);
      }).pipe(
        Effect.provide(
          Layer.empty.pipe(
            Layer.provideMerge(serverServiceLayer),
            Layer.provideMerge(createTestTracingLayer()),
            Layer.provideMerge(captureHandlerLogsLayer()),
            Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
          ),
        ),
      ),
  );
});
