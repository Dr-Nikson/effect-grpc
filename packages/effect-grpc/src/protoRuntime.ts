import { Context, Effect } from "effect";

import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { GenMessage, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import type { HandlerContext } from "@connectrpc/connect";

import * as GrpcException from "./grpcException.js";
import * as internal from "./protoRuntime.internal.js";
import type { RequestMeta } from "./client.js";

/**
 * Type-safe executor interface for gRPC service methods.
 *
 * Maps gRPC service method shapes to their corresponding executor functions,
 * providing type safety for method calls. Currently, supports unary RPC calls.
 * Each function fails with `GrpcException` for every failed call: a status the server sent,
 * a transport failure such as a closed port, and a passed deadline.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import { EffectGrpcClient } from "@dr_nikson/effect-grpc";
 *
 * declare const serviceDefinition: GenService<MyServiceMethods>;
 * declare const config: EffectGrpcClient.GrpcClientConfig<"com.example.v1.MyService">;
 *
 * const program = Effect.gen(function* () {
 *   const runtime = yield* EffectGrpcClient.GrpcClientRuntime;
 *   const executor = yield* runtime.makeExecutor(serviceDefinition, ["getGreeting"], config);
 *   // executor.getGreeting is now type-safe based on the service definition
 * });
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
) => Effect.Effect<MessageShape<O>, GrpcException.GrpcException>;

/**
 * Executor interface that provides methods for executing gRPC service operations within Effect programs.
 * The executor handles the bridge between the gRPC handler context and your custom context type.
 * Generated code calls it once for each unary method, and application code rarely calls it directly.
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
 * }
 *
 * const userService = EffectGrpcServer.GrpcService("UserService", UserService)<AppContext>((exec) => ({
 *   // Executor handles errors and context transformation automatically
 *   getUser: (req, handlerCtx) =>
 *     exec.unary("UserService/GetUser", req, handlerCtx, (request, appCtx) =>
 *       Effect.gen(function* () {
 *         const user = yield* appCtx.db.findUser(request.userId)
 *         return { user }
 *       })
 *     )
 * }))
 * ```
 */
export interface ServerExecutor<Ctx> {
  /**
   * Execute a unary gRPC method with automatic tracing and logging.
   *
   * @param method - Fully qualified method name (e.g., "com.example.v1.HelloWorldAPI/GetGreeting")
   * @param req - The incoming request message
   * @param ctx - The gRPC handler context
   * @param prog - The Effect program implementing the method logic
   * @returns Promise resolving to the response message
   */
  unary<In, Out>(
    method: string,
    req: In,
    ctx: HandlerContext,
    prog: (req: In, ctx: Ctx) => Effect.Effect<Out, GrpcException.GrpcException>,
  ): Promise<Out>;
}
/**
 * @internal
 */
export const ServerExecutor: {
  <Ctx>(
    context: Context.Context<never>,
    transformCtx: (handlerCtx: HandlerContext) => Effect.Effect<Ctx, GrpcException.GrpcException>,
  ): ServerExecutor<Ctx>;
} = internal.makeServerExecutor;
