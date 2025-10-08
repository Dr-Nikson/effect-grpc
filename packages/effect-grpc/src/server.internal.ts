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
import { createContextValues } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

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

  run(): Effect.Effect<never, never, Scope.Scope> {
    const routes = this.routes.bind(this);
    const makeExecutor = this.makeExecutor.bind(this);

    const HOST = "localhost";
    const PORT = 8000;

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
      type Srv = http2.Http2Server;
      const startServer = Effect.async<Srv>((resume) => {
        const server = http2
          .createServer(handler)
          .addListener("connect", (req, socket, head) => {
            console.log("Connected to server", req.url, socket, head);
          })
          .addListener("connection", (socket) => {
            console.log("New connection", socket.remoteAddress, socket.remotePort);
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
          .listen({ port: PORT, host: HOST }, () => {
            resume(
              Effect.logInfo(`gRPC server listening on http://${HOST}:${PORT}`).pipe(
                Effect.as(server),
              ),
            );
          });
      });

      const stopServer = (server: http2.Http2Server) =>
        Effect.async((resume) => {
          // Gracefully stop the server
          server.close(() => resume(Effect.logInfo("gRPC server stopped")));
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
    public readonly transformCtx: (ctx: HandlerContext) => Effect.Effect<Ctx>,
    public readonly services: Record<string, T.GrpcService<any, any, Ctx>>,
  ) {}

  static get empty(): T.GrpcServerBuilder<HandlerContext, never> {
    return new ConnectEsGprcServerBuilder<HandlerContext, never>((ctx) => Effect.succeed(ctx), {});
  }

  withContextTransformer<This extends T.GrpcServerBuilder<Ctx, Services>, Ctx1>(
    this: This,
    f: (ctx: Ctx) => Effect.Effect<Ctx1>,
  ): T.GrpcServerBuilder<Ctx1, never> {
    return new ConnectEsGprcServerBuilder<Ctx1, never>(
      (ctx) => Effect.flatMap(this.transformCtx(ctx), f),
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
