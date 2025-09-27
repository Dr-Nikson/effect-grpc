import { Effect, Layer, ManagedRuntime, Scope, Types } from "effect";
import http2 from "node:http2";

import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import {
  ConnectRouter,
  type ContextValues,
  HandlerContext,
  ServiceImpl,
  createContextValues,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

import type * as T from "./server.js";

export const grpcServiceTypeId = Symbol("@tipizzato/effect-grpc/GrpcService");

export function makeGrpcService<
  Tag,
  Proto extends GenService<RuntimeShape>,
  RuntimeShape extends GenServiceMethods,
>(tag: Tag, definition: Proto) {
  return <Ctx>(implementation: (exec: T.Executor<Ctx>) => ServiceImpl<Proto>) => {
    return {
      Type: grpcServiceTypeId,
      // _Tag: (a) => a,
      _Tag: tag,
      _Ctx: null as any,

      implementation,
      definition,
    } as T.GrpcService<Tag, Proto, Ctx>;
  };
}

class ExecutorLive implements T.Executor<HandlerContext> {
  constructor(public readonly runtime: ManagedRuntime.ManagedRuntime<never, never>) {}

  unary<In, Out>(
    req: In,
    ctx: HandlerContext,
    prog: (req: In, ctx: HandlerContext) => Effect.Effect<Out>,
  ): Promise<Out> {
    return this.runtime.runPromise(prog(req, ctx), { signal: ctx.signal });
  }
}

class ExecutorTransformer<Ctx> {
  constructor(
    public readonly transformation: (underlying: T.Executor<HandlerContext>) => T.Executor<Ctx>,
  ) {}

  static get empty(): ExecutorTransformer<HandlerContext> {
    return new ExecutorTransformer((underlying) => underlying);
  }

  transformContext<Ctx1>(f: (ctx: Ctx) => Effect.Effect<Ctx1>): ExecutorTransformer<Ctx1> {
    return new ExecutorTransformer<Ctx1>((underlying) => {
      const executor: T.Executor<Ctx> = this.transformation(underlying);

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
      } as T.Executor<Ctx1>;
    });
  }
}

class EffectGrpcServerLive<Services, Ctx> implements T.GrpcServer<Services> {
  readonly _Services: Types.Invariant<Services> = (a) => a;

  constructor(
    public readonly services: Record<string & Services, T.GrpcService<any, any, Ctx>>,
    public readonly transformation: (executor: T.Executor<HandlerContext>) => T.Executor<Ctx>,
  ) {}

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

  private routes(executor: T.Executor<Ctx>): (router: ConnectRouter) => ConnectRouter {
    const allServices: T.GrpcService<any, any, Ctx>[] = Object.values(this.services);

    return (router: ConnectRouter) => {
      return allServices.reduce((router, service: T.GrpcService<any, any, Ctx>) => {
        return router.service(service.definition, service.implementation(executor));
      }, router);
    };
  }

  private makeExecutor(): Effect.Effect<T.Executor<Ctx>, never, Scope.Scope> {
    const { transformation } = this;

    return Effect.gen(function* () {
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => ManagedRuntime.make(Layer.empty)),
        (runtime) => runtime.disposeEffect,
      );

      const basicExecutor = new ExecutorLive(runtime);
      const transformedExecutor = transformation(basicExecutor);

      return transformedExecutor;
    });
  }
}


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
    service: S,
  ): T.GrpcServerBuilder<Ctx, Services | S["_Tag"]> {
    return new ConnectEsGprcServerBuilder(this.transformCtx, {
      ...this.services,
      [service._Tag]: service,
    });
  }

  build<This extends T.GrpcServerBuilder<Ctx, Services>>(
    this: This,
  ): T.GrpcServer<Services> {
    const executorTransformation = ExecutorTransformer.empty.transformContext<Ctx>(
      this.transformCtx,
    );

    return new EffectGrpcServerLive(this.services, executorTransformation.transformation);
  }
}
