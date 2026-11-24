# effect-grpc

Type-safe gRPC and Protocol Buffer support for the Effect ecosystem

## Overview

`effect-grpc` provides a seamless integration between gRPC/Protocol Buffers and the Effect TypeScript. It enables you to build type-safe, composable gRPC services and clients with all the benefits of Effect's powerful error handling, dependency injection, and functional programming patterns.

**Built on battle-tested foundations:** This library is a thin wrapper around industry-standard, production-proven gRPC libraries including [Connect-RPC](https://connectrpc.com/) (Buf's modern gRPC implementation) and [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es) (official Protocol Buffers runtime for JavaScript/TypeScript), bringing Effect's functional programming benefits to the established gRPC ecosystem.

### Key Features

- **Full Type Safety** - Generated TypeScript code from Protocol Buffers with complete type inference
- **Effect Integration** - Native support for Effect's error handling, tracing, and dependency injection
- **🔭 Distributed Tracing** - Automatic OpenTelemetry support with W3C Trace Context propagation
- **Code Generation** - Automatic client and server code generation via `protoc-gen-effect` plugin
- **Connect-RPC** - Built on Connect-RPC for maximum compatibility with gRPC and gRPC-Web
- **Modular Architecture** - Clean separation between service definitions and implementations
- **Zero Boilerplate** - Minimal setup required to get started

## Installation

effect-grpc 4 needs Effect 4.1.5 or later and Node.js 22.19 or later.

```bash
npm install @dr_nikson/effect-grpc effect @effect/opentelemetry
# gRPC runtime deps
npm install @bufbuild/protobuf @connectrpc/connect
# Runs the Quick Start programs on Node.js
npm install @effect/platform-node
```

For code generation, you'll also need:

```bash
npm install --save-dev @bufbuild/buf @bufbuild/protoc-gen-es
```

## Quick Start

This guide will walk you through setting up a simple gRPC service with effect-grpc.

### 1. Define Your Protocol Buffer

Create a `.proto` file defining your service:

```protobuf
// proto/example/v1/hello.proto
syntax = "proto3";

package example.v1;

service HelloService {
  rpc SayHello(HelloRequest) returns (HelloResponse);
}

message HelloRequest {
  string name = 1;
}

message HelloResponse {
  string message = 1;
}
```

The file sits in a directory that matches its package, `example.v1`, as buf expects. The generated files then land in `src/generated/example/v1/`.

### 2. Configure Code Generation

Create a `buf.gen.yaml` configuration file:

```yaml
# buf.gen.yaml
version: v2
inputs:
  - directory: proto
plugins:
  # Generate base Protocol Buffer TypeScript code
  - local: protoc-gen-es
    opt: target=ts,import_extension=js
    out: src/generated
  # Generate Effect-specific code
  - local: protoc-gen-effect
    opt: target=ts,import_extension=js
    out: src/generated
```

### 3. Generate TypeScript Code

Add the following script to your `package.json`:

```json
{
  "scripts": {
    "generate:proto": "buf generate"
  }
}
```

Then run:

```bash
npm run generate:proto
```

This will generate TypeScript files in `src/generated/example/v1/` with full Effect integration.

### 4. Implement the Server

```typescript
// src/server.ts
import { Effect, Layer, References } from "effect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { NodeRuntime } from "@effect/platform-node";

import * as effectProto from "./generated/example/v1/hello_effect.js";
import * as proto from "./generated/example/v1/hello_pb.js";

// Implement the service (ctx not used, so no need to specify type)
const HelloServiceLive: effectProto.HelloService = {
  sayHello(request: proto.HelloRequest) {
    return Effect.succeed({
      message: `Hello, ${request.name}!`
    });
  }
};

// Create the service layer
const helloServiceLayer = effectProto.helloServiceLiveLayer(
  effectProto.HelloServiceTag,
  HelloServiceLive
);

const grpcServerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const helloService = yield* effectProto.HelloServiceTag;

    const server: EffectGrpcServer.GrpcServer<"example.v1.HelloService"> =
      EffectGrpcServer
        .GrpcServerBuilder()
        .withService(helloService)
        .build();

    yield* server.listen({ host: "127.0.0.1", port: 8000 });
  })
);

const appLayer = grpcServerLayer.pipe(
  Layer.provide(helloServiceLayer),
  Layer.provide(Layer.succeed(References.MinimumLogLevel, "Info"))
);

NodeRuntime.runMain(Layer.launch(appLayer));
```

The server binds `127.0.0.1` instead of `localhost`. Node can bind `localhost` to `::1`, and a client on an IPv4-only host then dials `127.0.0.1` and gets `ECONNREFUSED`.

`listen` succeeds with the address the server bound. Pass `port: 0` to let the OS pick a free port, and read it from the result. The server also logs it, as in `gRPC server listening on http://127.0.0.1:41234`.

`Layer.launch` builds the layers and keeps them until Ctrl+C or SIGTERM interrupts it. Effect releases a layer only after the layers that use it, so on shutdown the server stops first. It tells each client to send no new calls, lets the calls in flight finish, and closes each connection, an idle one at once. Then `helloServiceLayer` is released, with anything that a service layer holds, such as a database pool. The process then exits with code 130, which is the code `runMain` of Effect 4 gives a program that a signal stopped. To exit with another code, pass `teardown` to `runMain`.

To run `listen` in an Effect program of your own, put `Effect.scoped` inside `Effect.provide`, as in `program.pipe(Effect.scoped, Effect.provide(layer))`. The other way round, `Effect.provide(program, layer).pipe(Effect.scoped)` releases the layers before the server stops, and a call in flight then runs against closed resources.

### 5. Implement the Client

```typescript
// src/client.ts
import { Effect, Layer, References } from "effect";
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";
import { NodeRuntime } from "@effect/platform-node";

import * as effectProto from "./generated/example/v1/hello_effect.js";

// Create the client layer with configuration
const helloClientLayer = effectProto.helloServiceClientLiveLayer(
  effectProto.HelloServiceClientTag
).pipe(
  Layer.provideMerge(
    Layer.succeed(
      effectProto.HelloServiceConfigTag,
      EffectGrpcClient.GrpcClientConfig({
        baseUrl: new URL("http://127.0.0.1:8000")
      })
    )
  )
);

// Use the client
const program = Effect.gen(function* () {
  const client = yield* effectProto.HelloServiceClientTag;

  const response = yield* client.sayHello({
    name: "World"
  }, {});

  yield* Effect.log(`Server responded: ${response.message}`);
});

// Provide dependencies and run
const dependencies = Layer.empty.pipe(
  Layer.provideMerge(helloClientLayer),
  Layer.provideMerge(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Info"))
);

NodeRuntime.runMain(Effect.provide(program, dependencies));
```

## Complete Example

For a complete working example, see the [`packages/example`](packages/example) directory in this repository. It demonstrates:

- Protocol Buffer definition and code generation
- Server implementation with Effect
- Client implementation with Effect
- Proper project structure and configuration

To run the example:

```bash
# Clone the repository
git clone https://github.com/Dr-Nikson/effect-grpc.git
cd effect-grpc

# Install dependencies
pnpm install

# Build the library
pnpm -r run build

# In one terminal, start the server
cd packages/example
node dist/server.js

# In another terminal, run the client
node dist/client.js
```

## API Reference

This section documents the public API exported by `@dr_nikson/effect-grpc`. The library excludes internal runtime APIs from public documentation.

### Server API (`EffectGrpcServer`)

The server API provides tools for building and running gRPC servers within Effect programs.

#### Core Types

##### `GrpcServer<Services>`

Represents a running gRPC server instance.

**Type Parameters:**
- `Services` - Union type of all service tags registered with this server

**Methods:**
- `listen(options: { host: string; port: number }): Effect.Effect<GrpcServerAddress, GrpcServerBindError, Scope.Scope>` - Starts the server on the specified host and port, and succeeds with the address it bound once it listens. Port 0 lets the OS pick the port. The server serves until the Scope closes. Closing the Scope stops it: it tells each client to send no new calls, lets the calls in flight finish, and closes each connection, an idle one at once. Nothing interrupts a call in flight, so a handler that never ends keeps the Scope open, and so does a client that never reads from its connection. To serve for the life of the process, run `listen` in `Layer.effectDiscard` and start that layer with `Layer.launch`, as the Quick Start does, so the server stops before the layers that its handlers use are released. Fails with `GrpcServerBindError` when the server cannot listen, for example when the port is taken. Interrupting `listen` before the server listens stops the attempt. `listen` replaces `run`, which never returned.

**Example:**
```typescript
import { Effect } from "effect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";

import type * as helloProto from "./generated/example/v1/hello_effect.js";
import type * as userProto from "./generated/com/example/v1/user_effect.js";

declare const helloService: helloProto.HelloGrpcService;
declare const userService: userProto.UserGrpcService;

const server: EffectGrpcServer.GrpcServer<"example.v1.HelloService" | "com.example.v1.UserService"> =
  EffectGrpcServer.GrpcServerBuilder()
    .withService(helloService)
    .withService(userService)
    .build();

// Serve until the scope closes
const program = Effect.scoped(
  Effect.gen(function* () {
    const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
    yield* Effect.logInfo(`Clients can dial ${address.url}`);
    return yield* Effect.never;
  })
);
```

##### `GrpcServerAddress`

The address a listening server bound, as the OS reports it:
- `host` - the IP address, without brackets, such as `127.0.0.1` or `::1`
- `port` - the port, which is the one the OS picked when `listen` was given port 0
- `url` - `http://<host>:<port>` with brackets around an IPv6 host, such as `http://[::1]:41234`, as the ready line prints it. After a wildcard bind (`0.0.0.0` or `::`) it names the wildcard, so a client on another machine dials the server's own host name with `port` instead.

##### `GrpcServerBindError`

The error `listen` fails with when the server cannot listen. `host` and `port` are the ones `listen` was given, `cause` is the error Node reported, and `reason._tag` names the cause: `"AddressInUse"` (EADDRINUSE), `"PermissionDenied"` (EACCES or EPERM), `"InvalidPort"` (a port that is not a whole number from 0 to 65535), or `"Other"`.

```typescript
import { Effect } from "effect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";

declare const server: EffectGrpcServer.GrpcServer<"example.v1.HelloService">;

// Fall back to a free port when 8000 is taken
const listenWithFallback = server.listen({ host: "127.0.0.1", port: 8000 }).pipe(
  Effect.catchTag("@dr_nikson/effect-grpc/server/GrpcServerBindError", (error) =>
    error.reason._tag === "AddressInUse"
      ? server.listen({ host: "127.0.0.1", port: 0 })
      : Effect.fail(error)
  )
);
```

##### `GrpcServerBuilder<Ctx, Services>`

Fluent builder interface for constructing gRPC servers.

**Type Parameters:**
- `Ctx` - Context type available to service handlers. It starts as `unknown`, so a service whose implementation reads `ctx` needs `withContextTransformer` first. With no transformer, each handler receives the call's Connect `HandlerContext`.
- `Services` - Union of currently registered service tags

**Methods:**
- `withContextTransformer<Ctx1>(f: (originalCtx: HandlerContext, ctx: Ctx) => Effect.Effect<Ctx1>): GrpcServerBuilder<Ctx1, never>` - Transform the handler context. The first parameter is the original Connect-RPC HandlerContext, the second is the current context (before the first transformer, the same HandlerContext, typed `unknown`). Must be called before adding services.
- `withService<S>(service: S): GrpcServerBuilder<Ctx, Services | Tag<S>>` - Add a service (enforces unique tags)
- `build(): GrpcServer<Services>` - Build the server (requires at least one service)

**Example:**
```typescript
import type { HandlerContext } from "@connectrpc/connect";
import { Effect } from "effect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";

import type * as userProto from "./generated/com/example/v1/user_effect.js";

interface AppContext {
  userId: string;
  requestId: string;
}

declare const userService: userProto.UserGrpcService;
declare const appUserService: userProto.UserGrpcService<AppContext>;

// A service that does not read ctx needs no transformer
const server = EffectGrpcServer.GrpcServerBuilder()
  .withService(userService)
  .build();

// A service that reads ctx gets it from context transformers
const serverWithCtx = EffectGrpcServer.GrpcServerBuilder()
  // The current ctx is unknown here, so the transformer ignores it
  .withContextTransformer((handlerCtx: HandlerContext) =>
    Effect.succeed({
      requestId: crypto.randomUUID()
    })
  )
  // ctx has `requestId` now, and the original HandlerContext is still the first parameter
  .withContextTransformer((handlerCtx: HandlerContext, ctx) =>
    Effect.succeed<AppContext>({
      requestId: ctx.requestId,
      userId: handlerCtx.requestHeader.get("user-id") ?? "anonymous",
    })
  )
  .withService(appUserService)
  .build();
```

#### Factory Functions

##### `GrpcServerBuilder()`

Creates a new server builder instance. Its context starts as `unknown`.

**Returns:** `GrpcServerBuilder<unknown, never>`

**Example:**
```typescript
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";

const builder = EffectGrpcServer.GrpcServerBuilder();
```

---

### Client API (`EffectGrpcClient`)

The client API provides tools for making gRPC calls from Effect programs.

#### Core Types

##### `GrpcClientConfig<Service>`

Configuration for connecting to a gRPC service.

**Type Parameters:**
- `Service` - The fully-qualified service name (e.g., "com.example.v1.UserService")

**Properties:**
- `baseUrl: URL` - Base URL for gRPC requests (e.g., `new URL("http://127.0.0.1:8000")`)
- `binaryOptions?: Partial<BinaryReadOptions & BinaryWriteOptions>` - Protocol Buffer binary format options
- `acceptCompression?: Compression[]` - Accepted response compression algorithms (defaults to ["gzip", "br"])
- `sendCompression?: Compression` - Compression algorithm for request messages
- `compressMinBytes?: number` - Minimum message size for compression (defaults to 1024 bytes)
- `defaultTimeoutMs?: number` - Default timeout for all requests in milliseconds

**Example:**
```typescript
import { Layer } from "effect";
import { compressionBrotli, compressionGzip } from "@connectrpc/connect-node";
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

const config = EffectGrpcClient.GrpcClientConfig({
  baseUrl: new URL("https://api.example.com"),
  defaultTimeoutMs: 5000,
  acceptCompression: [compressionGzip, compressionBrotli],
  sendCompression: compressionGzip,
  compressMinBytes: 1024
});

// Create a config tag for dependency injection
const UserServiceConfigTag = EffectGrpcClient.GrpcClientConfig.makeTag(
  "com.example.v1.UserService"
);

// Provide the config in a layer
const configLayer = Layer.succeed(UserServiceConfigTag, config);
```

##### `RequestMeta`

Metadata attached to individual gRPC requests.

**Properties:**
- `headers?: Headers` - HTTP headers to send with the request
- `contextValues?: ContextValues` - Connect-RPC context values

Of these, a client sends only `headers`, and only when its layer turns each call's metadata into a `RequestMeta`, as in [Request Metadata and Headers](#request-metadata-and-headers). The client ignores `contextValues`.

**Example:**
```typescript
import { Effect } from "effect";
import type { EffectGrpcClient } from "@dr_nikson/effect-grpc";

import type * as userProto from "./generated/com/example/v1/user_effect.js";

declare const client: userProto.UserServiceClient<EffectGrpcClient.RequestMeta>;

const meta: EffectGrpcClient.RequestMeta = {
  headers: new Headers({
    "Authorization": "Bearer token123",
    "X-Request-ID": crypto.randomUUID()
  })
};

// Use with a generated client whose metadata type is RequestMeta
const program = Effect.gen(function* () {
  return yield* client.getUser({ userId: "123" }, meta);
});
```

#### Factory Functions

##### `liveGrpcClientRuntimeLayer()`

Creates the live implementation layer for `GrpcClientRuntime`.

**Returns:** `Layer.Layer<GrpcClientRuntime>`

**Example:**
```typescript
import { Layer } from "effect";
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

const layer = Layer.empty.pipe(
  Layer.provideMerge(EffectGrpcClient.liveGrpcClientRuntimeLayer())
);
```

##### `GrpcClientConfig(opts)`

Creates a client configuration object.

**Parameters:**
- `opts` - Configuration options (omit the `_Service` type parameter)

**Returns:** `GrpcClientConfig<Service>`

**Example:**
```typescript
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

const config = EffectGrpcClient.GrpcClientConfig({
  baseUrl: new URL("http://127.0.0.1:8000"),
  defaultTimeoutMs: 5000
});
```

##### `GrpcClientConfig.makeTag(service)`

Creates a Context tag for service-specific configuration.

**Parameters:**
- `service` - Fully-qualified service name

**Returns:** `Context.Service<GrpcClientConfig<Service>, GrpcClientConfig<Service>>`

**Example:**
```typescript
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

const UserServiceConfigTag = EffectGrpcClient.GrpcClientConfig.makeTag(
  "com.example.v1.UserService"
);
```

---

### Generated Code API

The `protoc-gen-effect` plugin generates TypeScript code from `.proto` files with Effect integration. This section documents the code it generates for this service:

```protobuf
// proto/com/example/v1/user.proto
syntax = "proto3";

package com.example.v1;

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
}

message User {
  string id = 1;
  string name = 2;
}

message GetUserRequest {
  string user_id = 1;
}

message GetUserResponse {
  User user = 1;
}

message ListUsersRequest {}

message ListUsersResponse {
  repeated User users = 1;
}
```

The generated names follow the proto service name. The server names append `Service` unless the name already ends in it, and the client names append `Client` the same way. For `service UserService` the generator exports `UserServiceProtoId`, `UserService`, `UserServiceTag`, `makeUserServiceTag`, `userServiceLiveLayer`, `UserGrpcService`, `UserServiceClient`, `UserServiceClientTag`, `makeUserServiceClientTag`, `userServiceClientLiveLayer` and `UserServiceConfigTag`. For `service HelloWorldAPI` it exports `HelloWorldAPIService`, `HelloWorldAPIServiceTag`, `HelloWorldAPIClient`, `HelloWorldAPIClientTag` and so on.

`protoc-gen-effect` generates unary rpcs. A service that also has streaming rpcs still generates code that compiles. Its service interface and its client list the unary rpcs only, and the server answers a call to a streaming rpc with the gRPC status `UNIMPLEMENTED` on gRPC, gRPC-web and Connect.

#### Service Implementation (Server-side)

For each service in your `.proto` file, the generator creates:

##### `UserServiceProtoId`

Constant and type for the service identifier.

**Example:**
```typescript
// src/generated/com/example/v1/user_effect.ts
export const UserServiceProtoId = "com.example.v1.UserService" as const;
export type UserServiceProtoId = typeof UserServiceProtoId;
```

##### `UserService<Ctx>`

Interface defining the service implementation contract.

**Type Parameters:**
- `Ctx` - Context type available in method handlers

**Example:**
```typescript
// src/generated/com/example/v1/user_effect.ts
export interface UserService<Ctx = any> {
  getUser(
    request: GetUserRequest,
    ctx: Ctx
  ): Effect.Effect<MessageInitShape<typeof GetUserResponseSchema>, GrpcException.GrpcException>;

  listUsers(
    request: ListUsersRequest,
    ctx: Ctx
  ): Effect.Effect<MessageInitShape<typeof ListUsersResponseSchema>, GrpcException.GrpcException>;
}
```

##### `UserServiceTag` and `makeUserServiceTag<Ctx>(key)`

`UserServiceTag` is the default Context tag of the service, for an implementation that does not read `ctx`. Its key is `com.example.v1.UserService/Service`.

For an implementation that reads a typed `ctx`, make a tag with `makeUserServiceTag<Ctx>(key)`. Its key is `com.example.v1.UserService/Service<key>`, so it never equals the default tag's key. The key is the tag's identity: tags made with the same key share one Context slot, whatever their type argument. Name the key after the context type.

**Usage:**
```typescript
import type { HandlerContext } from "@connectrpc/connect";

import * as effectProto from "./generated/com/example/v1/user_effect.js";

// The default tag, for an implementation that does not read ctx
const UserServiceDefaultTag = effectProto.UserServiceTag;

// A typed tag, for an implementation that reads ctx
interface AppContext {
  userId: string;
  requestId: string;
}
const UserServiceAppCtxTag = effectProto.makeUserServiceTag<AppContext>("AppContext");

// With HandlerContext when you need access to request headers
const UserServiceHandlerCtxTag = effectProto.makeUserServiceTag<HandlerContext>("HandlerContext");
```

##### `userServiceLiveLayer(tag, service)`

Function that creates a layer from a service implementation.

**Parameters:**
- `tag` - Context tag for the service
- `service` - Implementation of the service interface

**Returns:** `Layer` providing the gRPC service

**Example:**
```typescript
import type { HandlerContext } from "@connectrpc/connect";
import { Effect } from "effect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/user_effect.js";

// If not using ctx, use the default type and tag
const UserServiceLive: effectProto.UserService = {
  getUser(request) {
    return Effect.succeed({ user: { id: request.userId, name: "John" } });
  },
  listUsers() {
    return Effect.succeed({ users: [] });
  }
};

const userServiceLayer = effectProto.userServiceLiveLayer(
  effectProto.UserServiceTag,
  UserServiceLive
);

// When you need to access ctx (e.g., HandlerContext for request headers), use a typed tag
const UserServiceWithCtx: effectProto.UserService<HandlerContext> = {
  getUser(request, ctx) {
    const authToken = ctx.requestHeader.get("authorization");
    // ... use authToken in your logic
    return Effect.succeed({ user: { id: request.userId, name: "John" } });
  },
  listUsers() {
    return Effect.succeed({ users: [] });
  }
};

const UserServiceHandlerCtxTag = effectProto.makeUserServiceTag<HandlerContext>("HandlerContext");
const userServiceLayerWithCtx = effectProto.userServiceLiveLayer(
  UserServiceHandlerCtxTag,
  UserServiceWithCtx
);

// The server gives each handler its HandlerContext through a context transformer
const server = Effect.gen(function* () {
  const userService = yield* UserServiceHandlerCtxTag;

  return EffectGrpcServer.GrpcServerBuilder()
    .withContextTransformer((handlerCtx) => Effect.succeed(handlerCtx))
    .withService(userService)
    .build();
});
```

#### Client Implementation

For each service, the generator also creates client-side types:

##### `UserServiceClient<Meta>`

Interface defining the client API.

**Type Parameters:**
- `Meta` - Type of metadata passed with each request

**Example:**
```typescript
// src/generated/com/example/v1/user_effect.ts
export interface UserServiceClient<Meta> {
  getUser(
    request: MessageInitShape<typeof GetUserRequestSchema>,
    meta: Meta
  ): Effect.Effect<GetUserResponse>;

  listUsers(
    request: MessageInitShape<typeof ListUsersRequestSchema>,
    meta: Meta
  ): Effect.Effect<ListUsersResponse>;
}
```

##### `UserServiceClientTag` and `makeUserServiceClientTag<Meta>(key)`

`UserServiceClientTag` is the default Context tag of the client. Its key is `com.example.v1.UserService/Client`, so one Context can hold the client and the service side by side.

For a client whose calls take typed metadata, make a tag with `makeUserServiceClientTag<Meta>(key)`. Its key is `com.example.v1.UserService/Client<key>`, and the key is the tag's identity, as for the service tag.

**Usage:**
```typescript
import * as effectProto from "./generated/com/example/v1/user_effect.js";

// The default tag (any metadata)
const UserServiceDefaultClientTag = effectProto.UserServiceClientTag;

// A typed tag with custom metadata
interface AuthMeta {
  authToken: string;
}
const UserServiceAuthClientTag = effectProto.makeUserServiceClientTag<AuthMeta>("AuthMeta");
```

##### `userServiceClientLiveLayer(tag)` and `userServiceClientLiveLayer(transformMeta, tag)`

Function that creates a client layer. It has two overloads:

```typescript
// src/generated/com/example/v1/user_effect.ts
export declare const userServiceClientLiveLayer: {
  <Tag extends UserServiceClientTag<Meta>, Meta>(
    transformMeta: (meta: Meta) => EffectGrpcClient.RequestMeta,
    tag: Tag,
  ): Layer.Layer<
    Tag["Identifier"],
    never,
    UserServiceConfigTag["Identifier"] | EffectGrpcClient.GrpcClientRuntime
  >;

  <Tag extends UserServiceClientTag>(
    tag: Tag,
  ): Layer.Layer<
    Tag["Identifier"],
    never,
    UserServiceConfigTag["Identifier"] | EffectGrpcClient.GrpcClientRuntime
  >;
};
```

`transformMeta` turns each call's metadata into the request's headers. The one-argument overload sends no metadata, so build a client on a typed tag with `transformMeta`.

**Example:**
```typescript
import { Effect, Layer } from "effect";
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/user_effect.js";

const config = EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL("http://127.0.0.1:8000") });

// With custom metadata transformation
interface AuthMeta {
  authToken: string;
}

const UserServiceAuthClientTag = effectProto.makeUserServiceClientTag<AuthMeta>("AuthMeta");
const userServiceAuthClientLayer = effectProto.userServiceClientLiveLayer(
  (meta: AuthMeta) => ({
    headers: new Headers({ "Authorization": `Bearer ${meta.authToken}` })
  }),
  UserServiceAuthClientTag
).pipe(
  Layer.provideMerge(
    Layer.succeed(effectProto.UserServiceConfigTag, config)
  )
);

// With default metadata
const userServiceClientLayer = effectProto.userServiceClientLiveLayer(
  effectProto.UserServiceClientTag
).pipe(
  Layer.provideMerge(
    Layer.succeed(effectProto.UserServiceConfigTag, config)
  )
);

// Each call through the typed tag takes AuthMeta
const program = Effect.gen(function* () {
  const client = yield* UserServiceAuthClientTag;
  return yield* client.getUser({ userId: "123" }, { authToken: "token123" });
});
```

##### `UserServiceConfigTag`

Pre-created config tag for the service.

**Example:**
```typescript
// src/generated/com/example/v1/user_effect.ts
export const UserServiceConfigTag: UserServiceConfigTag = EffectGrpcClient.GrpcClientConfig.makeTag(UserServiceProtoId);
```

Use it to provide configuration:

```typescript
import { Layer } from "effect";
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/user_effect.js";

const configLayer = Layer.succeed(
  effectProto.UserServiceConfigTag,
  EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL("http://127.0.0.1:8000") })
);
```

## Advanced Usage

### Error Handling with GrpcException

effect-grpc provides `GrpcException`, a typed error that extends Effect's `Data.TaggedError` for handling gRPC errors. All generated service methods return `Effect<Success, GrpcException>`.

```typescript
import { Effect } from "effect";
import { GrpcException } from "@dr_nikson/effect-grpc";
import { Code } from "@connectrpc/connect";

import type * as effectProto from "./generated/com/example/v1/user_effect.js";
import type * as proto from "./generated/com/example/v1/user_pb.js";

declare const database: {
  findUser(id: string): Promise<{ id: string; name: string } | undefined>;
};

// Implement the service with error handling (ctx not used, so use default)
const UserServiceLive: effectProto.UserService = {
  getUser(request: proto.GetUserRequest) {
    return Effect.gen(function* () {
      // Input validation with gRPC status codes
      if (!request.userId) {
        return yield* Effect.fail(
          GrpcException.create(Code.InvalidArgument, "User ID is required")
        );
      }

      // Convert unknown errors to GrpcException
      const user = yield* Effect.tryPromise({
        try: () => database.findUser(request.userId),
        catch: (error) => GrpcException.from(Code.Internal, error)
      });

      if (!user) {
        return yield* Effect.fail(
          GrpcException.create(Code.NotFound, "User not found")
        );
      }

      return { user };
    });
  },
  listUsers() {
    return Effect.succeed({ users: [] });
  }
};
```

**GrpcException API:**
- `GrpcException.create(code, message, cause?)` - Create a new exception
- `GrpcException.from(code, cause)` - Convert any error to GrpcException
- `GrpcException.withDescription(error, desc)` - Add context description

**What the client receives.** The server sends one status for each call:
- A typed failure sends its code and message, also when a finalizer dies after it.
- A defect, such as `Effect.die`, a throw or `Effect.orDie`, sends `INTERNAL` with the message `Internal server error`. The defect stays on the server. When a second defect, such as a dying finalizer, follows a `GrpcException` that `Effect.die` or `Effect.orDie` turned into a defect, the server sends the exception's code and message. Effect 4 gives that cause the same shape as a typed failure whose finalizer died. `GrpcException.from` copies an error's message, so in that case the wrapped error's message reaches the client.
- A deadline that passes while the handler waits on something asynchronous, such as a promise or a timer, interrupts the handler and sends `DEADLINE_EXCEEDED`. A handler that runs synchronous code past its deadline and then finishes answers normally.
- A client that cancels the call interrupts the handler, and the client reads nothing more.

For gRPC status codes and error handling best practices, see [Connect RPC Error Handling](https://connectrpc.com/docs/node/errors).

### Dependency Injection

Leverage Effect's powerful dependency injection to compose your services with external dependencies:

```typescript
import { Context, Effect, Layer } from "effect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/user_effect.js";
import type * as proto from "./generated/com/example/v1/user_pb.js";

interface User {
  id: string;
  name: string;
}

// Define a database service
class DatabaseService extends Context.Service<
  DatabaseService,
  {
    readonly getUser: (id: string) => Effect.Effect<User>;
    readonly listUsers: () => Effect.Effect<Array<User>>;
  }
>()("DatabaseService") {}

// Service implementation class with constructor
class UserServiceLive implements effectProto.UserService {
  constructor(private readonly db: Context.Service.Shape<typeof DatabaseService>) {}

  getUser(request: proto.GetUserRequest) {
    return this.db.getUser(request.userId).pipe(
      Effect.map(user => ({ user }))
    );
  }

  listUsers() {
    return this.db.listUsers().pipe(
      Effect.map(users => ({ users }))
    );
  }
}

// Wire dependencies through constructor
const userServiceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const serviceImpl = new UserServiceLive(db);
    return effectProto.userServiceLiveLayer(effectProto.UserServiceTag, serviceImpl);
  })
);

// Create a mock database layer for testing
const mockDatabaseLayer = Layer.succeed(DatabaseService, {
  getUser: (id) => Effect.succeed({ id, name: "Mock User" }),
  listUsers: () => Effect.succeed([])
});

// Compose all layers together
const appLayer = Layer.empty.pipe(
  Layer.provideMerge(mockDatabaseLayer),
  Layer.provideMerge(userServiceLayer)
);

const grpcServerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const userService = yield* effectProto.UserServiceTag;

    const server = EffectGrpcServer.GrpcServerBuilder()
      .withService(userService)
      .build();

    yield* server.listen({ host: "127.0.0.1", port: 8000 });
  })
);

const program = Layer.launch(grpcServerLayer.pipe(Layer.provide(appLayer)));
```

### Request Metadata and Headers

Send custom headers with requests. Custom headers reach the server only through a client built with a metadata transformer, so make a tag whose metadata type is `RequestMeta` and pass each call's metadata through:

```typescript
import { Effect } from "effect";
import type { EffectGrpcClient } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/example/v1/hello_effect.js";

const HelloClientTag = effectProto.makeHelloServiceClientTag<EffectGrpcClient.RequestMeta>("RequestMeta");
const helloClientLayer = effectProto.helloServiceClientLiveLayer(
  (meta: EffectGrpcClient.RequestMeta) => meta,
  HelloClientTag
);

const program = Effect.gen(function* () {
  const client = yield* HelloClientTag;

  return yield* client.sayHello(
    { name: "World" },
    {
      headers: new Headers({
        "Authorization": "Bearer your-token",
        "X-Request-ID": "123456"
      })
    }
  );
});
```

### Distributed Tracing with OpenTelemetry

effect-grpc provides **automatic distributed tracing** with OpenTelemetry, enabling you to trace requests across your entire distributed system with zero manual instrumentation.

#### How It Works

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

#### Setting Up Tracing

**1. Add OpenTelemetry dependencies:**

```bash
# The OpenTelemetry SDK packages that NodeSdk of @effect/opentelemetry loads.
# @effect/opentelemetry 4.1 accepts versions 2.x of the SDK packages, and 0.203 to 0.299 of the logs packages.
npm install @opentelemetry/sdk-trace-node@2 @opentelemetry/sdk-trace-base@2 @opentelemetry/sdk-metrics@2 @opentelemetry/resources@2 @opentelemetry/sdk-logs@0.223 @opentelemetry/api-logs@0.223
# Plus your preferred exporter, from the same line
npm install @opentelemetry/exporter-trace-otlp-http@0.223
```

**2. Configure the OpenTelemetry SDK:**

```typescript
import { Effect, Layer } from "effect";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

declare const myGrpcProgram: Effect.Effect<void>;

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

**3. That's it!** Your gRPC calls will automatically:
- Create spans with semantic attributes (`rpc.system`, `rpc.service`, `rpc.method`)
- Propagate trace context via W3C `traceparent`/`tracestate` headers
- Link client and server spans in the same trace

#### Generated Span Names

| Location | Span Name Format | Example |
|----------|------------------|---------|
| Client | `GrpcClient.makeUnaryRequest({service}/{method})` | `GrpcClient.makeUnaryRequest(example.v1.HelloService/SayHello)` |
| Server | `{service}/{method}` | `example.v1.HelloService/SayHello` |

The server span has the span kind `SERVER` and a `protocol` attribute that names the protocol of the call: `gRPC`, `gRPC-web` or `Connect`. Its `rpc.system` is `grpc`, or `connect_rpc` for a Connect call. The server's log lines for a call carry the same `protocol` annotation, next to `method`.

#### Full Trace Hierarchy

When you wrap your client call in a span, the complete trace hierarchy looks like:

```typescript
import { Effect } from "effect";

import * as effectProto from "./generated/example/v1/hello_effect.js";

// Your code
const program = Effect.gen(function* () {
  const client = yield* effectProto.HelloServiceClientTag;
  return yield* client.sayHello({ name: "World" }, {});
}).pipe(Effect.withSpan("my-business-operation"));
```

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


## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/Dr-Nikson/effect-grpc.git
cd effect-grpc

# Install dependencies
pnpm install

# Build all packages
pnpm -r run build

# Run type tests
pnpm -r run test:types

# Type-check this README's code against the generated code
pnpm run test:readme
```

`test:readme` writes code blocks from the README into a scratch project, generates code from the README's own `.proto` blocks, and compiles every block fenced `ts` or `typescript` except the excerpts of generated code. A block whose first line is a path comment, such as `// src/server.ts`, becomes that file. A block whose path is under `src/generated/` must match the generated declarations. Every other TypeScript block is its own module, so it imports what it uses and declares what it does not build. A block fenced as `js` or `tsx` fails, so fence code as `typescript`. Errors name the README line. `pnpm -r run test:types` runs the same check.

### Project Structure

```
effect-grpc/
├── packages/
│   ├── effect-grpc/          # Core library
│   │   ├── src/
│   │   │   ├── client.ts     # Client implementation
│   │   │   ├── server.ts     # Server implementation
│   │   │   └── index.ts      # Public exports
│   │   └── bin/
│   │       └── protoc-gen-effect  # Protocol Buffer plugin
│   └── example/              # Example implementation
│       ├── proto/           # Protocol Buffer definitions
│       ├── src/
│       │   ├── generated/  # Generated TypeScript code
│       │   ├── server.ts   # Example server
│       │   └── client.ts   # Example client
│       └── buf.gen.yaml    # Buf configuration
└── README.md
```

## Roadmap

- [x] **OpenTelemetry distributed tracing** - Automatic trace context propagation
- [ ] Support for streaming RPCs (server-streaming, client-streaming, bidirectional)
- [ ] Interceptor/middleware support
- [ ] Built-in retry policies with Effect
- [ ] gRPC reflection support
- [ ] Browser/gRPC-Web support
- [ ] Performance optimizations
- [ ] More comprehensive examples

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[Apache License Version 2.0](LICENSE)

## Acknowledgments

- [Effect](https://effect.website/) - The core framework this library builds upon
- [Connect-RPC](https://connectrpc.com/) - The modern gRPC implementation
- [Buf](https://buf.build/) - Protocol Buffer tooling
