// packages/effect-grpc/src/server.internal.ts
import { Effect, Option, Scope, Types } from "effect";
import http2 from "node:http2";

import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import type {
  ConnectRouter,
  ContextValues,
  HandlerContext,
  ServiceImpl,
} from "@connectrpc/connect";
import { Code, createConnectRouter, createContextValues } from "@connectrpc/connect";
import {
  compressionBrotli,
  compressionGzip,
  universalRequestFromNodeRequest,
  universalResponseToNodeResponse,
} from "@connectrpc/connect-node";

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
const readAuthority = (authority: string): Option.Option<string> =>
  URL.canParse(`http://${authority}`) ?
    Option.some(authority)
  : Option.fromNullable(addressAndPort.exec(authority)).pipe(
      Option.map((match) => `[${match[1]}]:${match[2]}`),
      Option.filter((bracketed) => URL.canParse(`http://${bracketed}`)),
    );

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
  const grpc = Option.fromNullable(req.headers["content-type"]).pipe(
    Option.filter((contentType) => grpcContentType.test(contentType)),
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

type MethodKind = ConnectRouter["handlers"][number]["method"]["methodKind"];

/**
 * Connect refuses a message over the limit as soon as it reads the message's length, while the
 * client still has the rest queued. A Node client counts queued request bytes against its
 * session's memory and never gets them back once that stream is reset. Past the limit it rejects
 * every response on the session. So the listener discards the rest of the upload, and an answer
 * that is ready early waits until the client has nothing more queued: for the first three kinds
 * until the upload ends, because their clients send the whole request without waiting, and for
 * bidi until the message in flight has arrived and nothing follows it, because a bidi client may
 * wait for each reply.
 */
const earlyAnswerWaitsFor = {
  unary: "uploadEnd",
  server_streaming: "uploadEnd",
  client_streaming: "uploadEnd",
  bidi_streaming: "quietUpload",
} as const satisfies Record<MethodKind, "uploadEnd" | "quietUpload">;

/**
 * Follows the envelope framing that gRPC, gRPC-web and Connect streaming share (a flag byte and a
 * 4-byte length before each message), to tell when the message in flight has fully arrived.
 */
const trackEnvelopes = () => {
  let headerBytes = 0;
  let length = 0;
  let remaining = 0;
  let received = 0;
  let waiting: Array<() => void> = [];
  const atBoundary = () => headerBytes === 0 && remaining === 0;
  const track = (chunk: Uint8Array): void => {
    received += chunk.length;
    for (let offset = 0; offset < chunk.length; ) {
      if (remaining > 0) {
        const skipped = Math.min(remaining, chunk.length - offset);
        remaining -= skipped;
        offset += skipped;
        continue;
      }
      if (headerBytes > 0) length = length * 256 + (chunk[offset] ?? 0);
      headerBytes += 1;
      offset += 1;
      if (headerBytes === 5) {
        remaining = length;
        headerBytes = 0;
        length = 0;
      }
    }
    if (atBoundary()) {
      const ready = waiting;
      waiting = [];
      ready.forEach((resolve) => resolve());
    }
  };
  const boundary = (): Promise<void> =>
    atBoundary() ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve));
  return { track, boundary, received: () => received };
};

type PingRound = { inFlight: boolean; waiting: Array<() => void> };

const pingRounds = new WeakMap<http2.Http2Session, PingRound>();

const sendPing = (session: http2.Http2Session, round: PingRound): void => {
  const batch = round.waiting;
  round.waiting = [];
  round.inFlight = true;
  const acknowledged = (): void => {
    round.inFlight = false;
    // DATA frames read together with the ACK reach the stream before the waiters run.
    setImmediate(() => batch.forEach((resolve) => resolve()));
    if (round.waiting.length > 0) sendPing(session, round);
  };
  try {
    if (!session.ping(acknowledged)) acknowledged();
  } catch {
    acknowledged();
  }
};

/**
 * Resolves after a PING sent once this was called is acknowledged, so request bytes the client
 * queued before that PING reached it have arrived. One PING is in flight per session, because Node
 * allows ten outstanding by default.
 */
const pingRoundTrip = (session: http2.Http2Session): Promise<void> =>
  new Promise((resolve) => {
    const round = Option.getOrElse(Option.fromNullable(pingRounds.get(session)), () => {
      const created: PingRound = { inFlight: false, waiting: [] };
      pingRounds.set(session, created);
      return created;
    });
    round.waiting.push(resolve);
    if (!round.inFlight) sendPing(session, round);
  });

/**
 * The body of one request, read through one iterator. Connect borrows it, and once connect stops
 * reading before the upload has ended, the listener reads the rest from the same iterator and
 * discards it.
 */
const lendUpload = (req: http2.Http2ServerRequest) => {
  const source: AsyncIterator<Uint8Array> = req[Symbol.asyncIterator]();
  const envelopes = trackEnvelopes();
  const stream = req.stream;
  const ended = new Promise<void>((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
  });
  const open = () => !stream.readableEnded && !stream.destroyed;
  let lent = true;
  let stopped = false;
  const read = async (): Promise<IteratorResult<Uint8Array>> => {
    const chunk = await source.next();
    if (chunk.done !== true) envelopes.track(chunk.value);
    return chunk;
  };
  const discardRest = (): void => {
    if (!lent) return;
    lent = false;
    void (async () => {
      let chunk = await read();
      while (chunk.done !== true) chunk = await read();
    })().catch(() => {
      // The client reset the stream: nothing is left to read.
    });
  };
  const quiet = async (): Promise<void> => {
    for (;;) {
      await Promise.race([envelopes.boundary(), ended]);
      const session = Option.fromNullable(stream.session);
      if (!open() || Option.isNone(session)) return;
      const received = envelopes.received();
      await pingRoundTrip(session.value);
      if (!open() || envelopes.received() === received) return;
    }
  };
  const stop = (): void => {
    stopped = true;
    discardRest();
  };
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => (lent ? read() : Promise.resolve({ done: true, value: undefined })),
      return: (value?: unknown) => {
        stop();
        return Promise.resolve({ done: true, value });
      },
      throw: (error?: unknown) => {
        stop();
        return Promise.reject(error);
      },
    }),
  };
  return {
    body,
    stopped: () => stopped,
    wait: (until: "uploadEnd" | "quietUpload"): Promise<void> => {
      discardRest();
      return until === "uploadEnd" ? ended : Promise.race([ended, quiet()]);
    },
  };
};

type Upload = ReturnType<typeof lendUpload>;

/**
 * A bidi answer streams while connect reads the request. Once connect has stopped reading, the
 * rest of the answer, which carries the status, waits for the upload to go quiet.
 */
async function* restAfterQuiet(
  body: AsyncIterable<Uint8Array>,
  upload: Upload,
): AsyncGenerator<Uint8Array> {
  const chunks = body[Symbol.asyncIterator]();
  let waited = false;
  for (;;) {
    const chunk = await chunks.next();
    if (!waited && upload.stopped()) {
      await upload.wait("quietUpload");
      waited = true;
    }
    if (chunk.done === true) return;
    yield chunk.value;
  }
}

/**
 * connect-node builds each request's URL from its authority synchronously inside the listener, and
 * Node turns a throw there into an uncaught exception that stops the process.
 *
 * The listener routes with the functions connectNodeAdapter is built from, so that it owns the
 * request body and can hold an answer.
 */
const makeRequestListener = (options: {
  readonly routes: (router: ConnectRouter) => ConnectRouter;
  readonly contextValues: (req: http2.Http2ServerRequest) => ContextValues;
}): RequestListener => {
  const router = createConnectRouter({
    acceptCompression: [compressionGzip, compressionBrotli],
    readMaxBytes: grpcDefaultMaxReceiveMessageBytes,
  });
  options.routes(router);
  const routes = new Map(
    router.handlers.map((handler) => [
      handler.requestPath,
      { handler, waitsFor: earlyAnswerWaitsFor[handler.method.methodKind] },
    ]),
  );
  return (req, res) => {
    const resetStream = () => res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    try {
      const route = Option.fromNullable(routes.get(req.url.split("?", 1)[0] ?? ""));
      const upload = lendUpload(req);
      // Node types it as a string, but its getter returns undefined without :authority and host.
      const authority = Option.fromNullable(req.authority).pipe(Option.flatMap(readAuthority));
      if (Option.isNone(authority)) {
        void Option.match(route, {
          onNone: () => Promise.resolve(),
          onSome: ({ waitsFor }) => upload.wait(waitsFor),
        })
          .then(() => refuseMalformedAuthority(req, res))
          .catch(resetStream);
        return;
      }
      // Connect reads req.authority, and Node's getter returns this header first.
      if (authority.value !== req.authority) req.headers[":authority"] = authority.value;
      if (Option.isNone(route)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const { handler, waitsFor } = route.value;
      const request = {
        ...universalRequestFromNodeRequest(req, res, undefined, options.contextValues(req)),
        body: upload.body,
      };
      void handler(request)
        .then(async (response) => {
          if (waitsFor === "uploadEnd") {
            await upload.wait("uploadEnd");
            return universalResponseToNodeResponse(response, res);
          }
          const body = Option.fromNullable(response.body);
          return universalResponseToNodeResponse(
            Option.isSome(body) ?
              { ...response, body: restAfterQuiet(body.value, upload) }
            : response,
            res,
          );
        })
        .catch(resetStream);
    } catch {
      resetStream();
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
