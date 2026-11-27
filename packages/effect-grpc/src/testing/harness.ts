// packages/effect-grpc/src/testing/harness.ts
import { Cause, Context, Effect, Layer, Option } from "effect";

import { Code, ConnectError } from "@connectrpc/connect";
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
 * Binds the server that `build` makes. Provide the service Layers that `build` needs with
 * `Layer.provide`, never `provideMerge`. The generated service tag and client tag share the
 * Context key `com.example.v1.HelloWorldAPI<any>`, which the types cannot see. `Layer.provide`
 * keeps the service out of the output, so a client in the same Context cannot replace it.
 */
export const testServer = <R>(
  build: Effect.Effect<EffectGrpcServer.GrpcServer<never>, never, R>,
  listen: Listen = freePort,
): Layer.Layer<TestServer, EffectGrpcServer.GrpcServerBindError, R> =>
  Layer.scoped(
    TestServer,
    Effect.flatMap(build, (server) => server.listen(listen)),
  );

export const clientConfig = <Service extends string>(
  tag: Context.Tag<
    EffectGrpcClient.GrpcClientConfig<Service>,
    EffectGrpcClient.GrpcClientConfig<Service>
  >,
): Layer.Layer<EffectGrpcClient.GrpcClientConfig<Service>, never, TestServer> =>
  Layer.effect(
    tag,
    Effect.map(TestServer, ({ url }) =>
      EffectGrpcClient.GrpcClientConfig<Service>({ baseUrl: new URL(url) }),
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

export const helloWorldServer = (listen?: Listen) =>
  testServer(
    Effect.map(effectProto.HelloWorldAPIServiceTag, (service) =>
      EffectGrpcServer.GrpcServerBuilder().withService(service).build(),
    ),
    listen,
  ).pipe(
    Layer.provide(
      effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, greeter),
    ),
  );

export const helloWorldClient = effectProto
  .helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag)
  .pipe(
    Layer.provide([
      clientConfig(effectProto.HelloWorldAPIConfigTag),
      EffectGrpcClient.liveGrpcClientRuntimeLayer(),
    ]),
  );

/**
 * Uses `provideMerge`, not `provide`, because tests read `TestServer`. The order matters. The
 * server builds first and is released after the client, so the client's abort cuts a call still
 * open at teardown, and the server's stop does not wait on it.
 */
export const helloWorld = (listen?: Listen) =>
  helloWorldClient.pipe(Layer.provideMerge(helloWorldServer(listen)));

export const greet = (name: string) =>
  Effect.flatMap(effectProto.HelloWorldAPIClientTag, (client) => client.getGreeting({ name }, {}));

// A generated client has no error channel, so a call that the server refuses dies with the error.
export const connectErrorOf = <A, R>(call: Effect.Effect<A, never, R>) =>
  call.pipe(
    Effect.sandbox,
    Effect.flip,
    Effect.map((cause) => Option.map(Cause.dieOption(cause), ConnectError.from)),
  );
