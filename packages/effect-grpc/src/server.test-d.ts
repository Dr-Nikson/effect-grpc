import { assertType, expectTypeOf, test } from "vitest";

import { HandlerContext } from "@connectrpc/connect";

import * as Server from "./server.js";

test("GrpcServerBuilder#withService should work correctly", () => {
  const empty: Server.GrpcServerBuilder<HandlerContext, never> = null as any;

  // @ts-expect-error - Empty builder cannot be built
  assertType<Server.GrpcServer>(empty.build());

  type MyService = Server.GrpcService<"DebugAPI", any, HandlerContext>;

  const service: MyService = null as any;
  const has1Service: Server.GrpcServerBuilder<HandlerContext, "DebugAPI"> =
    empty.withService(service);
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
});

test("GrpcServer dependencies should be correctly interfered", () => {
  type MyService = Server.GrpcService<"DebugAPI", any, HandlerContext>;
  const myService: MyService = null as any;

  type MyOtherService = Server.GrpcService<"HelloWorldAPI", any, HandlerContext>;
  const myService2: MyOtherService = null as any;

  const server1 = Server.GrpcServerBuilder().withService(myService).build();

  const fun: (server: Server.GrpcServer<"DebugAPI" | "HelloWorldAPI">) => void = null as any;

  // @ts-expect-error - you cannot call `fun` with partially implemented server
  expectTypeOf(fun).toBeCallableWith(server1);

  const server2 = Server.GrpcServerBuilder().withService(myService).withService(myService2).build();
  const fun2: (server: Server.GrpcServer<"HelloWorldAPI">) => void = null as any;

  // We can use only a subset of the implemented apis
  expectTypeOf(fun2).toBeCallableWith(server2);
  // And we can also use all implemented apis
  expectTypeOf(fun).toBeCallableWith(server2);
});
