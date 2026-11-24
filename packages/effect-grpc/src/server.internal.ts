// packages/effect-grpc/src/server.internal.ts
import { Effect, ExecutionStrategy, Exit, Predicate, Scope, Types } from "effect";
import http2 from "node:http2";

import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import type {
  ConnectRouter,
  ContextValues,
  HandlerContext,
  ServiceImpl,
} from "@connectrpc/connect";
import { createContextValues } from "@connectrpc/connect";
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
 * Closing a scope that `Scope.fork` made also removes it from its parent, so an `effect` that fails
 * or is interrupted leaves nothing in the current scope. Effect 3 does this in `ScopeImplProto.fork`
 * (`src/internal/fiberRuntime.ts`), and Effect 4 documents it on `Scope.fork`.
 */
const releaseOnFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.flatMap(Effect.scope, (scope) => Scope.fork(scope, ExecutionStrategy.sequential)),
    (child) => Scope.extend(effect, child),
    (child, exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void),
  );

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

  listen(
    options: ListenOptions,
  ): Effect.Effect<T.GrpcServerAddress, T.GrpcServerBindError, Scope.Scope> {
    const routes = this.routes.bind(this);
    const makeExecutor = this.makeExecutor.bind(this);

    return Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const handler = yield* Effect.sync(() =>
        connectNodeAdapter({
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

      const startup = Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(createServer, stopServer);
        const address = yield* awaitListening(server, options);
        yield* Effect.logInfo(`gRPC server listening on ${address.url}`);

        return address;
      });

      return yield* releaseOnFailure(startup);
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
