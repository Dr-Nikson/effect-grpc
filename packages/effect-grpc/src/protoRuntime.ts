import { Effect, ManagedRuntime } from "effect";

import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { GenMessage, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import { HandlerContext } from "@connectrpc/connect";

import * as internal from "./protoRuntime.internal.js";
import { RequestMeta } from "./client.js";

/**
 * Type-safe executor interface for gRPC service methods.
 *
 * Maps gRPC service method shapes to their corresponding executor functions,
 * providing type safety for method calls. Currently, supports unary RPC calls.
 *
 * @example
 * ```typescript
 * import { EffectGrpcClient } from "@dr_nikson/effect-grpc";
 *
 * // This type is usually inferred from service definitions
 * declare const serviceDefinition: GenService<MyServiceMethods>;
 * declare const client: EffectGrpcClient.GrpcClient;
 *
 * const executor = client.makeExecutor(serviceDefinition, ["getGreeting"]);
 * // executor.getGreeting is now type-safe based on the service definition
 * ```
 *
 * @category Client
 * @since 0.2.0
 */
export type ClientExecutor<RuntimeShape extends GenServiceMethods> = {
  [P in keyof RuntimeShape]: RuntimeShape[P] extends (
    { methodKind: "unary"; input: GenMessage<infer In>; output: GenMessage<infer Out> }
  ) ?
    UnaryClientExecutorFn<GenMessage<In>, GenMessage<Out>>
  : "provided methodKind is not yet supported";
};

type UnaryClientExecutorFn<I extends DescMessage, O extends DescMessage> = (
  request: MessageInitShape<I>,
  meta?: RequestMeta,
) => Effect.Effect<MessageShape<O>>;

/**
 * Executor interface that provides methods for executing gRPC service operations within Effect programs.
 * The executor handles the bridge between the gRPC handler context and your custom context type.
 *
 * @template Ctx - The custom context type that will be provided to your service implementations
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { EffectGrpcServer } from "@dr_nikson/effect-grpc"
 *
 * interface AppContext {
 *   db: Database
 *   logger: Logger
 * }
 *
 * const userService = EffectGrpcServer.GrpcService("UserService", UserService)<AppContext>((exec) => ({
 *   // Use executor to run Effect programs
 *   getUser: (req) => exec.unary(req, ctx, (request, appCtx) =>
 *     Effect.gen(function* () {
 *       yield* appCtx.logger.info(`Getting user ${request.userId}`)
 *       const user = yield* appCtx.db.findUser(request.userId)
 *       return { user }
 *     })
 *   ),
 *
 *   // Executor handles errors and context transformation automatically
 *   createUser: (req) => exec.unary(req, ctx, (request, appCtx) =>
 *     Effect.gen(function* () {
 *       const user = yield* appCtx.db.createUser(request.userData)
 *       return { user }
 *     })
 *   )
 * }))
 * ```
 */
export interface ServerExecutor<Ctx> {
  unary<In, Out>(
    req: In,
    ctx: HandlerContext,
    prog: (req: In, ctx: Ctx) => Effect.Effect<Out>,
  ): Promise<Out>;
}
export const ServerExecutor: {
  (runtime: ManagedRuntime.ManagedRuntime<never, never>): ServerExecutor<HandlerContext>;
} = internal.ServerExecutorLive.make;

export interface ServerExecutorTransformer<Ctx> {
  readonly transformation: (underlying: ServerExecutor<HandlerContext>) => ServerExecutor<Ctx>;

  transformContext<Ctx1>(f: (ctx: Ctx) => Effect.Effect<Ctx1>): ServerExecutorTransformer<Ctx1>;
}
export const ServerExecutorTransformer: {
  (): ServerExecutorTransformer<HandlerContext>;
} = internal.ServerExecutorTransformerLive.empty;
