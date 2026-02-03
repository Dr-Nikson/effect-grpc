// packages/effect-grpc/src/protoRuntime.internal.ts
import { Cause, Effect, Exit, Option, Runtime } from "effect";
import type { ExternalSpan } from "effect/Tracer";

import { Code, ConnectError } from "@connectrpc/connect";
import type { HandlerContext } from "@connectrpc/connect";
import { Tracer } from "@effect/opentelemetry";
import { ROOT_CONTEXT, type TextMapGetter, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import * as GrpcException from "./grpcException.js";
import type * as T from "./protoRuntime.js";

/**
 * TextMapGetter implementation for extracting trace context from gRPC request headers.
 * This adapter allows OpenTelemetry's propagation API to read from the Headers object.
 */
const headerGetter: TextMapGetter<Headers> = {
  get(carrier: Headers, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier: Headers): string[] {
    return [...carrier.keys()];
  },
};

/**
 * @internal
 * Live implementation of the Executor interface using Effect's ManagedRuntime.
 * Handles the execution of Effect programs within gRPC service handlers.
 */
export class ServerExecutorLive implements T.ServerExecutor<any> {
  constructor(public readonly runtime: Runtime.Runtime<never>) {}

  static make(runtime: Runtime.Runtime<never>): T.ServerExecutor<any> {
    return new ServerExecutorLive(runtime);
  }

  unary<In, Out>(
    method: string,
    req: In,
    ctx: HandlerContext,
    prog: (req: In, ctx: any) => Effect.Effect<Out, GrpcException.GrpcException>,
  ): Promise<Out> {
    const parentSpan = this.extractTraceContext(ctx);

    // Pass undefined as the context since the default is 'any' and no transformation has been applied
    const traced = prog(req, undefined).pipe(
      Effect.annotateLogs({ method, protocol: "gRPC" }),
      Effect.withSpan(method, {
        attributes: { method, protocol: "gRPC" },
        parent: Option.getOrUndefined(parentSpan),
      }),
    );

    return Runtime.runPromiseExit(this.runtime, traced, { signal: ctx.signal }).then(
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

  /**
   * Extract W3C Trace Context from incoming gRPC request headers.
   *
   * Uses OpenTelemetry's W3CTraceContextPropagator to properly parse the `traceparent` and
   * `tracestate` headers according to the W3C Trace Context specification. When valid trace
   * context is found, it creates an ExternalSpan that will be used as the parent for the
   * server-side span, enabling distributed tracing.
   *
   * We use `ROOT_CONTEXT` (not `context.active()`) because:
   * 1. Each incoming gRPC request should start with a fresh context
   * 2. We don't want to inherit any ambient context from the Node.js process
   * 3. The only parent context should come from the incoming request headers
   *
   * We explicitly instantiate W3CTraceContextPropagator rather than using the global
   * `propagation` API because the global propagator registry may not be initialized
   * when using Effect's managed tracing setup.
   *
   * The extracted OTel span context is then converted to Effect's ExternalSpan format
   * so it can be used with Effect's tracing system via `Effect.withSpan({ parent: ... })`.
   *
   * @param ctx - The gRPC handler context containing request headers
   * @returns Option.Some with the extracted ExternalSpan, or Option.None if no valid context
   */
  private extractTraceContext(ctx: HandlerContext): Option.Option<ExternalSpan> {
    const propagator = new W3CTraceContextPropagator();

    // Extract trace context from headers into a fresh ROOT_CONTEXT
    // This ensures we don't inherit any ambient context from the process
    const extractedContext = propagator.extract(ROOT_CONTEXT, ctx.requestHeader, headerGetter);

    // Get the span context from the extracted OTel context and convert to Effect's ExternalSpan
    return Option.fromNullable(trace.getSpanContext(extractedContext)).pipe(
      Option.filter(trace.isSpanContextValid),
      Option.map(Tracer.makeExternalSpan),
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

  static empty(): ServerExecutorTransformerLive<any> {
    return new ServerExecutorTransformerLive((underlying) => underlying);
  }

  transformContext<Ctx1>(
    f: (handlerCtx: HandlerContext) => Effect.Effect<Ctx1, GrpcException.GrpcException>,
  ): ServerExecutorTransformerLive<Ctx1> {
    return new ServerExecutorTransformerLive<Ctx1>((underlying) => {
      return {
        unary<In, Out>(
          method: string,
          req: In,
          handlerCtx: HandlerContext,
          prog: (req: In, ctx: Ctx1) => Effect.Effect<Out, GrpcException.GrpcException>,
        ): Promise<Out> {
          return underlying.unary(method, req, handlerCtx, (req) => {
            return Effect.flatMap(f(handlerCtx), (ctx1) => prog(req, ctx1));
          });
        },
      } as T.ServerExecutor<Ctx1>;
    });
  }
}
