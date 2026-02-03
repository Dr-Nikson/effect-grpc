// packages/effect-grpc/src/client.internal.ts
import { Context, Effect, Either, Layer } from "effect";
import type { Span } from "effect/Tracer";

import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import type { CallOptions, Client, Transport } from "@connectrpc/connect";
import { createClient, createContextValues } from "@connectrpc/connect";
import { Http2SessionManager, createGrpcTransport } from "@connectrpc/connect-node";
import { ROOT_CONTEXT, type TextMapSetter, TraceFlags, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import type * as T from "./client.js";
import * as protoRuntime from "./protoRuntime.js";

/**
 * TextMapSetter implementation for injecting trace context into request headers.
 * This adapter allows OpenTelemetry's propagation API to write to the Headers object.
 */
const headerSetter: TextMapSetter<Headers> = {
  set(carrier: Headers, key: string, value: string): void {
    carrier.set(key, value);
  },
};

export const grpcClientRuntimeTypeId = Symbol("@dr_nikson/effect-grpc/GrpcClientRuntime");

export const grpcClientRuntimeTag = Context.GenericTag<T.GrpcClientRuntime, T.GrpcClientRuntime>(
  grpcClientRuntimeTypeId.toString(),
);

/**
 * @internal
 * Creates a managed HTTP/2 session manager as an Effect resource.
 * The session manager is automatically aborted when the scope closes.
 * This is important because otherwise we might stuck waiting for the connections to timeout
 */
function createManagedSessionManager(config: T.GrpcClientConfig<any>) {
  return Effect.acquireRelease(
    Effect.sync(
      () => new Http2SessionManager(config.baseUrl, config.pingOptions, config.http2SessionOptions),
    ),
    (sessionManager) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("ManagedSessionManager is being released...");

        return yield* Effect.sync(() => sessionManager.abort());
      }),
  );
}

export function liveGrpcClientRuntime(): Layer.Layer<T.GrpcClientRuntime> {
  const instance: T.GrpcClientRuntime = {
    Type: grpcClientRuntimeTypeId,

    makeExecutor<Shape extends GenServiceMethods>(
      serviceDefinition: GenService<Shape>,
      methodNames: ReadonlyArray<keyof GenService<Shape>["method"]>,
      config: T.GrpcClientConfig<any>,
    ) {
      return Effect.gen(function* () {
        // Create managed HTTP/2 session manager as a resource
        // This will be released when the scope closes
        const sessionManager = yield* createManagedSessionManager(config);

        // Build transport options
        const transportOptions = {
          httpVersion: "2" as const,
          baseUrl: config.baseUrl.toString(),
          sessionManager,
          ...(config.binaryOptions && { binaryOptions: config.binaryOptions }),
          ...(config.acceptCompression && { acceptCompression: config.acceptCompression }),
          ...(config.sendCompression && { sendCompression: config.sendCompression }),
          ...(config.compressMinBytes && { compressMinBytes: config.compressMinBytes }),
          ...(config.defaultTimeoutMs && { defaultTimeoutMs: config.defaultTimeoutMs }),
        };

        // Create transport with the managed session manager
        const transport: Transport = yield* Effect.sync(() =>
          createGrpcTransport(transportOptions),
        );

        // Create the client
        const client: Client<GenService<Shape>> = createClient(serviceDefinition, transport);

        // Build executor methods
        const executor: protoRuntime.ClientExecutor<Shape> = methodNames.reduce(
          (acc, methodName) => {
            const method = makeExecutorMethod(client, methodName, serviceDefinition);

            return method === null ? acc : { ...acc, [methodName]: method };
          },
          {} as any,
        );

        return executor;
      });
    },
  };

  return Layer.succeed(grpcClientRuntimeTag, instance);
}

type UnaryFn<I extends DescMessage, O extends DescMessage> = (
  request: MessageInitShape<I>,
  options: CallOptions,
) => Promise<MessageShape<O>>;

/**
 * @internal
 * Inject trace context into request headers (pure function).
 *
 * Uses OpenTelemetry's W3CTraceContextPropagator to properly format and inject the
 * `traceparent` and `tracestate` headers according to the W3C Trace Context specification.
 *
 * @param span - The current Effect span to extract trace context from
 * @param headers - The original headers to copy and augment
 * @returns New Headers object with trace context injected, preserving original headers
 */
function injectTraceContext(span: Span, headers: Headers): Headers {
  return Either.try(() => {
    // Copy existing headers to preserve user-provided headers (auth tokens, etc.)
    // new Headers(headers) copies all entries from the source Headers object
    const newHeaders = new Headers(headers);

    // Create an OTel SpanContext from the Effect span
    const spanContext = {
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: span.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
      // isRemote indicates whether the span context was received from a remote service.
      // Here it's false because this span was created locally in the client process.
      // (Server-side extraction from incoming headers would set isRemote: true)
      isRemote: false,
    };

    // Inject trace context headers (traceparent, tracestate) into the copied headers
    const propagator = new W3CTraceContextPropagator();
    const otelContext = trace.setSpanContext(ROOT_CONTEXT, spanContext);
    propagator.inject(otelContext, newHeaders, headerSetter);

    return newHeaders;
  }).pipe(Either.getOrElse(() => headers));
}

function makeExecutorMethod<Shape extends GenServiceMethods>(
  client: Client<GenService<Shape>>,
  methodName: keyof GenService<Shape>["method"],
  serviceDefinition: GenService<Shape>,
) {
  const method = serviceDefinition.method[methodName];
  // Build span name following gRPC convention: {service}/{method}
  const fullMethodName = `${serviceDefinition.typeName}/${method.name}`;

  switch (method.methodKind) {
    case "unary":
      // Use Effect.fn to create a client-side span for each RPC call.
      // This provides visibility into client-side latency separate from server processing time.
      return Effect.fn(`GrpcClient.makeUnaryRequest(${fullMethodName})`, {
        attributes: {
          "rpc.system": "grpc",
          "rpc.service": serviceDefinition.typeName,
          "rpc.method": method.name,
        },
      })(function* (req: any, opts: T.RequestMeta) {
        const baseHeaders = opts.headers ?? new Headers();
        const headers = yield* Effect.currentSpan.pipe(
          Effect.map((span) => injectTraceContext(span, baseHeaders)),
          Effect.catchAll(() => Effect.succeed(baseHeaders)),
        );

        return yield* Effect.promise((signal) => {
          const clientMethod = client[methodName].bind(client) as UnaryFn<any, any>;

          return clientMethod(req, {
            // timeoutMs: null,
            headers,
            signal,
            // onHeader: null,
            // onTrailer: null,
            contextValues: createContextValues(),
          } as CallOptions);
        });
      });

    default:
      return null;
  }
}

export function makeGrpcClientConfigTag<Service extends string>(service: Service) {
  return Context.GenericTag<T.GrpcClientConfig<Service>, T.GrpcClientConfig<Service>>(
    `@dr_nikson/effect-grpc/GrpcClientConfig<${service}>`,
  );
}

export function makeGrpcClientConfig<Service extends string>(
  opts: Omit<T.GrpcClientConfig<Service>, "_Service">,
) {
  return {
    ...opts,
    _Service: () => void 0,
  } as T.GrpcClientConfig<Service>;
}
