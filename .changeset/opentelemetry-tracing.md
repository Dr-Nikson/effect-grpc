---
"@dr_nikson/effect-grpc": minor
---

# 🔭 Distributed Tracing with OpenTelemetry

**effect-grpc now supports automatic distributed tracing out of the box!**

This release brings seamless OpenTelemetry integration to both client and server, enabling you to trace requests across your entire distributed system with zero manual instrumentation.

## What's New

### Automatic Trace Context Propagation

When you make a gRPC call, trace context automatically flows from client to server using the [W3C Trace Context](https://www.w3.org/TR/trace-context/) standard:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Distributed Trace Flow                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Client Process                           Server Process                    │
│   ─────────────────                        ─────────────────                 │
│                                                                              │
│   ┌─────────────────────┐                  ┌─────────────────────┐          │
│   │  Application Span   │                  │                     │          │
│   │  "my-operation"     │                  │                     │          │
│   └──────────┬──────────┘                  │                     │          │
│              │                             │                     │          │
│              ▼                             │                     │          │
│   ┌─────────────────────┐    traceparent   │                     │          │
│   │  Client RPC Span    │ ═══════════════► │  Server RPC Span    │          │
│   │  "GrpcClient..."    │    tracestate    │  "service/Method"   │          │
│   └─────────────────────┘                  └─────────────────────┘          │
│                                                                              │
│   All spans share the same traceId for end-to-end visibility                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Client-Side Tracing

The gRPC client automatically creates spans for each RPC call and injects trace context into outgoing requests:

```typescript
import { Effect } from "effect";
import * as effectProto from "./generated/hello_effect.js";

// Trace context is automatically propagated!
const program = Effect.gen(function* () {
  const client = yield* effectProto.HelloServiceClientTag;

  // This creates a span: "GrpcClient.makeUnaryRequest(example.v1.HelloService/SayHello)"
  // with attributes: rpc.system=grpc, rpc.service, rpc.method
  const response = yield* client.sayHello({ name: "World" }, {});

  return response;
}).pipe(
  Effect.withSpan("my-business-operation") // Parent span
);
```

**Generated Client Spans:**
- **Name:** `GrpcClient.makeUnaryRequest({service}/{method})`
- **Attributes:**
  - `rpc.system`: `"grpc"`
  - `rpc.service`: Fully qualified service name
  - `rpc.method`: Method name

### Server-Side Tracing

The server automatically extracts trace context from incoming requests and creates child spans:

```typescript
import { Effect } from "effect";
import * as effectProto from "./generated/hello_effect.js";

// Server handlers automatically participate in distributed traces
const HelloServiceLive: effectProto.HelloServiceService = {
  sayHello(request) {
    // This runs inside a span: "example.v1.HelloService/SayHello"
    // which is a child of the client's span (same traceId!)
    return Effect.succeed({
      message: `Hello, ${request.name}!`
    });
  }
};
```

**Generated Server Spans:**
- **Name:** `{service}/{method}` (follows gRPC/OpenTelemetry conventions)
- **Attributes:**
  - `method`: Full method path
  - `protocol`: `"gRPC"`

### Full Trace Hierarchy Example

When you wrap your client call in a span, the complete trace looks like:

```
Trace: abc123...
│
├── my-business-operation                              [Client Process]
│   │
│   └── GrpcClient.makeUnaryRequest(example.v1.HelloService/SayHello)
│       │
│       └── example.v1.HelloService/SayHello           [Server Process]
│           │
│           └── (your business logic spans...)
```

## Getting Started

### 1. Add OpenTelemetry Dependencies

```bash
npm install @effect/opentelemetry @opentelemetry/api
```

### 2. Configure the OpenTelemetry SDK

```typescript
import { Effect, Layer } from "effect";
import { NodeSdk } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

// Create the tracing layer
const TracingLive = NodeSdk.layer(() => ({
  resource: { serviceName: "my-grpc-service" },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" })
  ),
}));

// Provide it to your application
const program = myGrpcProgram.pipe(
  Effect.provide(TracingLive)
);
```

### 3. That's It! 🎉

No additional configuration needed. Your gRPC calls will automatically:
- Create spans with semantic attributes
- Propagate trace context via W3C headers
- Link client and server spans in the same trace

## New Dependencies

**Runtime dependencies:**
- `@opentelemetry/api` - OpenTelemetry API (peer dependency)
- `@opentelemetry/core` - W3C Trace Context propagation

**Recommended dev dependencies:**
- `@effect/opentelemetry` - Effect integration with OpenTelemetry
- `@opentelemetry/sdk-trace-base` or `@opentelemetry/sdk-trace-node` - SDK implementation
- Your preferred exporter (OTLP, Jaeger, Zipkin, etc.)
