# Effect gRPC Coding Standards and Best Practices

## Description
This file defines the set of coding standards which MUST BE respected in EVERY SCENARIO

## Module structure

Each package consists of modules, for example: `packages/effect-grpc` contains module named `server`. Consider the following module structure:
- Module name: `server`
- Public API & Definitions: `server.ts` - should contain only well documented public API
- Implementation: `server.internal.ts` - should contain implementation
- Type-tests: `server.test-d.ts` - should contain type tests for public API using vitest
- Tests: `server.test.ts` - should contain tests for module using vitest


### Public API & Definitions

1. Always import implementation as outlined below:
    ```typescript
   import * as internal from "./server.internal.js";
   ```
2. Format type signatures for public member consistently using this structure:
    ```typescript
    /**
     * Description and examples
     * 
     * @example
     * // example goes here
     *
     * @category {category name}
     * @since {next version from package JSON}
     */
    export const createClient: {
      (config: ClientConfig): EffectGrpcClient; // type signature
    } = internal.createClientImpl; // reference to the internal implementation
    ```

3.


## Imports

1. Within the package use relative imports with namespaces when importing another modules:
    ```typescript
    import * as Client from "./client.js";
    import * as Server from "./server.js";
    ```
2. Use explicit file extensions (`.js` for imports, even when importing `.ts` files after compilation)


## Comments and JSDoc

1. Do not remove any comments marked as TODO (`// TODO`) or related to TODO's
2. For the internal implementation ALWAYS put necessary meaningful comments, avoiding obvious ones  

### @example - examples in JSDoc

1. Always add necessary imports considering the example as a user code (packages installed via npm)
    ```typescript
    // Use
    import { EffectGrpcClient } from "@dr_nikson/effect-grpc";
    // Instead of 
    import * as Client from "../../effect-grpc/src/server.js"; // this is wrong
    ```
2. Consider just declaring required dependencies if it is not necessary for current example:
    ```typescript
    // Bad example
    interface HelloWorldAPIService<Ctx> {
        getGreeting(request: GetGreetingRequest, ctx: Ctx): Effect.Effect<MessageInitShape<typeof GetGreetingResponseSchema>>;
    }
    
    type HelloWorldAPIGrpcService<Ctx = HandlerContext> = EffectGrpcServer.GrpcService<"com.example.v1.HelloWorldAPI", typeof HelloWorldAPI, Ctx>
    
    const service: HelloWorldAPIGrpcService = EffectGrpcServer.GrpcService("com.example.v1.HelloWorldAPI" as const, HelloWorldAPI)(
        (executor) => ({
            getGreeting: (req, ctx) => executor.unary(req, ctx, (req, ctx) => service.getGreeting(req, ctx)),
        })
    );
    
    const serviceBuilder: Server.GrpcServerBuilder<HandlerContext, "com.example.v1.HelloWorldAPI"> =
        empty.withService(service)
    ```
    instead of the following:
    ```typescript
    // Good
    type HelloWorldAPIGrpcService<Ctx = HandlerContext> = EffectGrpcServer.GrpcService<"com.example.v1.HelloWorldAPI", typeof HelloWorldAPI, Ctx>
    
    declare const service: HelloWorldAPIGrpcService;
    
    const serviceBuilder: Server.GrpcServerBuilder<HandlerContext, "com.example.v1.HelloWorldAPI"> =
        empty.withService(service)
    ```
