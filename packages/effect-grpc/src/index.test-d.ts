// packages/effect-grpc/src/index.test-d.ts
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { expectTypeOf, test } from "vitest";

import type { GenService } from "@bufbuild/protobuf/codegenv2";
import type { EmptySchema } from "@bufbuild/protobuf/wkt";

import { EffectGrpcClient, EffectGrpcServer } from "./index.js";

type PingMethods = {
  ping: { methodKind: "unary"; input: typeof EmptySchema; output: typeof EmptySchema };
};
type AppContext = { userId: string };

const PingServiceId = "example.v1.PingService" as const;

declare const PingService: GenService<PingMethods>;
declare const runtime: EffectGrpcClient.GrpcClientRuntime;
declare const config: EffectGrpcClient.GrpcClientConfig<typeof PingServiceId>;

test("a consumer names every type GrpcService reaches through the package entry point", () => {
  type Service = EffectGrpcServer.GrpcService<
    typeof PingServiceId,
    GenService<PingMethods>,
    AppContext
  >;

  expectTypeOf<Parameters<Service["implementation"]>[0]>().toEqualTypeOf<
    EffectGrpcServer.ServerExecutor<AppContext>
  >();

  const service = EffectGrpcServer.GrpcService(
    PingServiceId,
    PingService,
  )((executor: EffectGrpcServer.ServerExecutor<AppContext>) => ({
    ping: (request, handlerContext): Promise<object> =>
      executor.unary(`${PingServiceId}/Ping`, request, handlerContext, () => Effect.succeed({})),
  }));
  expectTypeOf(service).toEqualTypeOf<Service>();

  const server = EffectGrpcServer.GrpcServerBuilder()
    .withContextTransformer(() => Effect.succeed<AppContext>({ userId: "u1" }))
    .withService(service)
    .build();
  expectTypeOf(server).toEqualTypeOf<EffectGrpcServer.GrpcServer<typeof PingServiceId>>();
});

test("GrpcServerBuilder exposes its builder methods and no internal field", () => {
  expectTypeOf<keyof EffectGrpcServer.GrpcServerBuilder<unknown, never>>().toEqualTypeOf<
    "withContextTransformer" | "withService" | "build"
  >();
});

test("a consumer names the executor GrpcClientRuntime#makeExecutor returns, for a config of one service", () => {
  const executor = runtime.makeExecutor(PingService, ["ping"], config);

  expectTypeOf(executor).toEqualTypeOf<
    Effect.Effect<EffectGrpcClient.ClientExecutor<PingMethods>, never, Scope.Scope>
  >();
});
