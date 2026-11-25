// packages/e2e-tests/src/generated-api.test-d.ts
import { Effect } from "effect";
import type { Context, Layer, Option, Schema, Scope } from "effect";
import { describe, expectTypeOf, test } from "vitest";

import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Code } from "@connectrpc/connect";
import { EffectGrpcClient, EffectGrpcServer } from "@dr_nikson/effect-grpc";
import type { GrpcException } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import * as mixedProto from "./generated/com/example/v1/streaming_test_service_effect.js";
import { HelloWorldAPI } from "./generated/com/example/v1/hello_world_api_pb.js";
import type {
  GetGreetingRequest,
  GetGreetingRequestSchema,
  GetGreetingResponse,
  GetGreetingResponseSchema,
} from "./generated/com/example/v1/hello_world_api_pb.js";
import { StreamingTestService } from "./generated/com/example/v1/streaming_test_service_pb.js";
import type { ChunkSchema } from "./generated/com/example/v1/streaming_test_service_pb.js";

type ServiceId = "com.example.v1.HelloWorldAPI";
type MixedServiceId = "com.example.v1.StreamingTestService";

interface AppContext {
  readonly userId: string;
}

interface OtherContext {
  readonly tenant: string;
}

interface AuthMeta {
  readonly token: string;
}

type WrappedService<Ctx> = EffectGrpcServer.GrpcService<ServiceId, typeof HelloWorldAPI, Ctx>;
type ServiceTag<Ctx> = Context.Service<WrappedService<Ctx>, WrappedService<Ctx>>;
type ClientTag<Meta> = Context.Service<
  effectProto.HelloWorldAPIClient<Meta>,
  effectProto.HelloWorldAPIClient<Meta>
>;
type Config = EffectGrpcClient.GrpcClientConfig<ServiceId>;
type ClientNeeds = Config | EffectGrpcClient.GrpcClientRuntime;

declare const appService: effectProto.HelloWorldAPIService<AppContext>;
declare const otherService: effectProto.HelloWorldAPIService<OtherContext>;
declare const anyService: effectProto.HelloWorldAPIService;
declare const wrappedAnyService: effectProto.HelloWorldAPIGrpcService;
declare const authClient: effectProto.HelloWorldAPIClient<AuthMeta>;
declare const decodedRequest: GetGreetingRequest;
declare const wrappedMixedService: mixedProto.StreamingTestGrpcService;

describe("the server API generated for HelloWorldAPI", () => {
  test("the service interface has one method per unary rpc, taking the decoded request and Ctx and failing only with GrpcException", () => {
    type Handler = (
      request: GetGreetingRequest,
      ctx: AppContext,
    ) => Effect.Effect<
      MessageInitShape<typeof GetGreetingResponseSchema>,
      GrpcException.GrpcException
    >;

    expectTypeOf<keyof effectProto.HelloWorldAPIService<AppContext>>().toEqualTypeOf<
      "getGreeting" | "faceTheError"
    >();
    expectTypeOf<
      effectProto.HelloWorldAPIService<AppContext>["getGreeting"]
    >().toEqualTypeOf<Handler>();
    expectTypeOf<
      effectProto.HelloWorldAPIService<AppContext>["faceTheError"]
    >().toEqualTypeOf<Handler>();
    expectTypeOf<Parameters<effectProto.HelloWorldAPIService["getGreeting"]>[1]>().toBeAny();

    expectTypeOf(appService.getGreeting(decodedRequest, { userId: "u1" })).toEqualTypeOf<
      Effect.Effect<MessageInitShape<typeof GetGreetingResponseSchema>, GrpcException.GrpcException>
    >();
    // @ts-expect-error a handler gets the decoded message, not an init object
    appService.getGreeting({ name: "Ada" }, { userId: "u1" });
  });

  test("the wrapped service is the GrpcService a server registers under the service's proto name", () => {
    expectTypeOf(effectProto.HelloWorldAPIProtoId).toEqualTypeOf<ServiceId>();
    expectTypeOf<effectProto.HelloWorldAPIProtoId>().toEqualTypeOf<ServiceId>();
    expectTypeOf<effectProto.HelloWorldAPIGrpcService<AppContext>>().toEqualTypeOf<
      WrappedService<AppContext>
    >();
    expectTypeOf<effectProto.HelloWorldAPIGrpcService>().toEqualTypeOf<WrappedService<any>>();

    expectTypeOf(
      EffectGrpcServer.GrpcServerBuilder().withService(wrappedAnyService).build(),
    ).toEqualTypeOf<EffectGrpcServer.GrpcServer<ServiceId>>();
  });

  test("the service tags and the live layer provide the wrapped service of the tag's Ctx", () => {
    const appTag = effectProto.makeHelloWorldAPIServiceTag<AppContext>("AppContext");

    expectTypeOf(effectProto.HelloWorldAPIServiceTag).toEqualTypeOf<ServiceTag<any>>();
    expectTypeOf(appTag).toEqualTypeOf<ServiceTag<AppContext>>();
    expectTypeOf(
      effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, anyService),
    ).toEqualTypeOf<Layer.Layer<WrappedService<any>>>();
    expectTypeOf(effectProto.helloWorldAPIServiceLiveLayer(appTag, appService)).toEqualTypeOf<
      Layer.Layer<WrappedService<AppContext>>
    >();
    // @ts-expect-error the implementation reads another Ctx than the tag holds
    effectProto.helloWorldAPIServiceLiveLayer(appTag, otherService);
  });
});

describe("the client API generated for HelloWorldAPI", () => {
  test("the client interface has one method per unary rpc, taking the request's init shape and Meta, and failing with GrpcException", () => {
    type Call = (
      request: MessageInitShape<typeof GetGreetingRequestSchema>,
      meta: AuthMeta,
    ) => Effect.Effect<GetGreetingResponse, GrpcException.GrpcException>;

    expectTypeOf<keyof effectProto.HelloWorldAPIClient<AuthMeta>>().toEqualTypeOf<
      "getGreeting" | "faceTheError"
    >();
    expectTypeOf<effectProto.HelloWorldAPIClient<AuthMeta>["getGreeting"]>().toEqualTypeOf<Call>();
    expectTypeOf<effectProto.HelloWorldAPIClient<AuthMeta>["faceTheError"]>().toEqualTypeOf<Call>();
    // @ts-expect-error the client interface has no default Meta
    expectTypeOf<effectProto.HelloWorldAPIClient>();

    expectTypeOf(authClient.getGreeting({}, { token: "t0k" })).toEqualTypeOf<
      Effect.Effect<GetGreetingResponse, GrpcException.GrpcException>
    >();
    // @ts-expect-error a call takes its meta argument
    authClient.getGreeting({});
    // @ts-expect-error the meta has the client's Meta type
    authClient.faceTheError({}, { token: 42 });
  });

  test("a caller that catches GrpcException by its tag is left with no error to handle, and reads the code and the data", () => {
    const handled = authClient.faceTheError({ name: "Ada" }, { token: "t0k" }).pipe(
      Effect.map((response) => response.greeting),
      Effect.catchTag("@dr_nikson/effect-grpc/grpcException/GrpcException", (error) => {
        expectTypeOf(error.code).toEqualTypeOf<Code>();
        expectTypeOf(error.message).toEqualTypeOf<string>();
        expectTypeOf(error.data).toEqualTypeOf<Option.Option<Schema.Json>>();
        return Effect.succeed(error.message);
      }),
    );

    expectTypeOf(handled).toEqualTypeOf<Effect.Effect<string>>();
  });

  test("the client tags hold a client of their Meta", () => {
    expectTypeOf(effectProto.HelloWorldAPIClientTag).toEqualTypeOf<ClientTag<any>>();
    expectTypeOf(effectProto.makeHelloWorldAPIClientTag<AuthMeta>("AuthMeta")).toEqualTypeOf<
      ClientTag<AuthMeta>
    >();
  });

  test("the client live layer needs the service's config and the client runtime, for the default tag, a typed tag alone as the example builds it, or a typed tag with a meta transform", () => {
    const authTag = effectProto.makeHelloWorldAPIClientTag<AuthMeta>("AuthMeta");

    expectTypeOf(
      effectProto.helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag),
    ).toEqualTypeOf<Layer.Layer<effectProto.HelloWorldAPIClient<any>, never, ClientNeeds>>();
    expectTypeOf(effectProto.helloWorldAPIClientLiveLayer(authTag)).toEqualTypeOf<
      Layer.Layer<effectProto.HelloWorldAPIClient<AuthMeta>, never, ClientNeeds>
    >();
    expectTypeOf(
      effectProto.helloWorldAPIClientLiveLayer(
        (meta: AuthMeta) => ({ headers: new Headers({ authorization: meta.token }) }),
        authTag,
      ),
    ).toEqualTypeOf<Layer.Layer<effectProto.HelloWorldAPIClient<AuthMeta>, never, ClientNeeds>>();
    // @ts-expect-error the meta transform returns RequestMeta
    effectProto.helloWorldAPIClientLiveLayer((meta: AuthMeta) => meta.token, authTag);
  });

  test("the config tag holds the GrpcClientConfig of HelloWorldAPI", () => {
    expectTypeOf(effectProto.HelloWorldAPIConfigTag).toEqualTypeOf<
      Context.Service<Config, Config>
    >();
  });

  test("makeExecutor, called the way the generated client layer calls it, gives each method an optional RequestMeta and GrpcException as its failure", () => {
    type ExecutorCall = (
      request: MessageInitShape<typeof GetGreetingRequestSchema>,
      meta?: EffectGrpcClient.RequestMeta,
    ) => Effect.Effect<GetGreetingResponse, GrpcException.GrpcException>;

    const program = Effect.gen(function* () {
      const config = yield* effectProto.HelloWorldAPIConfigTag;
      const grpcRuntime = yield* EffectGrpcClient.GrpcClientRuntime;
      const executor = yield* grpcRuntime.makeExecutor(
        HelloWorldAPI,
        ["getGreeting", "faceTheError"],
        config,
      );

      expectTypeOf(executor.getGreeting).toEqualTypeOf<ExecutorCall>();
      expectTypeOf(executor.faceTheError).toEqualTypeOf<ExecutorCall>();
      return executor;
    });

    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<Effect.Success<typeof program>, never, ClientNeeds | Scope.Scope>
    >();
  });
});

describe("the API generated for StreamingTestService, which has one rpc of each kind", () => {
  test("the service interface and the client interface list the unary rpc only", () => {
    expectTypeOf<keyof mixedProto.StreamingTestService>().toEqualTypeOf<"unary">();
    expectTypeOf<keyof mixedProto.StreamingTestServiceClient<AuthMeta>>().toEqualTypeOf<"unary">();
  });

  test("the wrapped service is the GrpcService a server registers under the service's proto name", () => {
    expectTypeOf<mixedProto.StreamingTestGrpcService>().toEqualTypeOf<
      EffectGrpcServer.GrpcService<MixedServiceId, typeof StreamingTestService, any>
    >();
    expectTypeOf(
      EffectGrpcServer.GrpcServerBuilder().withService(wrappedMixedService).build(),
    ).toEqualTypeOf<EffectGrpcServer.GrpcServer<MixedServiceId>>();
  });

  test("GrpcService needs a handler for the unary rpc and none for the streaming rpcs", () => {
    const mixedService = EffectGrpcServer.GrpcService(
      mixedProto.StreamingTestServiceProtoId,
      StreamingTestService,
    );
    // @ts-expect-error a unary method cannot be left out
    mixedService(() => ({}));

    const unaryOnly = mixedService((executor: EffectGrpcServer.ServerExecutor<AppContext>) => ({
      unary: (request, handlerContext): Promise<MessageInitShape<typeof ChunkSchema>> =>
        executor.unary(
          `${mixedProto.StreamingTestServiceProtoId}/Unary`,
          request,
          handlerContext,
          (chunk) => Effect.succeed({ data: chunk.data }),
        ),
    }));
    expectTypeOf(unaryOnly).toEqualTypeOf<
      EffectGrpcServer.GrpcService<MixedServiceId, typeof StreamingTestService, AppContext>
    >();
  });
});
