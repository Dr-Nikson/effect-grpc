// packages/effect-grpc/src/server.internal.ts
import { Effect, Scope, Types } from "effect";
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
import type * as T from "./server.js";

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

/**
 * Connect checks it on the wire and again after decompression.
 */
const grpcDefaultMaxReceiveMessageBytes = 4 * 1024 * 1024;

type RequestListener = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void;

const addressAndPort = /^(.+):(\d+)$/;

/**
 * Node's HTTP/2 client strips the brackets from an IPv6 literal when it builds `:authority`, so it
 * sends `::1:8000` for `http://[::1]:8000`. `::1:8000` is also a complete IPv6 address, but a
 * valid authority must bracket an IPv6 address, and Node's client always appends the port.
 */
const readAuthority = (authority: string): string | undefined => {
  if (URL.canParse(`http://${authority}`)) return authority;
  const match = addressAndPort.exec(authority);
  if (match === null) return undefined;
  const bracketed = `[${match[1]}]:${match[2]}`;
  return URL.canParse(`http://${bracketed}`) ? bracketed : undefined;
};

const grpcContentType =
  /^application\/grpc(?:-web(?:-text)?)?(?:\+(?:json(?:; ?charset=utf-?8)?|proto))?$/i;

/**
 * A gRPC or gRPC-web client reads the status from an HTTP 200 response. Strict clients also check
 * that the response content type matches their own, so the reply echoes it.
 */
const refuseMalformedAuthority = (
  req: http2.Http2ServerRequest,
  res: http2.Http2ServerResponse,
): void => {
  const message = "malformed request authority";
  const contentType = req.headers["content-type"];
  if (contentType !== undefined && grpcContentType.test(contentType)) {
    // Headers set before end() leave in one HEADERS frame that ends the stream, which is a gRPC
    // trailers-only response. writeHead() would send them without END_STREAM.
    res.statusCode = 200;
    res.setHeader("content-type", contentType);
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
 * connect-node builds each request's URL from its authority synchronously inside the listener, and
 * Node turns a throw there into an uncaught exception that stops the process.
 */
const makeRequestListener = (
  options: Pick<ConnectNodeAdapterOptions, "routes" | "interceptors" | "contextValues">,
): RequestListener => {
  const handler = connectNodeAdapter({
    ...options,
    readMaxBytes: grpcDefaultMaxReceiveMessageBytes,
  });
  return (req, res) => {
    try {
      const authority = readAuthority(req.authority);
      if (authority === undefined) {
        refuseMalformedAuthority(req, res);
        return;
      }
      // Connect reads req.authority, and Node's getter returns this header first.
      if (authority !== req.authority) req.headers[":authority"] = authority;
      handler(req, res);
    } catch {
      res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    }
  };
};

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
  ) {}

  readonly _Services: Types.Contravariant<Services> = (a) => a;

  run(options: { host: string; port: number }): Effect.Effect<never, never, Scope.Scope> {
    const routes = this.routes.bind(this);
    const makeExecutor = this.makeExecutor.bind(this);

    return Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const handler = yield* Effect.sync(() =>
        makeRequestListener({
          routes: routes(executor),
          interceptors: [],
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
      type Srv = http2.Http2Server;
      const startServer = Effect.async<Srv>((resume, signal) => {
        const server = http2
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
          })
          .listen({ ...options, signal }, () => {
            resume(
              Effect.logInfo(
                `gRPC server listening on http://${options.host}:${options.port}`,
              ).pipe(Effect.as(server)),
            );
          });
      });

      const stopServer = (server: http2.Http2Server) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("gRPC server is stopping...");

          yield* Effect.async((resume) => {
            // Then close the server
            server.close(() => {
              return resume(Effect.logInfo("gRPC server stopped"));
            });
          });
        });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const server = yield* Effect.acquireRelease(startServer, stopServer);

      return yield* Effect.never;
    });
  }

  private routes(
    executor: ProtoRuntime.ServerExecutor<Ctx>,
  ): (router: ConnectRouter) => ConnectRouter {
    const allServices: T.GrpcService<any, any, Ctx>[] = Object.values(this.services);

    return (router: ConnectRouter) => {
      return allServices.reduce((router, service: T.GrpcService<any, any, Ctx>) => {
        return router.service(service.definition, service.implementation(executor));
      }, router);
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

  build<This extends T.GrpcServerBuilder<Ctx, Services>>(this: This): T.GrpcServer<Services> {
    const executorTransformation = ProtoRuntime.ServerExecutorTransformer().transformContext<Ctx>(
      this.transformCtx,
    );

    return new EffectGrpcServerLive(this.services, executorTransformation.transformation);
  }
}
