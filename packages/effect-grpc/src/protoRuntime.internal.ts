import { Cause, Effect, Exit, Runtime } from "effect";

import { Code, ConnectError } from "@connectrpc/connect";
import type { HandlerContext } from "@connectrpc/connect";

import * as GrpcException from "./grpcException.js";
import type * as T from "./protoRuntime.js";

/**
 * @internal
 * Live implementation of the Executor interface using Effect's ManagedRuntime.
 * Handles the execution of Effect programs within gRPC service handlers.
 */
export class ServerExecutorLive implements T.ServerExecutor<HandlerContext> {
  constructor(public readonly runtime: Runtime.Runtime<never>) {}

  static make(runtime: Runtime.Runtime<never>): T.ServerExecutor<HandlerContext> {
    return new ServerExecutorLive(runtime);
  }

  unary<In, Out>(
    req: In,
    ctx: HandlerContext,
    prog: (req: In, ctx: HandlerContext) => Effect.Effect<Out, GrpcException.GrpcException>,
  ): Promise<Out> {
    return Runtime.runPromiseExit(this.runtime, prog(req, ctx), { signal: ctx.signal }).then(
      Exit.match({
        onFailure: (cause) => {
          throw Cause.match(cause, {
            onEmpty: new ConnectError("Unknown error", Code.Unknown),
            onFail: (error) => GrpcException.toConnectError(error),
            onDie: (defect) =>
              new ConnectError(
                "Internal server error",
                Code.Internal,
                undefined,
                undefined,
                defect,
              ),
            onInterrupt: () => new ConnectError("Request was canceled", Code.Aborted),
            onSequential: (left, right) =>
              new ConnectError(`${left.rawMessage}; ${right.rawMessage}`, Code.Internal),
            onParallel: (left, right) =>
              new ConnectError(`${left.rawMessage} | ${right.rawMessage}`, Code.Internal),
          });
        },
        onSuccess: (value) => value,
      }),
    );
  }
}

/**
 * @internal
 * Transformer class that handles context transformations for executors.
 * Allows chaining context transformations in a type-safe manner.
 */
export class ServerExecutorTransformerLive<Ctx> implements T.ServerExecutorTransformer<Ctx> {
  constructor(
    public readonly transformation: (
      underlying: T.ServerExecutor<HandlerContext>,
    ) => T.ServerExecutor<Ctx>,
  ) {}

  static empty(): ServerExecutorTransformerLive<HandlerContext> {
    return new ServerExecutorTransformerLive((underlying) => underlying);
  }

  transformContext<Ctx1>(
    f: (ctx: Ctx) => Effect.Effect<Ctx1, GrpcException.GrpcException>,
  ): ServerExecutorTransformerLive<Ctx1> {
    return new ServerExecutorTransformerLive<Ctx1>((underlying) => {
      const executor: T.ServerExecutor<Ctx> = this.transformation(underlying);

      return {
        unary<In, Out>(
          req: In,
          ctx: HandlerContext,
          prog: (req: In, ctx: Ctx1) => Effect.Effect<Out, GrpcException.GrpcException>,
        ): Promise<Out> {
          return executor.unary(req, ctx, (req, ctx0) => {
            return Effect.flatMap(f(ctx0), (ctx1) => prog(req, ctx1));
          });
        },
      } as T.ServerExecutor<Ctx1>;
    });
  }
}
