# effect-grpc

Type-safe gRPC and Protocol Buffer support for the Effect ecosystem

## Overview

`effect-grpc` provides a seamless integration between gRPC/Protocol Buffers and the Effect TypeScript. It enables you to build type-safe, composable gRPC services and clients with all the benefits of Effect's powerful error handling, dependency injection, and functional programming patterns.

**Built on battle-tested foundations:** This library is a thin wrapper around industry-standard, production-proven gRPC libraries including [Connect-RPC](https://connectrpc.com/) (Buf's modern gRPC implementation) and [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es) (official Protocol Buffers runtime for JavaScript/TypeScript), bringing Effect's functional programming benefits to the established gRPC ecosystem.

### Key Features

- **Full Type Safety** - Generated TypeScript code from Protocol Buffers with complete type inference
- **Effect Integration** - Native support for Effect's error handling, tracing, and dependency injection
- **Code Generation** - Automatic client and server code generation via `protoc-gen-effect` plugin
- **Connect-RPC** - Built on Connect-RPC for maximum compatibility with gRPC and gRPC-Web
- **Modular Architecture** - Clean separation between service definitions and implementations
- **Zero Boilerplate** - Minimal setup required to get started

## Installation

```bash
npm install @dr_nikson/effect-grpc
# gRPC runtime deps  
npm install @bufbuild/protobuf  @connectrpc/connect
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
// proto/hello.proto
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

This will generate TypeScript files in `src/generated/` with full Effect integration.

### 4. Implement the Server

```typescript
// src/server.ts
import { Context, Effect, Layer, LogLevel, Logger } from "effect";
import { HandlerContext } from "@connectrpc/connect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { NodeRuntime } from "@effect/platform-node";

import * as effectProto from "./generated/example/v1/hello_effect.js";
import * as proto from "./generated/example/v1/hello_pb.js";

// Implement the service (ctx not used, so no need to specify type)
const HelloServiceLive: effectProto.HelloServiceService = {
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

// Build and run the gRPC server
const program = Effect.gen(function* () {
  const helloService = yield* effectProto.HelloServiceTag;

  const server: EffectGrpcServer.GrpcServer<"HelloService"> =
    EffectGrpcServer
      .GrpcServerBuilder()
      .withService(helloService)
      .build();

  return yield* server.run({ host: "localhost", port: 8000 });
});

// Provide dependencies and run
const layer = Layer.empty.pipe(
  Layer.provideMerge(helloServiceLayer),
  Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Info))
);

NodeRuntime.runMain(Effect.provide(program, layer));
```

### 5. Implement the Client

```typescript
// src/client.ts
import { Effect, Layer, Logger, LogLevel } from "effect";
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
        baseUrl: new URL("http://localhost:8000")
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
  Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Info))
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
git clone https://github.com/dr_nikson/effect-grpc.git
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
- `run(options: { host: string; port: number }): Effect.Effect<never, never, Scope.Scope>` - Starts the server on the specified host and port. Returns an Effect that requires a Scope for resource management.

**Example:**
```typescript
const server: EffectGrpcServer.GrpcServer<"UserService" | "ProductService"> =
  EffectGrpcServer.GrpcServerBuilder()
    .withService(userService)
    .withService(productService)
    .build();

// Run with proper resource management
const program = Effect.scoped(
  server.run({ host: "localhost", port: 8000 })
);
```

##### `GrpcServerBuilder<Ctx, Services>`

Fluent builder interface for constructing gRPC servers.

**Type Parameters:**
- `Ctx` - Context type available to service handlers (defaults to `HandlerContext`)
- `Services` - Union of currently registered service tags

**Methods:**
- `withContextTransformer<Ctx1>(f: (originalCtx: HandlerContext, ctx: Ctx) => Effect.Effect<Ctx1>): GrpcServerBuilder<Ctx1, never>` - Transform the handler context. The first parameter is the original Connect-RPC HandlerContext, the second is the current context (defaults to `any`). Must be called before adding services.
- `withService<S>(service: S): GrpcServerBuilder<Ctx, Services | Tag<S>>` - Add a service (enforces unique tags)
- `build(): GrpcServer<Services>` - Build the server (requires at least one service)

**Example:**
```typescript
// Simple server with HandlerContext
const server = EffectGrpcServer.GrpcServerBuilder()
  .withService(myService)
  .build();

// Server with custom context
interface AppContext {
  userId: string;
  requestId: string;
}

const serverWithCtx = EffectGrpcServer.GrpcServerBuilder()
  // Ctx is any here, so it is okay to omit second param
  .withContextTransformer((handlerCtx: HandlerContext) =>
    Effect.succeed({
      requestId: crypto.randomUUID()
    })
  )
  // Ctx has `requestId` field now, originalCtx is also available
  .withContextTransformer((handlerCtx: HandlerContext, ctx) =>
    Effect.succeed({
      requestId: ctx.requestId,
      userId: handlerCtx.requestHeader.get("user-id") ?? "anonymous",
    })
  )
  .withService(myService)
  .build();
```

#### Factory Functions

##### `GrpcServerBuilder()`

Creates a new server builder instance with default context.

**Returns:** `GrpcServerBuilder<any, never>`

**Example:**
```typescript
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
- `baseUrl: URL` - Base URL for gRPC requests (e.g., `new URL("http://localhost:8000")`)
- `binaryOptions?: Partial<BinaryReadOptions & BinaryWriteOptions>` - Protocol Buffer binary format options
- `acceptCompression?: Compression[]` - Accepted response compression algorithms (defaults to ["gzip", "br"])
- `sendCompression?: Compression` - Compression algorithm for request messages
- `compressMinBytes?: number` - Minimum message size for compression (defaults to 1024 bytes)
- `defaultTimeoutMs?: number` - Default timeout for all requests in milliseconds

**Example:**
```typescript
const config = EffectGrpcClient.GrpcClientConfig({
  baseUrl: new URL("https://api.example.com"),
  defaultTimeoutMs: 5000,
  acceptCompression: ["gzip", "br"],
  sendCompression: "gzip",
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
- `contextValues?: ContextValues` - Connect-RPC context values (e.g., timeout overrides)

**Example:**
```typescript
const meta: EffectGrpcClient.RequestMeta = {
  headers: new Headers({
    "Authorization": "Bearer token123",
    "X-Request-ID": crypto.randomUUID()
  }),
  contextValues: {
    timeout: 3000 // Override default timeout for this request
  }
};

// Use with generated client
const response = yield* client.getUser({ userId: "123" }, meta);
```

#### Factory Functions

##### `liveGrpcClientRuntimeLayer()`

Creates the live implementation layer for `GrpcClientRuntime`.

**Returns:** `Layer.Layer<GrpcClientRuntime>`

**Example:**
```typescript
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
const config = EffectGrpcClient.GrpcClientConfig({
  baseUrl: new URL("http://localhost:8000"),
  defaultTimeoutMs: 5000
});
```

##### `GrpcClientConfig.makeTag(service)`

Creates a Context tag for service-specific configuration.

**Parameters:**
- `service` - Fully-qualified service name

**Returns:** `Context.Tag<GrpcClientConfig<Service>, GrpcClientConfig<Service>>`

**Example:**
```typescript
const UserServiceConfigTag = EffectGrpcClient.GrpcClientConfig.makeTag(
  "com.example.v1.UserService"
);
```

---

### Generated Code API

The `protoc-gen-effect` plugin generates TypeScript code from `.proto` files with Effect integration. This section documents the structure of generated code.

#### Service Implementation (Server-side)

For each service in your `.proto` file, the generator creates:

##### `{ServiceName}ProtoId`

Constant and type for the service identifier.

**Example:**
```typescript
export const UserServiceProtoId = "com.example.v1.UserService" as const;
export type UserServiceProtoId = typeof UserServiceProtoId;
```

##### `{ServiceName}Service<Ctx>`

Interface defining the service implementation contract.

**Type Parameters:**
- `Ctx` - Context type available in method handlers

**Example:**
```typescript
export interface UserServiceService<Ctx = any> {
  getUser(
    request: GetUserRequest,
    ctx: Ctx
  ): Effect.Effect<MessageInitShape<typeof GetUserResponseSchema>, GrpcException>;

  listUsers(
    request: ListUsersRequest,
    ctx: Ctx
  ): Effect.Effect<MessageInitShape<typeof ListUsersResponseSchema>, GrpcException>;
}
```

##### `{ServiceName}ServiceTag`

Context tag for the service. Can be used as-is (default context) or called as a function to create a typed tag.

**Usage:**
```typescript
// Use default tag directly (when not using ctx parameter in implementation)
effectProto.UserServiceTag

// Create typed tag when you need to access ctx parameter
interface AppContext {
  userId: string;
  requestId: string;
}
const UserServiceAppCtxTag = effectProto.UserServiceTag<AppContext>("AppContext");

// With HandlerContext when you need access to request headers
import { HandlerContext } from "@connectrpc/connect";
const UserServiceHandlerCtxTag = effectProto.UserServiceTag<HandlerContext>("HandlerContext");
```

##### `{serviceName}ServiceLiveLayer(tag, service)`

Function that creates a layer from a service implementation.

**Parameters:**
- `tag` - Context tag for the service
- `service` - Implementation of the service interface

**Returns:** `Layer` providing the gRPC service

**Example:**
```typescript
// If not using ctx, use default type and tag
const UserServiceLive: UserServiceService = {
  getUser(request) {
    return Effect.succeed({ user: { id: request.userId, name: "John" } });
  },
  listUsers(request) {
    return Effect.succeed({ users: [] });
  }
};

const userServiceLayer = userServiceLiveLayer(
  effectProto.UserServiceTag,
  UserServiceLive
);

// When you need to access ctx (e.g., HandlerContext for request headers)
import { HandlerContext } from "@connectrpc/connect";

const UserServiceWithCtx: UserServiceService<HandlerContext> = {
  getUser(request, ctx) {
    const authToken = ctx.requestHeader.get("authorization");
    // ... use authToken in your logic
    return Effect.succeed({ user: { id: request.userId, name: "John" } });
  },
  listUsers(request, ctx) {
    return Effect.succeed({ users: [] });
  }
};

const UserServiceHandlerCtxTag = effectProto.UserServiceTag<HandlerContext>("HandlerContext");
const userServiceLayerWithCtx = userServiceLiveLayer(
  UserServiceHandlerCtxTag,
  UserServiceWithCtx
);
```

#### Client Implementation

For each service, the generator also creates client-side types:

##### `{ServiceName}Client<Meta>`

Interface defining the client API.

**Type Parameters:**
- `Meta` - Type of metadata passed with each request

**Example:**
```typescript
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

##### `{ServiceName}ClientTag`

Context tag for the client. Can be used as-is (default metadata) or called as a function to create a typed tag.

**Usage:**
```typescript
// Use default tag directly (any metadata)
effectProto.UserServiceClientTag

// Create typed tag with custom metadata
interface AuthMeta {
  authToken: string;
}
const UserServiceAuthClientTag = effectProto.UserServiceClientTag<AuthMeta>("AuthMeta");
```

##### `{serviceName}ClientLiveLayer(tag)` / `{serviceName}ClientLiveLayer(transformMeta, tag)`

Function that creates a client layer (two overloads).

**Overload 1: With metadata transformation**
```typescript
{serviceName}ClientLiveLayer<Tag extends {ServiceName}ClientTag<Meta>, Meta>(
  transformMeta: (meta: Meta) => EffectGrpcClient.RequestMeta,
  tag: Tag
): Layer.Layer<...>
```

**Overload 2: Default metadata**
```typescript
{serviceName}ClientLiveLayer<Tag extends {ServiceName}ClientTag>(
  tag: Tag
): Layer.Layer<...>
```

**Example:**
```typescript
// With custom metadata transformation
interface AuthMeta {
  authToken: string;
}

const UserServiceAuthClientTag = effectProto.UserServiceClientTag<AuthMeta>("AuthMeta");
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
```

##### `{ServiceName}ConfigTag`

Pre-created config tag for the service.

**Example:**
```typescript
export const UserServiceConfigTag =
  EffectGrpcClient.GrpcClientConfig.makeTag(UserServiceProtoId);

// Use it to provide configuration
const configLayer = Layer.succeed(
  UserServiceConfigTag,
  EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL("http://localhost:8000") })
);
```

## Advanced Usage

### Error Handling with GrpcException

effect-grpc provides `GrpcException`, a typed error that extends Effect's `Data.TaggedError` for handling gRPC errors. All generated service methods return `Effect<Success, GrpcException>`.

```typescript
import { Effect } from "effect";
import { GrpcException } from "@dr_nikson/effect-grpc";
import { Code } from "@connectrpc/connect";

import * as effectProto from "./generated/example/v1/user_effect.js";
import * as proto from "./generated/example/v1/user_pb.js";

// Implement the service with error handling (ctx not used, so use default)
const UserServiceLive: effectProto.UserServiceService = {
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
  }
};
```

**GrpcException API:**
- `GrpcException.create(code, message, cause?)` - Create a new exception
- `GrpcException.from(code, cause)` - Convert any error to GrpcException
- `GrpcException.withDescription(error, desc)` - Add context description

For gRPC status codes and error handling best practices, see [Connect RPC Error Handling](https://connectrpc.com/docs/node/errors).

### Dependency Injection

Leverage Effect's powerful dependency injection to compose your services with external dependencies:

```typescript
import { Context, Effect, Layer } from "effect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";
import * as effectProto from "./generated/user_effect.js";

interface User {
  id: string;
  name: string;
}

// Define a database service tag
class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly getUser: (id: string) => Effect.Effect<User>;
    readonly saveUser: (user: User) => Effect.Effect<void>;
  }
>() {}

// Service implementation class with constructor
class UserServiceLive implements effectProto.UserServiceService {
  constructor(private readonly db: Context.Tag.Service<typeof DatabaseService>) {}

  getUser(request: effectProto.GetUserRequest) {
    return this.db.getUser(request.userId).pipe(
      Effect.map(user => ({ user }))
    );
  }

  updateUser(request: effectProto.UpdateUserRequest) {
    return this.db.saveUser(request.user).pipe(
      Effect.map(() => ({ success: true }))
    );
  }
}

// Wire dependencies through constructor
const userServiceLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const serviceImpl = new UserServiceLive(db);
    return effectProto.userServiceLiveLayer(effectProto.UserServiceTag, serviceImpl);
  })
);

// Create a mock database layer for testing
const mockDatabaseLayer = Layer.succeed(DatabaseService, {
  getUser: (id) => Effect.succeed({ id, name: "Mock User" }),
  saveUser: (_user) => Effect.succeed(void 0)
});

// Compose all layers together
const appLayer = Layer.empty.pipe(
  Layer.provideMerge(mockDatabaseLayer),
  Layer.provideMerge(userServiceLayer)
);

// Build and run your server with all dependencies
const program = Effect.gen(function* () {
  const userService = yield* effectProto.UserServiceTag;

  const server = EffectGrpcServer.GrpcServerBuilder()
    .withService(userService)
    .build();

  return yield* server.run({ host: "localhost", port: 8000 });
}).pipe(
  Effect.provide(appLayer)
);
```

### Request Metadata and Headers

Send custom headers and metadata with requests:

```typescript
const client = yield* HelloClientTag;

const response = yield* client.sayHello(
  { name: "World" },
  {
    headers: new Headers({
      "Authorization": "Bearer your-token",
      "X-Request-ID": "123456"
    }),
    contextValues: {
      timeout: 5000 // 5 second timeout
    }
  }
);
```


## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/dr_nikson/effect-grpc.git
cd effect-grpc

# Install dependencies
pnpm install

# Build all packages
pnpm -r run build

# Run type tests
pnpm -r run test:types
```

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
