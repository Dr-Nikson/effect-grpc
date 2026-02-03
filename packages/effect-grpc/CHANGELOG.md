# @dr_nikson/effect-grpc

## 3.0.0-alpha.3

### Minor Changes

- [#41](https://github.com/Dr-Nikson/effect-grpc/pull/41) [`368dc2c`](https://github.com/Dr-Nikson/effect-grpc/commit/368dc2c8c52e8d4bd1c03733e0dea9e051aa0ec6) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - # 🔭 Distributed Tracing with OpenTelemetry

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
    Effect.withSpan("my-business-operation"), // Parent span
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
        message: `Hello, ${request.name}!`,
      });
    },
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
      new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
    ),
  }));

  // Provide it to your application
  const program = myGrpcProgram.pipe(Effect.provide(TracingLive));
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

### Patch Changes

- [#38](https://github.com/Dr-Nikson/effect-grpc/pull/38) [`49dfd83`](https://github.com/Dr-Nikson/effect-grpc/commit/49dfd837630b150d42ef4e22c4ad07c39b821a83) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Fix duplicate suffix in generated service names (#30)

  Services with names already ending in "Service" (e.g., `HelloWorldService`) no longer produce duplicated names like `HelloWorldServiceService`. The code generator now correctly strips the suffix before applying naming conventions.

- [#36](https://github.com/Dr-Nikson/effect-grpc/pull/36) [`42c988b`](https://github.com/Dr-Nikson/effect-grpc/commit/42c988bec4c39242ba4589f7f81e56c4850fbe87) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Use Effect submodule imports instead of barrel imports in generated code

  Generated code now imports from specific Effect submodules (e.g., `effect/Effect`, `effect/Context`) instead of the barrel import (`effect`). This improves tree-shaking and reduces bundle sizes.

## 3.0.0-alpha.2

### Minor Changes

- [#32](https://github.com/Dr-Nikson/effect-grpc/pull/32) [`8764bc8`](https://github.com/Dr-Nikson/effect-grpc/commit/8764bc8b73209338aed894173bc860b061a6f36d) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - fix(server): enforce context type safety in GrpcServerBuilder

  **Breaking Change:** `GrpcServerBuilder()` now returns `GrpcServerBuilder<unknown, never>` instead of `GrpcServerBuilder<any, never>`.

  This fixes a critical type safety issue where services with specific context requirements (like `HandlerContext`) could be incorrectly added to a builder that doesn't provide that context. The previous behavior using `any` bypassed all type checking.

  **Migration:**

  Services with specific context types now require `withContextTransformer` before being added:

  ```typescript
  // Before (broken - compiled but failed at runtime)
  const server = GrpcServerBuilder()
  .withService(myHandlerContextService)
  .build();

  // After (correct)
  const server = GrpcServerBuilder()
  .withContextTransformer((ctx) => Effect.succeed(ctx))
  .withService(myHandlerContextService)
  .build();
  ```

  Services with `any` context can still be added directly without transformation.

  Fixes #31

## 3.0.0-alpha.1

### Major Changes

- [#25](https://github.com/Dr-Nikson/effect-grpc/pull/25) [`9346226`](https://github.com/Dr-Nikson/effect-grpc/commit/934622682aceb4451b673b10ff2c84b740e5c212) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Refactor code generator API structure and add comprehensive JSDoc documentation

  **Breaking Changes:**
  - Service layer API: `Service.liveLayer(service)(tag)` → `serviceLiveLayer(tag, service)`
  - Client tag API: `Client.makeTag<Meta>("key")` → `ClientTag<Meta>("key")`
  - Client layer API: `Client.liveLayer(tag)` → `clientLiveLayer(tag)`
  - Service ID naming: `ServiceId` → `ServiceProtoId`
  - Default context type changed from `HandlerContext` to `any` for better flexibility

  **Improvements:**
  - Added comprehensive JSDoc documentation with usage examples for all generated exports
  - Fixed nested comment syntax in JSDoc that was breaking TypeScript parsing
  - Fixed import paths in JSDoc examples to use correct proto file basename
  - Improved type signature formatting for better readability
  - Simplified API with direct exports instead of namespace objects
  - Updated transformCtx signature to only accept HandlerContext as input
  - Support dual-context transformation API in withContextTransformer

  Closes #13, #24

## 3.0.0-alpha.0

### Major Changes

- [#3](https://github.com/Dr-Nikson/effect-grpc/pull/3) [`bd982f3`](https://github.com/Dr-Nikson/effect-grpc/commit/bd982f32cb07293538deb40e15fc2248f148bb33) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - gRPC Library with effect 3.0 supported
