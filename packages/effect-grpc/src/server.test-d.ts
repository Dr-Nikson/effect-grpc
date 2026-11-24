// packages/effect-grpc/src/server.test-d.ts
import { Effect, Scope } from "effect";
import { assertType, expectTypeOf, test } from "vitest";

import type { GenService } from "@bufbuild/protobuf/codegenv2";
import type { EmptySchema } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";

import * as Server from "./server.js";

type MixedMethods = {
  unary: { methodKind: "unary"; input: typeof EmptySchema; output: typeof EmptySchema };
  serverStream: {
    methodKind: "server_streaming";
    input: typeof EmptySchema;
    output: typeof EmptySchema;
  };
  clientStream: {
    methodKind: "client_streaming";
    input: typeof EmptySchema;
    output: typeof EmptySchema;
  };
  bidi: { methodKind: "bidi_streaming"; input: typeof EmptySchema; output: typeof EmptySchema };
};
type UnaryMethods = {
  first: { methodKind: "unary"; input: typeof EmptySchema; output: typeof EmptySchema };
  second: { methodKind: "unary"; input: typeof EmptySchema; output: typeof EmptySchema };
};

const MixedServiceId = "example.v1.MixedService" as const;

declare const MixedService: GenService<MixedMethods>;
declare const UnaryService: GenService<UnaryMethods>;
declare const mixedServiceImpl: ServiceImpl<typeof MixedService>;
declare const unaryServiceImpl: ServiceImpl<typeof UnaryService>;

test("GrpcServerBuilder#withService should work correctly", () => {
  const empty = Server.GrpcServerBuilder();

  // Builder starts with unknown context
  assertType<Server.GrpcServerBuilder<unknown, never>>(empty);

  // @ts-expect-error - Empty builder cannot be built
  assertType<Server.GrpcServer>(empty.build());

  // Services with specific context require transformation first
  const builder = empty.withContextTransformer((ctx) => Effect.succeed(ctx));
  assertType<Server.GrpcServerBuilder<HandlerContext, never>>(builder);

  type MyService = Server.GrpcService<"DebugAPI", any, HandlerContext>;

  const service: MyService = null as any;
  const has1Service = builder.withService(service);
  const has1ServiceBuild = has1Service.build();

  assertType<Server.GrpcServerBuilder<HandlerContext, "DebugAPI">>(has1Service);
  assertType<Server.GrpcServer<"DebugAPI">>(has1ServiceBuild);

  // @ts-expect-error - you cannot add the same service twice
  assertType<any>(has1Service.withService(service));

  type MyService2<Ctx = HandlerContext> = Server.GrpcService<"PingPongApi", any, Ctx>;

  const service2: MyService2 = null as any;
  const has2Service = has1Service.withService(service2);

  assertType<Server.GrpcServerBuilder<HandlerContext, "DebugAPI" | "PingPongApi">>(has2Service);

  // @ts-expect-error - you cannot add the same service twice
  assertType<any>(has2Service.withService(service2));

  const service3: MyService2<HandlerContext[]> = null as any;
  // @ts-expect-error - you cannot add the same service twice, even with different context (because the tag is the same)
  assertType<any>(has2Service.withService(service3));

  type MyService4<Ctx = HandlerContext> = Server.GrpcService<"SomeOtherApi", any, Ctx>;
  interface AuthContext {
    authToken: string;
  }

  const service4: MyService4<AuthContext> = null as any;
  // @ts-expect-error - you cannot add service with mismatched context type
  assertType<any>(has2Service.withService(service4));

  type MyService5 = Server.GrpcService<"AnyServiceApi", any, any>;
  const service5: MyService5 = null as any;
  // It is possible to add service with `any` context
  assertType<
    Server.GrpcServerBuilder<HandlerContext, "DebugAPI" | "PingPongApi" | "AnyServiceApi">
  >(has2Service.withService(service5));
});

test("GrpcServerBuilder should enforce context type safety", () => {
  const empty = Server.GrpcServerBuilder();

  // Services with HandlerContext CANNOT be added to unknown-context builder
  type HandlerContextService = Server.GrpcService<"DebugAPI", any, HandlerContext>;
  const service: HandlerContextService = null as any;

  // @ts-expect-error - Cannot add HandlerContext service to unknown-context builder
  empty.withService(service);

  // Services with `any` context CAN be added to unknown-context builder
  type AnyContextService = Server.GrpcService<"AnyApi", any, any>;
  const anyService: AnyContextService = null as any;
  const builderWithAnyService = empty.withService(anyService);
  assertType<Server.GrpcServerBuilder<unknown, "AnyApi">>(builderWithAnyService);
});

test("GrpcServer dependencies should be correctly inferred", () => {
  // Must use withContextTransformer first for HandlerContext services
  const builder = Server.GrpcServerBuilder().withContextTransformer((ctx) => Effect.succeed(ctx));

  type MyService = Server.GrpcService<"DebugAPI", any, HandlerContext>;
  const myService: MyService = null as any;

  type MyOtherService = Server.GrpcService<"HelloWorldAPI", any, HandlerContext>;
  const myService2: MyOtherService = null as any;

  const server1 = builder.withService(myService).build();

  const fun: (server: Server.GrpcServer<"DebugAPI" | "HelloWorldAPI">) => void = null as any;

  // @ts-expect-error - you cannot call `fun` with partially implemented server
  expectTypeOf(fun).toBeCallableWith(server1);

  const server2 = builder.withService(myService).withService(myService2).build();
  const fun2: (server: Server.GrpcServer<"HelloWorldAPI">) => void = null as any;

  // We can use only a subset of the implemented apis
  expectTypeOf(fun2).toBeCallableWith(server2);
  // And we can also use all implemented apis
  expectTypeOf(fun).toBeCallableWith(server2);
});

test("GrpcServer#listen succeeds with the bound address, fails with GrpcServerBindError, needs a Scope", () => {
  const server: Server.GrpcServer<"DebugAPI"> = null as any;

  expectTypeOf(server.listen({ host: "127.0.0.1", port: 0 })).toEqualTypeOf<
    Effect.Effect<Server.GrpcServerAddress, Server.GrpcServerBindError, Scope.Scope>
  >();
  expectTypeOf<Server.GrpcServerBindError["reason"]["_tag"]>().toEqualTypeOf<
    "AddressInUse" | "PermissionDenied" | "InvalidPort" | "Other"
  >();
  expectTypeOf(server).not.toHaveProperty("run");
  expectTypeOf<
    Server.GrpcServerBindError["_tag"]
  >().toEqualTypeOf<"@dr_nikson/effect-grpc/server/GrpcServerBindError">();
});

test("GrpcService takes handlers for the unary methods alone of a service that also has streaming methods", () => {
  const service = Server.GrpcService(
    MixedServiceId,
    MixedService,
  )((executor: Server.ServerExecutor<HandlerContext>) => ({
    unary: (request, handlerContext): Promise<object> =>
      executor.unary(`${MixedServiceId}/Unary`, request, handlerContext, () => Effect.succeed({})),
  }));
  expectTypeOf(service).toEqualTypeOf<
    Server.GrpcService<typeof MixedServiceId, GenService<MixedMethods>, HandlerContext>
  >();

  const server = Server.GrpcServerBuilder()
    .withContextTransformer((ctx) => Effect.succeed(ctx))
    .withService(service)
    .build();
  expectTypeOf(server).toEqualTypeOf<Server.GrpcServer<typeof MixedServiceId>>();
});

test("GrpcService still takes a Connect ServiceImpl that handles every method", () => {
  expectTypeOf(
    Server.GrpcService(MixedServiceId, MixedService)(() => mixedServiceImpl),
  ).toEqualTypeOf<Server.GrpcService<typeof MixedServiceId, GenService<MixedMethods>, unknown>>();
});

test("GrpcService needs a handler for each unary method", () => {
  const mixedService = Server.GrpcService(MixedServiceId, MixedService);
  // @ts-expect-error the unary method has no handler
  mixedService(() => ({}));

  const unaryService = Server.GrpcService("example.v1.UnaryService" as const, UnaryService);
  // @ts-expect-error the unary method second has no handler
  unaryService(() => ({ first: unaryServiceImpl.first }));
});

test("GrpcServiceImplementation refuses a handler for a method the service does not have", () => {
  assertType<Server.GrpcServiceImplementation<typeof MixedService>>({
    unary: mixedServiceImpl.unary,
    // @ts-expect-error the service has no method named other
    other: mixedServiceImpl.unary,
  });
});
