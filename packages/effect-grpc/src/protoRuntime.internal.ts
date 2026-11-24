// packages/effect-grpc/src/protoRuntime.internal.ts
import { Array as Arr, Cause, Context, Effect, Exit, Option, Record } from "effect";
import type { ExternalSpan } from "effect/Tracer";

import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { Code, ConnectError } from "@connectrpc/connect";
import type { HandlerContext } from "@connectrpc/connect";
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
 * The global `propagation` API is not used, because its propagator registry may not be initialized
 * when Effect manages tracing.
 */
const propagator = new W3CTraceContextPropagator();

/**
 * The name the log annotations and the span give each protocol, and its OpenTelemetry `rpc.system`,
 * by `HandlerContext.protocolName`. OpenTelemetry names gRPC-web `grpc` too.
 */
const protocols: Record.ReadonlyRecord<
  string,
  { readonly label: string; readonly rpcSystem: string }
> = {
  grpc: { label: "gRPC", rpcSystem: "grpc" },
  "grpc-web": { label: "gRPC-web", rpcSystem: "grpc" },
  connect: { label: "Connect", rpcSystem: "connect_rpc" },
};

const protocolOf = (protocolName: string) =>
  Record.get(protocols, protocolName).pipe(
    Option.getOrElse(() => ({ label: protocolName, rpcSystem: protocolName })),
  );

/**
 * Connect aborts a call's signal with a `DeadlineExceeded` ConnectError when the call's deadline
 * passes, and with another reason when the client resets or closes the stream.
 */
const abortedCallError = (reason: unknown): ConnectError =>
  reason instanceof ConnectError && reason.code === Code.DeadlineExceeded ?
    new ConnectError("the operation timed out", Code.DeadlineExceeded)
  : new ConnectError("Request was canceled", Code.Canceled);

/**
 * Effect 4 turns each typed failure of a cause into a defect once the cause also holds a defect, as
 * when a finalizer dies, and the failure keeps its place ahead of the finalizer's defect. A cause of
 * defects alone that starts with a GrpcException is such a failure. A lone defect never was one.
 */
const failureTurnedDefect = (
  cause: Cause.Cause<GrpcException.GrpcException>,
): Option.Option<GrpcException.GrpcException> =>
  cause.reasons.length > 1 && cause.reasons.every(Cause.isDieReason) ?
    Arr.head(cause.reasons).pipe(
      Option.map((reason) => reason.defect),
      Option.filter((defect) => defect instanceof GrpcException.GrpcException),
    )
  : Option.none();

/**
 * The status the server sends for a failed call. An interruption caused by the call's deadline or
 * by the client comes first, then the handler's typed failure, then a defect, whose content never
 * reaches the client.
 */
const causeToConnectError = (
  cause: Cause.Cause<GrpcException.GrpcException>,
  signal: AbortSignal,
): ConnectError => {
  if (Cause.hasInterrupts(cause) && signal.aborted) return abortedCallError(signal.reason);
  const failure = Option.orElse(Cause.findErrorOption(cause), () => failureTurnedDefect(cause));
  if (Option.isSome(failure)) return GrpcException.toConnectError(failure.value);
  return Arr.findFirst(cause.reasons, Cause.isDieReason).pipe(
    Option.match({
      onSome: (reason) =>
        new ConnectError(
          "Internal server error",
          Code.Internal,
          undefined,
          undefined,
          reason.defect,
        ),
      onNone: () =>
        Cause.hasInterrupts(cause) ?
          new ConnectError("Request was canceled", Code.Aborted)
        : new ConnectError("Unknown error", Code.Unknown),
    }),
  );
};

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
 * The extracted OTel span context is then converted to Effect's ExternalSpan format
 * so it can be used with Effect's tracing system via `Effect.withSpan({ parent: ... })`.
 *
 * @param ctx - The gRPC handler context containing request headers
 * @returns Option.Some with the extracted ExternalSpan, or Option.None if no valid context
 */
const extractTraceContext = (ctx: HandlerContext): Option.Option<ExternalSpan> =>
  Option.fromNullishOr(
    trace.getSpanContext(propagator.extract(ROOT_CONTEXT, ctx.requestHeader, headerGetter)),
  ).pipe(Option.filter(trace.isSpanContextValid), Option.map(OtelTracer.makeExternalSpan));

/**
 * @internal
 */
export const makeServerExecutor = <Ctx>(
  context: Context.Context<never>,
  transformCtx: (handlerCtx: HandlerContext) => Effect.Effect<Ctx, GrpcException.GrpcException>,
): T.ServerExecutor<Ctx> => ({
  unary<In, Out>(
    method: string,
    req: In,
    handlerCtx: HandlerContext,
    prog: (req: In, ctx: Ctx) => Effect.Effect<Out, GrpcException.GrpcException>,
  ): Promise<Out> {
    const protocol = protocolOf(handlerCtx.protocolName);
    const traced = Effect.flatMap(transformCtx(handlerCtx), (ctx) => prog(req, ctx)).pipe(
      Effect.annotateLogs({ method, protocol: protocol.label }),
      Effect.withSpan(method, {
        kind: "server",
        attributes: {
          "rpc.system": protocol.rpcSystem,
          "rpc.service": handlerCtx.service.typeName,
          "rpc.method": handlerCtx.method.name,
          protocol: protocol.label,
        },
        parent: Option.getOrUndefined(extractTraceContext(handlerCtx)),
      }),
    );

    return Effect.runPromiseExitWith(context)(traced, { signal: handlerCtx.signal }).then(
      Exit.match({
        onFailure: (cause) => {
          throw causeToConnectError(cause, handlerCtx.signal);
        },
        onSuccess: (value) => value,
      }),
    );
  },
});
