# effect-grpc

Type-safe gRPC and Protocol Buffer support for the Effect ecosystem

## Overview

`effect-grpc` provides a seamless integration between gRPC/Protocol Buffers and the Effect TypeScript. It enables you to build type-safe, composable gRPC services and clients with all the benefits of Effect's powerful error handling, dependency injection, and functional programming patterns.

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
const HelloClientTag = effectProto.HelloClient.makeTag<object>("{}");
type HelloClientTag = typeof HelloClientTag;

// Create the client layer
const helloClientLayer = effectProto.HelloClient.liveLayer<object>(() => ({}))(
  HelloClientTag
);

// Use the client
const program = Effect.gen(function* () {
  const client = yield* HelloClientTag;

  const response = yield* client.sayHello({
    name: "World"
  }, {});

  yield* Effect.log(`Server responded: ${response.message}`);
});

// Provide dependencies and run
const dependencies = Layer.empty.pipe(
  Layer.provideMerge(helloClientLayer),
  Layer.provideMerge(EffectGrpcClient.liveGrpcClientLayer()),
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

### Server API

#### `EffectGrpcServer.GrpcServerBuilder`

Creates a new gRPC server builder for composing services.

```typescript
const serverBuilder = EffectGrpcServer.GrpcServerBuilder()
  .withService(service1)
  .withService(service2)
  .build();
```

#### `EffectGrpcServer.GrpcService`

Type definition for a gRPC service that can be registered with the server.

```typescript
type MyService = EffectGrpcServer.GrpcService<
  "my.package.MyService",
  typeof MyServiceDefinition,
  HandlerContext
>;
```

### Client API

#### `EffectGrpcClient.liveGrpcClientLayer`

Creates a live layer implementation for the GrpcClient service.

```typescript
const layer = EffectGrpcClient.liveGrpcClientLayer();
```

#### `EffectGrpcClient.RequestMeta`

Metadata that can be attached to gRPC requests.

```typescript
const meta: EffectGrpcClient.RequestMeta = {
  headers: new Headers({ "Authorization": "Bearer token" }),
};
```

## Advanced Usage

### Error Handling

effect-grpc integrates with Effect's error handling system:

```typescript
const serviceImpl = {
  myMethod(request) {
    return Effect.gen(function* () {
      // Validate input
      if (!request.id) {
        return yield* Effect.fail(new InvalidInputError("ID is required"));
      }

      // Business logic with error handling
      const result = yield* Effect.tryPromise({
        try: () => fetchData(request.id),
        catch: (error) => new DatabaseError("Failed to fetch data", { cause: error })
      });

      return { data: result };
    });
  }
};
```

### Dependency Injection

Leverage Effect's powerful dependency injection:

// TODO: THIS NEEDS TO BE REWROTE

```typescript
// Define a database service
import {Layer} from "effect";

class DatabaseService extends Context.Tag("DatabaseService")<
    DatabaseService,
    {
        readonly getUser: (id: string) => Effect.Effect<User>
    }
>() {
}

// Use it in your gRPC service
class UserServiceLive implements effectProto.UserService<HandlerContext> {
    constructor(readonly db: Context.Service<DatabaseService>) {
    }

    static get layer(): Layer.Layer<effectProto.UserService<HandlerContext>, never, DatabaseService> {
        return Layer.project(
            Layer.service(DatabaseService)
        )
    }

    getUser(request) {
        const {db} = this;

        return Effect.gen(function* () {
            const user = yield* db.getUser(request.userId);
            return user;
        });
    }
};

// Provide the database layer when composing your application
const layer = Layer.empty.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(userServiceLayer)
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

[MIT License](LICENSE)

## Acknowledgments

- [Effect](https://effect.website/) - The core framework this library builds upon
- [Connect-RPC](https://connectrpc.com/) - The modern gRPC implementation
- [Buf](https://buf.build/) - Protocol Buffer tooling
