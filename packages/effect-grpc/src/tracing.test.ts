// packages/effect-grpc/src/tracing.test.ts
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";

import { NodeSdk } from "@effect/opentelemetry";
import { describe, expect, it } from "@effect/vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { greet, helloWorld } from "./testing/harness.js";

class SpanExporter extends Context.Tag("SpanExporter")<SpanExporter, InMemorySpanExporter>() {}

const tracing = NodeSdk.layer(
  Effect.map(SpanExporter, (exporter) => ({
    spanProcessor: new SimpleSpanProcessor(exporter),
    resource: { serviceName: "test-service" },
    shutdownTimeout: Duration.seconds(2),
  })),
).pipe(Layer.provideMerge(Layer.sync(SpanExporter, () => new InMemorySpanExporter())));

const serverSpanName = "com.example.v1.HelloWorldAPI/GetGreeting";
const clientSpanName = `GrpcClient.makeUnaryRequest(${serverSpanName})`;

const finishedSpan = (name: string) =>
  Effect.flatMap(SpanExporter, (exporter) =>
    Effect.suspend(() =>
      Effect.fromNullable(exporter.getFinishedSpans().find((span) => span.name === name)),
    ),
  ).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("5 seconds"));

const parentOf = (span: ReadableSpan) =>
  Option.fromNullable(span.parentSpanContext).pipe(Option.map(({ spanId }) => spanId));

describe("OpenTelemetry tracing", () => {
  it.live(
    "creates a server span named after the method, with its method and protocol attributes",
    () =>
      Effect.gen(function* () {
        yield* greet("TracingTest");

        const span = yield* finishedSpan(serverSpanName);

        expect(span.attributes).toMatchObject({ method: serverSpanName, protocol: "gRPC" });
      }).pipe(Effect.provide(helloWorld()), Effect.provide(tracing)),
  );

  it.live(
    "chains the test span, the client span and the server span, parent to child, in one trace",
    () =>
      Effect.gen(function* () {
        yield* greet("TracePropagationTest").pipe(Effect.withSpan("test-parent-span"));

        const [test, client, server] = yield* Effect.all([
          finishedSpan("test-parent-span"),
          finishedSpan(clientSpanName),
          finishedSpan(serverSpanName),
        ]);

        expect(parentOf(client)).toEqual(Option.some(test.spanContext().spanId));
        expect(parentOf(server)).toEqual(Option.some(client.spanContext().spanId));
        expect(client.spanContext().traceId).toBe(test.spanContext().traceId);
        expect(server.spanContext().traceId).toBe(test.spanContext().traceId);
      }).pipe(Effect.provide(helloWorld()), Effect.provide(tracing)),
  );
});
