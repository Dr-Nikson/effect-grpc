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

// Create a tag for dependency injection
const HelloServiceTag = effectProto.HelloService.makeTag<HandlerContext>(
  "HandlerContext"
);
type HelloServiceTag = Context.Tag.Identifier<typeof HelloServiceTag>;

// Implement the service
const HelloServiceLive: effectProto.HelloService<HandlerContext> = {
  sayHello(request: proto.HelloRequest) {
    return Effect.succeed({
      message: `Hello, ${request.name}!`
    });
  }
};

// Create the service layer
const helloServiceLayer = effectProto.HelloService.liveLayer(HelloServiceLive)(
  HelloServiceTag
);

// Build and run the gRPC server
const program = Effect.gen(function* () {
  const helloService = yield* HelloServiceTag;

  const server: EffectGrpcServer.GrpcServer<"HelloService"> = 
    EffectGrpcServer
      .GrpcServerBuilder()
      .withService(helloService)
      .build();

  return yield* server.run();
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

// Create a client tag
const HelloServiceClientTag = effectProto.HelloServiceClient.makeTag<object>("{}");
type HelloServiceClientTag = typeof HelloServiceClientTag;

// Create the client layer with configuration
const helloClientLayer = effectProto.HelloServiceClient.liveLayer(
  HelloServiceClientTag
).pipe(
  Layer.provideMerge(
    Layer.succeed(
      effectProto.HelloServiceConfigTag,
      EffectGrpcClient.GrpcClientConfig({
        baseUrl: "http://localhost:8000"
      })
    )
  )
);

// Use the client
const program = Effect.gen(function* () {
  const client = yield* HelloServiceClientTag;

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
- `run(): Effect.Effect<never, never, Scope.Scope>` - Starts the server and returns an Effect that requires a Scope

**Example:**
```typescript
const server: EffectGrpcServer.GrpcServer<"UserService" | "ProductService"> =
  EffectGrpcServer.GrpcServerBuilder()
    .withService(userService)
    .withService(productService)
    .build();

// Run with proper resource management
const program = Effect.scoped(server.run());
```

##### `GrpcServerBuilder<Ctx, Services>`

Fluent builder interface for constructing gRPC servers.

**Type Parameters:**
- `Ctx` - Context type available to service handlers (defaults to `HandlerContext`)
- `Services` - Union of currently registered service tags

**Methods:**
- `withContextTransformer<Ctx1>(f: (ctx: Ctx) => Effect.Effect<Ctx1>): GrpcServerBuilder<Ctx1, never>` - Transform the handler context (must be called before adding services)
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
  .withContextTransformer((handlerCtx: HandlerContext) =>
    Effect.succeed({
      userId: handlerCtx.requestHeader.get("user-id") ?? "anonymous",
      requestId: crypto.randomUUID()
    })
  )
  .withService(myService)
  .build();
```

##### `GrpcService<Tag, Proto, Ctx>`

Represents a gRPC service implementation bound to a specific Protocol Buffer definition.

**Type Parameters:**
- `Tag` - Unique identifier for this service (typically the fully-qualified protobuf name)
- `Proto` - The Protocol Buffer service definition from generated code
- `Ctx` - Context type available to service method handlers

**Note:** Instances are typically created by the `protoc-gen-effect` code generator.

**Example:**
```typescript
// Generated by protoc-gen-effect
const userService: EffectGrpcServer.GrpcService<
  "com.example.UserService",
  typeof UserServiceProto,
  HandlerContext
> = EffectGrpcServer.GrpcService("com.example.UserService", UserServiceProto)(
  (exec) => ({
    getUser: (req, ctx) => exec.unary(req, ctx, (req, ctx) =>
      Effect.succeed({ user: { id: req.userId, name: "John" } })
    )
  })
);
```

#### Factory Functions

##### `GrpcServerBuilder()`

Creates a new server builder instance with default `HandlerContext`.

**Returns:** `GrpcServerBuilder<HandlerContext, never>`

**Example:**
```typescript
const builder = EffectGrpcServer.GrpcServerBuilder();
```

##### `GrpcService(tag, definition)`

Creates a GrpcService factory (typically used by code generators).

**Parameters:**
- `tag` - Unique service identifier
- `definition` - Protocol Buffer service definition

**Returns:** Function that accepts implementation and returns `GrpcService`

**Example:**
```typescript
// This is typically generated, not written manually
const createService = EffectGrpcServer.GrpcService(
  "com.example.MyService",
  MyServiceProto
);

const service = createService<HandlerContext>((exec) => ({
  myMethod: (req, ctx) => exec.unary(req, ctx, (req, ctx) =>
    Effect.succeed({ result: "success" })
  )
}));
```

---

### Client API (`EffectGrpcClient`)

The client API provides tools for making gRPC calls from Effect programs.

#### Core Types

##### `GrpcClientRuntime`

The runtime service that creates executors for invoking gRPC methods.

**Methods:**
- `makeExecutor<Shape>(serviceDefinition, methodNames, config): Effect.Effect<ClientExecutor<Shape>>` - Creates an executor for specified service methods

**Note:** This is primarily used by generated client code, not called directly by users.

**Example:**
```typescript
const program = Effect.gen(function* () {
  const runtime = yield* EffectGrpcClient.GrpcClientRuntime;
  const config = yield* MyServiceConfigTag;

  const executor = yield* runtime.makeExecutor(
    MyServiceProto,
    ["getUser", "listUsers"],
    config
  );

  return executor;
});
```

##### `GrpcClientConfig<Service>`

Configuration for connecting to a gRPC service.

**Type Parameters:**
- `Service` - The fully-qualified service name (e.g., "com.example.v1.UserService")

**Properties:**
- `baseUrl: string` - Base URL for gRPC requests (e.g., "http://localhost:8000")
- `binaryOptions?: Partial<BinaryReadOptions & BinaryWriteOptions>` - Protocol Buffer binary format options
- `acceptCompression?: Compression[]` - Accepted response compression algorithms (defaults to ["gzip", "br"])
- `sendCompression?: Compression` - Compression algorithm for request messages
- `compressMinBytes?: number` - Minimum message size for compression (defaults to 1024 bytes)
- `defaultTimeoutMs?: number` - Default timeout for all requests in milliseconds

**Example:**
```typescript
const config = EffectGrpcClient.GrpcClientConfig({
  baseUrl: "https://api.example.com",
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

#### Context Tags

##### `GrpcClientRuntime`

Tag for accessing the gRPC client runtime service.

**Usage:**
```typescript
const program = Effect.gen(function* () {
  const runtime = yield* EffectGrpcClient.GrpcClientRuntime;
  // runtime is now available
});
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
  baseUrl: "http://localhost:8000",
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

##### `{ServiceName}Id`

Constant and type for the service identifier.

**Example:**
```typescript
export const UserServiceId = "com.example.v1.UserService" as const;
export type UserServiceId = typeof UserServiceId;
```

##### `{ServiceName}Service<Ctx>`

Interface defining the service implementation contract.

**Type Parameters:**
- `Ctx` - Context type available in method handlers

**Example:**
```typescript
export interface UserService<Ctx> {
  getUser(
    request: GetUserRequest,
    ctx: Ctx
  ): Effect.Effect<MessageInitShape<typeof GetUserResponseSchema>>;

  listUsers(
    request: ListUsersRequest,
    ctx: Ctx
  ): Effect.Effect<MessageInitShape<typeof ListUsersResponseSchema>>;
}
```

##### `{ServiceName}Service.makeTag(ctxKey)`

Creates a Context tag for the service.

**Parameters:**
- `ctxKey` - String identifier for the context type (e.g., "HandlerContext")

**Returns:** `Context.Tag<{ServiceName}GrpcService<Ctx>, {ServiceName}GrpcService<Ctx>>`

**Example:**
```typescript
const UserServiceTag = UserService.makeTag<HandlerContext>("HandlerContext");
```

##### `{ServiceName}Service.liveLayer(impl)`

Creates a layer from a service implementation.

**Parameters:**
- `impl` - Implementation of the service interface

**Returns:** Function accepting a tag and returning a `Layer`

**Example:**
```typescript
const UserServiceLive: UserService<HandlerContext> = {
  getUser(request) {
    return Effect.succeed({ user: { id: request.userId, name: "John" } });
  },
  listUsers(request) {
    return Effect.succeed({ users: [] });
  }
};

const UserServiceTag = UserService.makeTag<HandlerContext>("HandlerContext");
const layer = UserService.liveLayer(UserServiceLive)(UserServiceTag);
```

##### `{ServiceName}GrpcService<Ctx>`

Type alias for the complete gRPC service (used with server builder).

**Example:**
```typescript
type UserServiceGrpc = UserServiceGrpcService<HandlerContext>;
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

##### `{ServiceName}Client.makeTag(metaKey)`

Creates a Context tag for the client.

**Parameters:**
- `metaKey` - String identifier for the metadata type

**Returns:** `Context.Tag<{ServiceName}Client<Meta>, {ServiceName}Client<Meta>>`

**Example:**
```typescript
const UserServiceClientTag = UserServiceClient.makeTag<object>("{}");
```

##### `{ServiceName}Client.liveLayer(transformMeta, tag)` / `{ServiceName}Client.liveLayer(tag)`

Creates a layer for the client (two overloads).

**Overload 1: With metadata transformation**
```typescript
liveLayer<Tag extends {ServiceName}ClientTag<Meta>, Meta>(
  transformMeta: (meta: Meta) => EffectGrpcClient.RequestMeta,
  tag: Tag
): Layer.Layer<...>
```

**Overload 2: Default metadata (empty object)**
```typescript
liveLayer<Tag extends {ServiceName}ClientTag<object>>(
  tag: Tag
): Layer.Layer<...>
```

**Example:**
```typescript
// With custom metadata transformation
interface MyMeta {
  authToken: string;
}

const clientLayerWithMeta = UserServiceClient.liveLayer(
  (meta: MyMeta) => ({
    headers: new Headers({ "Authorization": `Bearer ${meta.authToken}` })
  }),
  UserServiceClientTag
).pipe(
  Layer.provideMerge(
    Layer.succeed(UserServiceConfigTag, config)
  )
);

// With default empty metadata
const clientLayer = UserServiceClient.liveLayer(
  UserServiceClientTag
).pipe(
  Layer.provideMerge(
    Layer.succeed(UserServiceConfigTag, config)
  )
);
```

##### `{ServiceName}ConfigTag`

Pre-created config tag for the service.

**Example:**
```typescript
export const UserServiceConfigTag: UserServiceConfigTag =
  EffectGrpcClient.GrpcClientConfig.makeTag(UserServiceId);

// Use it to provide configuration
const configLayer = Layer.succeed(
  UserServiceConfigTag,
  EffectGrpcClient.GrpcClientConfig({ baseUrl: "http://localhost:8000" })
);
```

## Advanced Usage

### Error Handling with GrpcException

effect-grpc provides `GrpcException`, a typed error that extends Effect's `Data.TaggedError` for handling gRPC errors. All generated service methods return `Effect<Success, GrpcException>`.

```typescript
import { Effect } from "effect";
import { HandlerContext } from "@connectrpc/connect";
import { GrpcException } from "@dr_nikson/effect-grpc";
import { Code } from "@connectrpc/connect";

import * as effectProto from "./generated/example/v1/user_effect.js";
import * as proto from "./generated/example/v1/user_pb.js";

// Implement the service with error handling
const UserServiceLive: effectProto.UserService<HandlerContext> = {
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
import { HandlerContext } from "@connectrpc/connect";
import * as effectProto from "./generated/user_effect.js";

// Define a database service tag
class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly getUser: (id: string) => Effect.Effect<User>;
    readonly saveUser: (user: User) => Effect.Effect<void>;
  }
>() {}

// Implement your gRPC service with database dependency
const UserServiceLive: effectProto.UserService<HandlerContext> = {
  getUser(request) {
    return Effect.gen(function* () {
      // Access the database service from context
      const db = yield* DatabaseService;

      // Use it in your business logic
      const user = yield* db.getUser(request.userId);

      return { user };
    });
  },

  updateUser(request) {
    return Effect.gen(function* () {
      const db = yield* DatabaseService;

      yield* db.saveUser(request.user);

      return { success: true };
    });
  }
};

// Create service tag and layer
const UserServiceTag = effectProto.UserService.makeTag<HandlerContext>("HandlerContext");
const userServiceLayer = effectProto.UserService.liveLayer(UserServiceLive)(UserServiceTag);

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
  const userService = yield* UserServiceTag;

  const server = EffectGrpcServer.GrpcServerBuilder()
    .withService(userService)
    .build();

  return yield* server.run();
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
