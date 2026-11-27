# @dr_nikson/effect-grpc

## 3.0.0-alpha.6

### Major Changes

- [#86](https://github.com/Dr-Nikson/effect-grpc/pull/86) [`43c3964`](https://github.com/Dr-Nikson/effect-grpc/commit/43c39648af9fa6bdd4ef16a0f91053c4d4523079) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Replace `GrpcServer.run` with `GrpcServer.listen`, which returns the address the server bound, fails when the server cannot listen, and stops when it is interrupted during startup (#57)

  **Breaking.** `run` is gone, so every call to it fails to compile. `run` never returned. It told its caller nothing about the address it bound, and it waited forever when the bind failed, as with a taken port, or when a host lookup hung. That wait could not be interrupted, so Ctrl+C did not stop a process whose server never started listening. `listen` succeeds with a `GrpcServerAddress` (`host`, `port` and `url`) once the server listens, and the server serves until the scope that `listen` runs in closes. A program that only serves keeps the scope open after `listen`:

  ```ts
  yield* server.listen({ host: "127.0.0.1", port: 8000 });
  return yield* Effect.never;
  ```

  A test that forked `run` and slept can call `listen` on port 0 and dial `address.url`.

  **Breaking.** `listen` fails with `GrpcServerBindError` when the server cannot listen. Its `reason._tag` is `"AddressInUse"` (EADDRINUSE), `"PermissionDenied"` (EACCES or EPERM), `"InvalidPort"` (a port that is not a whole number from 0 to 65535) or `"Other"`, and `cause` holds the error Node reported. `reason` is an object with a `_tag`, so Effect 4's `Effect.catchReason` can match it.

  Port 0 works. The OS picks a free port, `listen` returns it, and the ready line names it, as in `gRPC server listening on http://127.0.0.1:41234`. The ready line puts brackets around an IPv6 address, as in `http://[::1]:41234`.

  Interrupting `listen` while the server starts, for example while a host name lookup hangs, ends the attempt, and the port is not bound later.

### Minor Changes

- [#84](https://github.com/Dr-Nikson/effect-grpc/pull/84) [`d0394a3`](https://github.com/Dr-Nikson/effect-grpc/commit/d0394a3c0f3984fb7f435f6b9ff1245f1e1ccc33) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Keep the server running when a request's authority cannot be parsed, serve Node clients that dial an IPv6 literal, and limit request messages to 4 MiB by default (#61)

  One request could stop the server process. A request whose authority was not a valid URL authority threw inside the server's request listener, and Node's HTTP/2 client sends such an authority (`::1:8000`) when it dials `http://[::1]:8000`, as the generated client does. The server now reads an IPv6 address followed by a port without brackets as that address and port. It answers an authority that it still cannot parse with `INVALID_ARGUMENT`: gRPC clients get the status in an HTTP 200 response, and Connect clients get HTTP 400 with a JSON error body.

  The server now rejects a request message larger than 4 MiB, the default of grpc-go and grpc-js, with `RESOURCE_EXHAUSTED`. The limit applies to each message of every method kind, also when the message is compressed and only its decompressed size is too large. Before, the server accepted messages of up to about 4 GiB. To set another limit, pass `readMaxBytes` in bytes to `build`, as in `.build({ readMaxBytes: 16 * 1024 * 1024 })`. `build` throws `Cause.IllegalArgumentException` for a value that is not a whole number from 1 to 4294967295.

  Once the server has answered a request whose upload is still running, such as a refused message, it resets the rest of that request with `NO_ERROR`. The client stops sending, curl and buf curl finish such a call, and graceful shutdown no longer waits for a client that keeps its connection.

  Known limitation: a Node client without the HTTP/2 fixes from nodejs/node#67113 and nodejs/node#67114 frees the unsent rest of a refused message once the server resets the stream, but keeps counting it against its session memory limit, Node's `maxSessionMemory` (10 MB by default). With connect-node 2.1.0 on Node 24.22.3, the gRPC and gRPC-web transports then fail the second refused 5 MiB message and every later call on that connection with `INTERNAL`, and the Connect transport fails from the eleventh. A new connection, for example through a new transport, is served, and the server's shutdown does not wait for such a client.

### Patch Changes

- [#83](https://github.com/Dr-Nikson/effect-grpc/pull/83) [`d666f1f`](https://github.com/Dr-Nikson/effect-grpc/commit/d666f1fd67ada46f930e0954838a3800e673cef6) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Make the README server and client snippets connect on IPv4-only hosts (#60)

  The snippets now bind and dial `127.0.0.1` instead of `localhost`. Node can bind `localhost` to `::1`, and a client on a host without a non-loopback IPv6 address dials `127.0.0.1` and gets `ECONNREFUSED`. The Quick Start server also provides `Layer.scope`, which `server.listen` needs. Without it, the program stopped with `Service not found: effect/Scope`.

- [#84](https://github.com/Dr-Nikson/effect-grpc/pull/84) [`d0394a3`](https://github.com/Dr-Nikson/effect-grpc/commit/d0394a3c0f3984fb7f435f6b9ff1245f1e1ccc33) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Remove the server's debug output, answer HTTP/2 CONNECT requests with 405, and log HTTP/2 server errors through the Effect logger (#63)

  The server no longer prints a line for every request, connection, session and stream. The server's own log lines are the ready line, the two stop lines and the server error line, and they go through the Effect logger.

  An HTTP/2 CONNECT request now gets Node's 405 response. Before, a debug listener marked it as handled, so the request never got an answer and its stream stayed open.

  An error that the HTTP/2 server emits after it starts listening, such as a failed accept of an incoming connection, is logged through the Effect logger as `gRPC server error`, and the process keeps running. A bind failure still fails `listen` with `GrpcServerBindError` and is not logged a second time. Before, the server also printed `Server error` with a stack trace to stderr, even when the caller handled the error.

## 3.0.0-alpha.5

### Patch Changes

- [#47](https://github.com/Dr-Nikson/effect-grpc/pull/47) [`65622fa`](https://github.com/Dr-Nikson/effect-grpc/commit/65622fa148f4d2e8a10b931e684e6867f24c886e) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Use `Layer.scoped` instead of `Layer.effect` for client layers (#45)

  Generated client layers now use `Layer.scoped` instead of `Layer.effect` for proper resource lifecycle management. This removes the `Scope.Scope` requirement from the layer's dependencies, as the scope is now automatically provided and tied to the layer's lifetime. This also fixes Effect LSP warning TS13.

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
