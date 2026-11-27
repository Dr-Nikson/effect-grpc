// packages/effect-grpc/src/testing/harness.ts
import { Context, Effect, Layer } from "effect";

import { Code } from "@connectrpc/connect";
import { EffectGrpcClient, EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";

import * as effectProto from "../generated/com/example/v1/hello_world_api_effect.js";

export class TestServer extends Context.Tag("@dr_nikson/effect-grpc/testing/TestServer")<
  TestServer,
  EffectGrpcServer.GrpcServerAddress
>() {}

export interface Listen {
  readonly host: string;
  readonly port: number;
}

export const freePort: Listen = { host: "127.0.0.1", port: 0 };

/**
 * Binds the server that `build` makes. `services` is consumed here and goes no further: the
 * generated service tag and client tag share one key, so a Context that held both would hand the
 * client to a server built in it.
 */
export const testServer = <R>(
  services: Layer.Layer<R>,
  build: Effect.Effect<EffectGrpcServer.GrpcServer<never>, never, R>,
  listen: Listen = freePort,
): Layer.Layer<TestServer, EffectGrpcServer.GrpcServerBindError> =>
  Layer.scoped(
    TestServer,
    Effect.flatMap(build, (server) => server.listen(listen)),
  ).pipe(Layer.provide(services));

/**
 * Builds the client of a service for the server that `TestServer` names. Compose it with
 * `Layer.provideMerge(server)`: the server then starts first, and the client closes first, which
 * matters because a server's stop waits for the sessions that are still open.
 */
export const clientTo = <Id, Service extends string, E>(
  config: Context.Tag<
    EffectGrpcClient.GrpcClientConfig<Service>,
    EffectGrpcClient.GrpcClientConfig<Service>
  >,
  client: Layer.Layer<
    Id,
    E,
    EffectGrpcClient.GrpcClientConfig<Service> | EffectGrpcClient.GrpcClientRuntime
  >,
): Layer.Layer<Id, E, TestServer> =>
  Layer.unwrapEffect(
    Effect.map(TestServer, ({ url }) =>
      client.pipe(
        Layer.provide(
          Layer.succeed(
            config,
            EffectGrpcClient.GrpcClientConfig<Service>({ baseUrl: new URL(url) }),
          ),
        ),
        Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
      ),
    ),
  );

export const greeter: effectProto.HelloWorldAPIService = {
  getGreeting: ({ name }) => Effect.succeed({ greeting: `Hello, ${name}!` }),
  faceTheError: ({ name }) =>
    Effect.fail(
      GrpcException.create(
        Code.FailedPrecondition,
        `Sorry ${name}, you must face the consequences!`,
      ),
    ),
};

export const helloWorldServer = (
  listen?: Listen,
): Layer.Layer<TestServer, EffectGrpcServer.GrpcServerBindError> =>
  testServer(
    effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, greeter),
    Effect.map(effectProto.HelloWorldAPIServiceTag, (service) =>
      EffectGrpcServer.GrpcServerBuilder().withService(service).build(),
    ),
    listen,
  );

export const helloWorldClient = clientTo(
  effectProto.HelloWorldAPIConfigTag,
  effectProto.helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag),
);

export const helloWorld = (listen?: Listen) =>
  helloWorldClient.pipe(Layer.provideMerge(helloWorldServer(listen)));

export const greet = (name: string) =>
  Effect.flatMap(effectProto.HelloWorldAPIClientTag, (client) => client.getGreeting({ name }, {}));
