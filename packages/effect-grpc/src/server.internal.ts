// packages/effect-grpc/src/server.internal.ts
import { Cause, Effect, Option, Predicate, Scope, Types } from "effect";
import http2 from "node:http2";

import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import type {
  ConnectRouter,
  ContextValues,
  HandlerContext,
  ServiceImpl,
} from "@connectrpc/connect";
import { Code, createContextValues } from "@connectrpc/connect";
import type { ConnectNodeAdapterOptions } from "@connectrpc/connect-node";
import { connectNodeAdapter } from "@connectrpc/connect-node";

import * as GrpcException from "./grpcException.js";
import * as ProtoRuntime from "./protoRuntime.js";
import * as T from "./server.js";

/**
 * @internal
 */
export const grpcServiceTypeId = Symbol("@dr_nikson/effect-grpc/GrpcService");

/**
 * @internal
 * Internal implementation for creating GrpcService instances.
 * Used by the public GrpcService constructor in the main API.
 */
export function makeGrpcService<
  Tag,
  Proto extends GenService<RuntimeShape>,
  RuntimeShape extends GenServiceMethods,
>(tag: Tag, definition: Proto) {
  return <Ctx>(implementation: (exec: ProtoRuntime.ServerExecutor<Ctx>) => ServiceImpl<Proto>) => {
    return {
      Type: grpcServiceTypeId,
      _Tag: tag,
      _Ctx: null as any,

      implementation,
      definition,
    } as T.GrpcService<Tag, Proto, Ctx>;
  };
}

const grpcDefaultMaxReceiveMessageBytes = 4 * 1024 * 1024;

/** Connect accepts no larger value. */
const largestReadMaxBytes = 0xffffffff;

type RequestListener = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void;

/**
 * Node's HTTP/2 client strips the brackets from an IPv6 literal when it builds `:authority`, so it
 * sends `::1:8000` for `http://[::1]:8000`. `::1:8000` is also a complete IPv6 address, but a
 * valid authority must bracket an IPv6 address, and Node's client always appends the port.
 */
const readAuthority = (authority: string): Option.Option<string> =>
  URL.canParse(`http://${authority}`) ?
    Option.some(authority)
  : Option.liftPredicate(authority.replace(/^(.+):(\d+)$/, "[$1]:$2"), (bracketed) =>
      URL.canParse(`http://${bracketed}`),
    );

/**
 * A gRPC or gRPC-web client reads the status from an HTTP 200 response. connect-go clients, buf
 * curl among them, also reject a content type that names a codec other than the request's, so the
 * reply echoes it.
 */
const refuseMalformedAuthority = (
  req: http2.Http2ServerRequest,
  res: http2.Http2ServerResponse,
): void => {
  const message = "malformed request authority";
  const grpc = Option.fromNullable(req.headers["content-type"]).pipe(
    Option.filter((contentType) =>
      /^application\/grpc(?:-web(?:-text)?)?(?:\+(?:json(?:; ?charset=utf-?8)?|proto))?$/i.test(
        contentType,
      ),
    ),
  );
  if (Option.isSome(grpc)) {
    // Headers set before end() leave in one HEADERS frame that ends the stream, which is a gRPC
    // trailers-only response. writeHead() would send them without END_STREAM.
    res.statusCode = 200;
    res.setHeader("content-type", grpc.value);
    res.setHeader("grpc-status", String(Code.InvalidArgument));
    res.setHeader("grpc-message", encodeURIComponent(message));
    res.end();
    return;
  }
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ code: "invalid_argument", message }));
};

/**
 * connect-node stops reading a request it refuses or answers before the request ends. The client
 * then keeps sending, and Node keeps the stream until its request is read to the end, so graceful
 * shutdown waits for it. Once the response's END_STREAM has been serialized, RFC 9113 section 8.1
 * lets the server reset the request with NO_ERROR, and destroying the stream releases it. Node has
 * no event for that moment, and destroying the stream earlier drops the response.
 */
const closeUnreadRequest = (stream: http2.ServerHttp2Stream): void => {
  if (stream.destroyed) return;
  const { localClose, state } = stream.state;
  if (localClose === 1) {
    stream.close(http2.constants.NGHTTP2_NO_ERROR);
  } else if (state !== http2.constants.NGHTTP2_STREAM_STATE_IDLE) {
    // Node reports a stream that nghttp2 has already freed, because both sides ended, as idle.
    setTimeout(closeUnreadRequest, 100, stream);
    return;
  }
  stream.destroy();
};

/**
 * connect-node builds each request's URL from its authority synchronously inside the listener, and
 * Node turns a throw there into an uncaught exception that stops the process.
 */
const makeRequestListener = (
  options: Pick<ConnectNodeAdapterOptions, "routes" | "interceptors" | "contextValues"> & {
    readonly readMaxBytes: number;
  },
): RequestListener => {
  const handler = connectNodeAdapter(options);
  return (req, res) => {
    res.stream.once("finish", () => {
      if (!res.stream.readableEnded) setTimeout(closeUnreadRequest, 10, res.stream);
    });
    try {
      const authority = readAuthority(req.authority);
      if (Option.isNone(authority)) {
        refuseMalformedAuthority(req, res);
        return;
      }
      // Connect reads req.authority, and Node's getter returns this header first.
      if (authority.value !== req.authority) req.headers[":authority"] = authority.value;
      handler(req, res);
    } catch {
      res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    }
  };
};

type ListenOptions = Parameters<T.GrpcServer<unknown>["listen"]>[0];

const authorityOf = (host: string, port: number): string =>
  `${host.includes(":") ? `[${host}]` : host}:${port}`;

const bindReasons: Partial<Record<string, T.GrpcServerBindError["reason"]>> = {
  EADDRINUSE: { _tag: "AddressInUse" },
  EACCES: { _tag: "PermissionDenied" },
  EPERM: { _tag: "PermissionDenied" },
  ERR_SOCKET_BAD_PORT: { _tag: "InvalidPort" },
};

/**
 * `instanceof Error` is false for Node's own errors when the library runs in another realm, as under
 * Jest or Vitest's VM pools, so this and `bindErrorMessage` read the cause's fields as properties.
 */
const bindError = (options: ListenOptions, cause: unknown): T.GrpcServerBindError => {
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  return new T.GrpcServerBindError({
    host: options.host,
    port: options.port,
    reason: (typeof code === "string" && bindReasons[code]) || { _tag: "Other" },
    cause,
  });
};

/**
 * @internal
 */
export const bindErrorMessage = (error: T.GrpcServerBindError): string => {
  const detail =
    Predicate.hasProperty(error.cause, "message") && typeof error.cause.message === "string" ?
      error.cause.message
    : String(error.cause);
  return `gRPC server could not listen on ${authorityOf(error.host, error.port)} (${error.reason._tag}): ${detail}`;
};

const boundAddress = (server: http2.Http2Server): Effect.Effect<T.GrpcServerAddress> => {
  const address = server.address();
  return address !== null && typeof address === "object" ?
      Effect.succeed({
        host: address.address,
        port: address.port,
        url: `http://${authorityOf(address.address, address.port)}`,
      })
    : Effect.dieMessage(`the gRPC server listens on ${String(address)}, not on a TCP port`);
};

/**
 * Listens outside the acquire step of the server's acquireRelease, so interruption can stop a listen
 * that never completes. Closing the server makes Node drop a pending host lookup instead of binding.
 */
const awaitListening = (
  server: http2.Http2Server,
  options: ListenOptions,
): Effect.Effect<T.GrpcServerAddress, T.GrpcServerBindError> =>
  Effect.async((resume) => {
    function detach() {
      server
        .off("listening", onListening)
        .off("error", onError)
        .off("close", onClosedBeforeListening);
    }
    function settle(outcome: Effect.Effect<T.GrpcServerAddress, T.GrpcServerBindError>) {
      detach();
      resume(outcome);
    }
    function onListening() {
      settle(boundAddress(server));
    }
    function onError(cause: Error) {
      settle(Effect.fail(bindError(options, cause)));
    }
    function onClosedBeforeListening() {
      settle(Effect.interrupt);
    }

    server
      .once("listening", onListening)
      .once("error", onError)
      .once("close", onClosedBeforeListening);
    try {
      server.listen({ host: options.host, port: options.port });
    } catch (cause) {
      settle(Effect.fail(bindError(options, cause)));
    }
    return Effect.sync(() => {
      detach();
      server.close();
    });
  });

const stopServer = (server: http2.Http2Server): Effect.Effect<unknown> =>
  server.listening ?
    Effect.gen(function* () {
      yield* Effect.logInfo("gRPC server is stopping...");

      yield* Effect.async((resume) => {
        server.close(() => resume(Effect.logInfo("gRPC server stopped")));
      });
    })
  : Effect.sync(() => server.close());

/**
 * @internal
 * Live implementation of the GrpcServer interface.
 * Manages the HTTP/2 server and routes gRPC requests to registered services.
 */
class EffectGrpcServerLive<in Services, Ctx> implements T.GrpcServer<Services> {
  constructor(
    public readonly services: Record<string & Services, T.GrpcService<any, any, Ctx>>,
    public readonly transformation: (
      executor: ProtoRuntime.ServerExecutor<HandlerContext>,
    ) => ProtoRuntime.ServerExecutor<Ctx>,
    public readonly readMaxBytes: number,
  ) {}

  readonly _Services: Types.Contravariant<Services> = (a) => a;

  listen(
    options: ListenOptions,
  ): Effect.Effect<T.GrpcServerAddress, T.GrpcServerBindError, Scope.Scope> {
    const routes = this.routes.bind(this);
    const makeExecutor = this.makeExecutor.bind(this);
    const { readMaxBytes } = this;

    return Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const handler = yield* Effect.sync(() =>
        makeRequestListener({
          routes: routes(executor),
          interceptors: [],
          readMaxBytes,
          contextValues(req): ContextValues {
            // TODO: implement proper request transformations
            console.log("Creating context values for request", req.url);

            return createContextValues();
          },
        }),
      );

      // TODO: CORS?
      // const corsHandler = cors({
      //     // Reflects the request origin. This should only be used for development.
      //     // Production should explicitly specify an origin
      //     origin: true,
      //     methods: [...connectCors.allowedMethods],
      //     allowedHeaders: [...connectCors.allowedHeaders],
      //     exposedHeaders: [...connectCors.exposedHeaders],
      // })
      const createServer = Effect.sync(() =>
        http2
          .createServer(handler)
          .addListener("connect", (req, socket, head) => {
            console.log("Connected to server", req.url, socket, head);
          })
          .addListener("connection", (socket) => {
            console.log("New TCP connection:", socket.remoteAddress, socket.remotePort);

            // Track when TCP socket closes
            socket.on("close", (hadError: boolean) => {
              console.log(
                "TCP connection closed:",
                socket.remoteAddress,
                socket.remotePort,
                hadError ? "(with error)" : "(clean)",
              );
            });

            // Track socket errors
            socket.on("error", (err: Error) => {
              console.error("TCP socket error:", socket.remoteAddress, err);
            });
          })
          .addListener("sessionError", (err) => {
            console.error("Session Error", err);
          })
          .addListener("session", (session) => {
            console.log("New HTTP/2 session created");

            // Track when session closes
            session.on("close", () => {
              console.log("HTTP/2 session closed");
            });

            // Track session errors
            session.on("error", (err) => {
              console.error("HTTP/2 session error:", err);
            });

            // Track when session is going away
            session.on("goaway", (errorCode, lastStreamID) => {
              console.log("HTTP/2 session GOAWAY:", { errorCode, lastStreamID });
            });

            // Track individual streams (requests)
            session.on("stream", (stream, headers) => {
              console.log("New stream on session:", headers[":path"]);

              stream.on("close", () => {
                console.log("Stream closed:", headers[":path"]);
              });
            });
          })
          .addListener("error", (err) => {
            console.error("Server error", err);
          })
          .addListener("clientError", (err) => {
            console.error("Client error", err);
          })
          .addListener("dropRequest", (req, socket) => {
            console.warn("Dropped request", req.url, socket);
          }),
      );

      const server = yield* Effect.acquireRelease(createServer, stopServer);
      const address = yield* awaitListening(server, options);
      yield* Effect.logInfo(`gRPC server listening on ${address.url}`);

      return address;
    });
  }

  private routes(executor: ProtoRuntime.ServerExecutor<Ctx>): (router: ConnectRouter) => void {
    const allServices: T.GrpcService<any, any, Ctx>[] = Object.values(this.services);

    return (router: ConnectRouter) => {
      for (const service of allServices) {
        router.service(service.definition, service.implementation(executor));
      }
    };
  }

  private makeExecutor(): Effect.Effect<ProtoRuntime.ServerExecutor<Ctx>> {
    const { transformation } = this;

    return Effect.gen(function* () {
      const runtime = yield* Effect.runtime();
      const basicExecutor = ProtoRuntime.ServerExecutor(runtime);
      const transformedExecutor = transformation(basicExecutor);

      return transformedExecutor;
    });
  }
}

/**
 * @internal
 * Internal implementation of the GrpcServerBuilder interface.
 * Provides the fluent API for building gRPC servers with context transformation.
 */
export class ConnectEsGprcServerBuilder<Ctx, Services>
  implements T.GrpcServerBuilder<Ctx, Services>
{
  constructor(
    public readonly transformCtx: (
      handlerCtx: HandlerContext,
    ) => Effect.Effect<Ctx, GrpcException.GrpcException>,
    public readonly services: Record<string, T.GrpcService<any, any, Ctx>>,
  ) {}

  static get empty(): T.GrpcServerBuilder<unknown, never> {
    return new ConnectEsGprcServerBuilder<unknown, never>(() => Effect.succeed(undefined), {});
  }

  withContextTransformer<This extends T.GrpcServerBuilder<Ctx, Services>, Ctx1>(
    this: This,
    f: (originalCtx: HandlerContext, ctx: Ctx) => Effect.Effect<Ctx1, GrpcException.GrpcException>,
  ): T.GrpcServerBuilder<Ctx1, never> {
    return new ConnectEsGprcServerBuilder<Ctx1, never>(
      (handlerCtx) =>
        Effect.flatMap(this.transformCtx(handlerCtx), (currentCtx) => f(handlerCtx, currentCtx)),
      {},
    );
  }

  withService<S extends T.GrpcService<any, any, Ctx>>(
    service: T.UniqueTag<S, Services>,
  ): T.GrpcServerBuilder<Ctx, T.ConcatServiceTags<S, Services>> {
    return new ConnectEsGprcServerBuilder(this.transformCtx, {
      ...this.services,
      [service._Tag]: service,
    });
  }

  build<This extends T.GrpcServerBuilder<Ctx, Services>>(
    this: This,
    { readMaxBytes = grpcDefaultMaxReceiveMessageBytes }: T.GrpcServerOptions = {},
  ): T.GrpcServer<Services> {
    if (!Number.isInteger(readMaxBytes) || readMaxBytes < 1 || readMaxBytes > largestReadMaxBytes) {
      throw new Cause.IllegalArgumentException(
        `readMaxBytes must be an integer from 1 to ${largestReadMaxBytes}, got ${readMaxBytes}`,
      );
    }
    const executorTransformation = ProtoRuntime.ServerExecutorTransformer().transformContext<Ctx>(
      this.transformCtx,
    );

    return new EffectGrpcServerLive(
      this.services,
      executorTransformation.transformation,
      readMaxBytes,
    );
  }
}
