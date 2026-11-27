// packages/effect-grpc/src/index.test-d.ts
import { Effect } from "effect";
import { assertType, test } from "vitest";

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
  const service = EffectGrpcServer.GrpcService(
    PingServiceId,
    PingService,
  )((executor: EffectGrpcServer.ServerExecutor<AppContext>) => ({
    ping: (request, handlerContext): Promise<object> =>
      executor.unary(`${PingServiceId}/Ping`, request, handlerContext, () => Effect.succeed({})),
  }));

  EffectGrpcServer.GrpcServerBuilder()
    .withContextTransformer(() => Effect.succeed<AppContext>({ userId: "u1" }))
    .withService(service)
    .build();
});

test("GrpcServerBuilder exposes no internal field", () => {
  const builder = EffectGrpcServer.GrpcServerBuilder();

  // @ts-expect-error - transformCtx is an implementation field
  assertType(builder.transformCtx);
  // @ts-expect-error - services is an implementation field
  assertType(builder.services);
});

test("GrpcClientRuntime#makeExecutor takes the config of one service", () => {
  runtime.makeExecutor(PingService, ["ping"], config);
});
