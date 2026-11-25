# Effect gRPC Coding Standards and Best Practices

## Description
This file defines the set of coding standards which MUST BE respected in EVERY SCENARIO

## Module structure

Each package consists of modules, for example: `packages/effect-grpc` contains module named `server`. Consider the following module structure:
- Module name: `server`
- Public API & Definitions: `server.ts` - should contain only well documented public API
- Implementation: `server.internal.ts` - should contain implementation
- Tests: a module that needs no generated code, such as `grpcException`, has its tests next to it, in `grpcException.test.ts` and `grpcException.test-d.ts`. The tests of `server`, `client` and the code generator drive generated code, so they live in `packages/e2e-tests/src`. See [Tests](#tests).


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


## Data types

1. Absent values use Effect data types such as `Option`, never `null` or `undefined`. Convert a nullable value from Node, connect or another library at that boundary with `Option.fromNullishOr`.


## Object lifecycle

1. Create an object that has state or a lifecycle inside an owner whose lifecycle is known: an instance, a class, a service or a layer. Class instances, clients, propagators and caches are such objects. Never create one when the module loads. An object created at module load is attached to nothing, so its lifecycle is unknown. The operator, in [a review of PR #103](https://github.com/Dr-Nikson/effect-grpc/pull/103#discussion_r4686617213): "This is not attached to anything. So lifecycle is unknown. I'd rather make it a part of some instance\class". Constants stay at module level: literals, lookup tables, regular expressions, pure functions, service tags and layer definitions.


## Tests

1. A test checks a behavior that a user of the library can observe: the value a call returns, the error it fails with, the status a client receives, a log line, a connection that closes. The test fails when that behavior breaks, and it keeps passing when only the internals change. Type-level behavior is behavior too: what compiles, what does not compile, and what the compiler infers for a user's program. A type test that restates a signature with `toEqualTypeOf`, or checks that a property is absent, tests the compiler, not the library. The operator, in [a review of PR #86](https://github.com/Dr-Nikson/effect-grpc/pull/86#discussion_r4686529561): "TESTS SHOULD COVER BEHAVIOUR. TYPE LEVEL BEHAVIOR IS STILL BEHAVIOUR. CHECKING TYPED RETURN TYPE IS NONSENSE." [In the same review](https://github.com/Dr-Nikson/effect-grpc/pull/86#discussion_r4686533676), the operator called `expectTypeOf(server).not.toHaveProperty("run")` "Worthless".
2. A test drives the server and the client through code that `protoc-gen-effect` generates, so it lives in `packages/e2e-tests`, which generates that code from its own protos. Never write a copy of generated code in a test: no hand-built `FileDescriptorProto`, no `serviceDesc` with a hand-written type, no hand-written `GrpcService` implementation. A test built on such a copy keeps passing when the generated code breaks. The operator, in [a review of PR #86](https://github.com/Dr-Nikson/effect-grpc/pull/86#discussion_r4686563003): "Manual creation of generated code is a code smell. This entire test suite tests how good we replicate codegen."
3. A test depends on no implementation detail: not the garbage collector, not a second JS realm, not a custom scheduler, and not a spy on a Node module that the library calls. When the public API and generated code cannot observe a behavior, the behavior gets no test. The operator, in [a comment on PR #86](https://github.com/Dr-Nikson/effect-grpc/pull/86#issuecomment-7144566019): "I'm not sure we need to test gc-related stuff as it TOO BOUND TO IMPLEMENTATION. So we do not test a behavior, we test some implementation details".
4. A server, client, session or socket that a test creates lives in a scope that the test owns, such as the scope of an `it.live` test, so it closes when the test ends. The rule in [Object lifecycle](#object-lifecycle) applies to tests as well.


## Comments and JSDoc

1. Do not remove a comment marked as TODO (`// TODO`) or related to a TODO. The exceptions are a TODO that a tracked issue replaces and a TODO whose work is done. Name the issue in the commit message and the PR description.
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
