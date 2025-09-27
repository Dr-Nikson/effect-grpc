import { assertType, test } from "vitest";

import { HandlerContext } from "@connectrpc/connect";

import * as Server from "./server";

test("GrpcServerBuilder#withService should work correctly", () => {
  const empty: Server.GrpcServerBuilder<HandlerContext, never> = null as any;

  // @ts-expect-error - Empty builder cannot be built
  assertType<Server.GrpcServer>(empty.build());

  type MyService = Server.GrpcService<"DebugAPI", any, HandlerContext>;

  const service: MyService = null as any;
  const has1Service = empty.withService(service);
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
