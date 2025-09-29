import { Effect, Scope, Types } from "effect";

import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import { HandlerContext, ServiceImpl } from "@connectrpc/connect";

import * as internal from "./server.internal.js";

export interface GrpcServer<in Services> {
  readonly _Services: Types.Contravariant<Services>;

  run(): Effect.Effect<never, never, Scope.Scope>;
}
// export const GrpcServer: {
//   <Services, Ctx>(
//     services: Record<string & Services, GrpcService<any, any, Ctx>>,
//     transformation: (executor: Executor<HandlerContext>) => Executor<Ctx>,
//   ): GrpcServer<Services>;
// } = null as any;

export type ConcatServiceTags<S extends GrpcService<any, any, any>, Services> =
  S extends GrpcService<infer Tag, any, any>
    ? [Services] extends [never] ? Tag : Tag | Services
    : never; // This should never be the case

export type UniqueTag<S extends GrpcService<any, any, any>, Services> =
  S extends GrpcService<infer Tag, any, any>
    ? [Services] extends [never]
      ? S // If Services === never => we allow S with any Tag
      : Tag extends Services ? never : S // We do not allow S with Tag which is already present in Services
    : never; // This should never be the case

export interface GrpcServerBuilder<Ctx, Services> {
  readonly transformCtx: (ctx: HandlerContext) => Effect.Effect<Ctx>;
  readonly services: Record<string & Services, GrpcService<any, any, Ctx>>;

  withContextTransformer<This extends GrpcServerBuilder<Ctx, Services>, Ctx1>(
    this: [Services] extends [never] ? This : never,
    f: (ctx: Ctx) => Effect.Effect<Ctx1>,
  ): GrpcServerBuilder<Ctx1, never>;

  withService<S extends GrpcService<any, any, Ctx>>(
    service: UniqueTag<S, Services>,
  ): GrpcServerBuilder<Ctx, ConcatServiceTags<S, Services>>;

  build<This extends GrpcServerBuilder<Ctx, Services>>(
    this: [Services] extends [never] ? never : This,
  ): GrpcServer<Services>;
}
export const GrpcServerBuilder: {
  (): GrpcServerBuilder<HandlerContext, never>;
} = () => internal.ConnectEsGprcServerBuilder.empty;

export type GrpcServiceTypeId = typeof internal.grpcServiceTypeId;

export interface GrpcService<Tag, Proto extends GenService<any>, Ctx> {
  readonly Type: GrpcServiceTypeId;
  // readonly _Tag: Types.Invariant<Tag>
  readonly _Tag: Tag;
  readonly _Ctx: Types.Invariant<Ctx>;

  readonly definition: Proto;

  implementation(executor: Executor<Ctx>): ServiceImpl<Proto>;
}
export const GrpcService: {
  <Tag, Proto extends GenService<RuntimeShape>, RuntimeShape extends GenServiceMethods>(
    tag: Tag,
    definition: Proto,
  ): <Ctx>(
    implementation: (exec: Executor<Ctx>) => ServiceImpl<Proto>,
  ) => GrpcService<Tag, Proto, Ctx>;
} = internal.makeGrpcService;

export interface Executor<Ctx> {
  unary<In, Out>(
    req: In,
    ctx: HandlerContext,
    prog: (req: In, ctx: Ctx) => Effect.Effect<Out>,
  ): Promise<Out>;
}
