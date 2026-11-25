// packages/effect-grpc/src/client.test-d.ts
import { Context, Effect, Layer, Scope } from "effect";
import { expectTypeOf, test } from "vitest";

import type { Message, MessageInitShape } from "@bufbuild/protobuf";
import type { GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";

import * as Client from "./client.js";

type GreetRequest = Message<"effect_grpc_test.GreetRequest"> & { name: string };
type GreetReply = Message<"effect_grpc_test.GreetReply"> & { greeting: string };
type GreetRequestSchema = GenMessage<GreetRequest>;
type GreetReplySchema = GenMessage<GreetReply>;

type GreeterMethods = {
  greet: { methodKind: "unary"; input: GreetRequestSchema; output: GreetReplySchema };
  greetEveryone: {
    methodKind: "server_streaming";
    input: GreetRequestSchema;
    output: GreetReplySchema;
  };
};
declare const Greeter: GenService<GreeterMethods>;
declare const greeterConfig: Client.GrpcClientConfig<"effect_grpc_test.Greeter">;
declare const otherServiceConfig: Client.GrpcClientConfig<"effect_grpc_test.Other">;
declare const runtime: Client.GrpcClientRuntime;

test("GrpcClientConfig.makeTag gives each service a tag that only a layer for that service accepts", () => {
  type Service1 = "com.example.v1.HelloWorldAPI";
  type Service2 = "com.example.v1.PingPongAPI";

  const Service1ConfigTag = Client.GrpcClientConfig.makeTag(null as any as Service1);
  const Service2ConfigTag = Client.GrpcClientConfig.makeTag(null as any as Service2);

  const liveLayerFn: {
    <
      CfgTag extends Context.Service<
        Client.GrpcClientConfig<"com.example.v1.HelloWorldAPI">,
        Client.GrpcClientConfig<"com.example.v1.HelloWorldAPI">
      >,
    >(
      configTag: CfgTag,
    ): Layer.Layer<Service1, never, CfgTag["Identifier"]>;
  } = null as any;

  expectTypeOf(liveLayerFn).toBeCallableWith(Service1ConfigTag);

  // @ts-expect-error shouldn't be possible to call
  expectTypeOf(liveLayerFn).toBeCallableWith(Service2ConfigTag);
});

test("makeExecutor, called the way generated code calls it, gives one Effect function per unary method", () => {
  const program = Effect.gen(function* () {
    const grpcRuntime = yield* Client.GrpcClientRuntime;
    const executor = yield* grpcRuntime.makeExecutor(Greeter, ["greet"], greeterConfig);

    const withoutMeta = yield* executor.greet({ name: "Ada" });
    const withMeta = yield* executor.greet(
      {},
      { headers: new Headers({ authorization: "Bearer t0k" }) },
    );
    return [withoutMeta, withMeta] as const;
  });

  expectTypeOf(program).toEqualTypeOf<
    Effect.Effect<readonly [GreetReply, GreetReply], never, Client.GrpcClientRuntime | Scope.Scope>
  >();
});

test("an executor method takes the request's init shape and an optional RequestMeta, and has no error channel", () => {
  expectTypeOf<Client.ClientExecutor<GreeterMethods>["greet"]>().toEqualTypeOf<
    (
      request: MessageInitShape<GreetRequestSchema>,
      meta?: Client.RequestMeta,
    ) => Effect.Effect<GreetReply>
  >();
});

test("the executor's type lists every method, whatever methodNames holds, and marks a non-unary one unsupported", () => {
  expectTypeOf(runtime.makeExecutor(Greeter, ["greet"], greeterConfig)).toEqualTypeOf<
    Effect.Effect<Client.ClientExecutor<GreeterMethods>, never, Scope.Scope>
  >();
  expectTypeOf<
    Client.ClientExecutor<GreeterMethods>["greetEveryone"]
  >().toEqualTypeOf<"provided methodKind is not yet supported">();
});

test("makeExecutor refuses a method the service lacks and a request field of the wrong type, and takes another service's config", () => {
  // @ts-expect-error the service has no method greetAll
  runtime.makeExecutor(Greeter, ["greetAll"], greeterConfig);

  Effect.gen(function* () {
    const executor = yield* runtime.makeExecutor(Greeter, ["greet"], greeterConfig);
    // @ts-expect-error name is a string field
    yield* executor.greet({ name: 42 });
  });

  expectTypeOf(runtime.makeExecutor(Greeter, ["greet"], otherServiceConfig)).toEqualTypeOf<
    Effect.Effect<Client.ClientExecutor<GreeterMethods>, never, Scope.Scope>
  >();
});
