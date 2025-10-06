import { Effect, Runtime } from "effect";

import { HandlerContext } from "@connectrpc/connect";

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
    prog: (req: In, ctx: HandlerContext) => Effect.Effect<Out>,
  ): Promise<Out> {
    return Runtime.runPromise(this.runtime, prog(req, ctx), { signal: ctx.signal });
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
    f: (ctx: Ctx) => Effect.Effect<Ctx1>,
  ): ServerExecutorTransformerLive<Ctx1> {
    return new ServerExecutorTransformerLive<Ctx1>((underlying) => {
      const executor: T.ServerExecutor<Ctx> = this.transformation(underlying);

      return {
        unary<In, Out>(
          req: In,
          ctx: HandlerContext,
          prog: (req: In, ctx: Ctx1) => Effect.Effect<Out>,
        ): Promise<Out> {
          return executor.unary(req, ctx, (req, ctx0) => {
            return Effect.flatMap(f(ctx0), (ctx1) => prog(req, ctx1));
          });
        },
      } as T.ServerExecutor<Ctx1>;
    });
  }
}
