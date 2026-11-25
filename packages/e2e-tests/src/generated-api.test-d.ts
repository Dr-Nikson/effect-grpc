// packages/e2e-tests/src/generated-api.test-d.ts
import { Effect, Layer } from "effect";
import { describe, test } from "vitest";

import { Code } from "@connectrpc/connect";
import { EffectGrpcClient, EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import * as namingProto from "./generated/com/example/v1/naming_test_service_effect.js";
import * as mixedProto from "./generated/com/example/v1/streaming_test_service_effect.js";

interface AppContext {
  readonly userId: string;
}

interface AuthMeta {
  readonly token: string;
}

declare const otherContextService: effectProto.HelloWorldAPIService<{ readonly tenant: string }>;
declare const needsBothServices: (
  server: EffectGrpcServer.GrpcServer<
    effectProto.HelloWorldAPIProtoId | namingProto.NamingTestServiceProtoId
  >,
) => void;

const appTag = effectProto.makeHelloWorldAPIServiceTag<AppContext>("AppContext");

describe("the server code generated for a service", () => {
  test("takes an implementation that reads the decoded request and its Ctx, and fails only with GrpcException", () => {
    const greets: effectProto.HelloWorldAPIService<AppContext> = {
      getGreeting: (request, ctx) =>
        Effect.succeed({ greeting: `${ctx.userId} greets ${request.name}` }),
      faceTheError: () => Effect.fail(GrpcException.create(Code.FailedPrecondition, "no")),
    };
    const failsWithAString: effectProto.HelloWorldAPIService<AppContext> = {
      getGreeting: (request) => Effect.succeed({ greeting: request.name }),
      // @ts-expect-error a handler fails only with GrpcException
      faceTheError: () => Effect.fail("no greeting"),
    };
    // @ts-expect-error each unary rpc needs a handler
    const lacksAHandler: effectProto.HelloWorldAPIService<AppContext> = {
      getGreeting: (request) => Effect.succeed({ greeting: request.name }),
    };

    effectProto.helloWorldAPIServiceLiveLayer(appTag, greets);
    effectProto.helloWorldAPIServiceLiveLayer(appTag, failsWithAString);
    effectProto.helloWorldAPIServiceLiveLayer(appTag, lacksAHandler);
    // @ts-expect-error the implementation reads another Ctx than the tag holds
    effectProto.helloWorldAPIServiceLiveLayer(appTag, otherContextService);
  });

  test("takes handlers for the unary rpcs alone of a service that also has streaming rpcs", () => {
    mixedProto.streamingTestServiceLiveLayer(mixedProto.StreamingTestServiceTag, {
      unary: (chunk) => Effect.succeed({ data: chunk.data }),
    });
  });
});

describe("a server", () => {
  test("serves a service whose handlers read their Ctx only after a context transformer makes that Ctx", () => {
    Effect.gen(function* () {
      const service = yield* appTag;

      // @ts-expect-error the builder has no AppContext for the handlers
      EffectGrpcServer.GrpcServerBuilder().withService(service);
      EffectGrpcServer.GrpcServerBuilder()
        .withContextTransformer(() => Effect.succeed({ tenant: "north" }))
        // @ts-expect-error this transformer makes another context
        .withService(service);

      return EffectGrpcServer.GrpcServerBuilder()
        .withContextTransformer(() => Effect.succeed({ userId: "u-1" }))
        .withService(service)
        .build();
    });
  });

  test("serves each service once, needs one to build, and takes context transformers only before its services", () => {
    Effect.gen(function* () {
      const service = yield* effectProto.HelloWorldAPIServiceTag;
      const serving = EffectGrpcServer.GrpcServerBuilder().withService(service);

      // @ts-expect-error HelloWorldAPI is served already
      serving.withService(service);
      // @ts-expect-error a server needs a service
      EffectGrpcServer.GrpcServerBuilder().build();
      // @ts-expect-error a context transformer comes before the services
      serving.withContextTransformer(() => Effect.succeed({ userId: "u-1" }));

      return serving.build();
    });
  });

  test("of one service cannot stand in where a server of two services is needed", () => {
    Effect.gen(function* () {
      const hello = yield* effectProto.HelloWorldAPIServiceTag;
      const naming = yield* namingProto.NamingTestServiceTag;
      const both = EffectGrpcServer.GrpcServerBuilder().withService(hello).withService(naming);
      const helloOnly = EffectGrpcServer.GrpcServerBuilder().withService(hello);

      needsBothServices(both.build());
      // @ts-expect-error the server lacks NamingTestService
      needsBothServices(helloOnly.build());
    });
  });
});

describe("the client code generated for a service", () => {
  test("takes the request's init shape and the client's Meta, and a caller that catches GrpcException by its tag has no error left", () => {
    Effect.gen(function* () {
      const client = yield* effectProto.makeHelloWorldAPIClientTag<AuthMeta>("AuthMeta");

      // @ts-expect-error name is a string
      yield* client.getGreeting({ name: 42 }, { token: "t0k" });
      // @ts-expect-error the call takes the client's Meta
      yield* client.getGreeting({ name: "Ada" }, { token: 42 });

      const greeting: Effect.Effect<string> = client
        .faceTheError({ name: "Ada" }, { token: "t0k" })
        .pipe(
          Effect.map((reply) => reply.greeting),
          Effect.catchTag("@dr_nikson/effect-grpc/grpcException/GrpcException", (error) =>
            Effect.succeed(`${error.code}: ${error.message}`),
          ),
        );
      return yield* greeting;
    });
  });

  test("builds a client only from its own service's config and the client runtime", () => {
    const call = Effect.flatMap(effectProto.HelloWorldAPIClientTag, (client) =>
      client.getGreeting({ name: "Ada" }, {}),
    ).pipe(
      Effect.provide(
        effectProto
          .helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag)
          .pipe(Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer())),
      ),
    );
    const config = EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL("http://127.0.0.1:8000") });
    const withItsConfig = call.pipe(
      Effect.provide(Layer.succeed(effectProto.HelloWorldAPIConfigTag, config)),
    );
    const withAnotherConfig = call.pipe(
      Effect.provide(Layer.succeed(namingProto.NamingTestServiceConfigTag, config)),
    );

    void Effect.runPromise(withItsConfig);
    // @ts-expect-error the client needs the config of HelloWorldAPI
    void Effect.runPromise(withAnotherConfig);
    effectProto.helloWorldAPIClientLiveLayer(
      // @ts-expect-error a meta transform returns RequestMeta
      (meta: AuthMeta) => meta.token,
      effectProto.makeHelloWorldAPIClientTag<AuthMeta>("AuthMeta"),
    );
  });
});
