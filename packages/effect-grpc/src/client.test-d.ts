import { Context, Layer } from "effect";
import { expectTypeOf, test } from "vitest";

import * as Client from "./client.js";

test("GrpcClientRuntime#makeExecutor should interfere config correctly", () => {
  type Service1 = "com.example.v1.HelloWorldAPI";
  type Service2 = "com.example.v1.PingPongAPI";

  const Service1ConfigTag = Client.GrpcClientConfig.makeTag(null as any as Service1);
  const Service2ConfigTag = Client.GrpcClientConfig.makeTag(null as any as Service2);

  const liveLayerFn: {
    <
      CfgTag extends Context.Tag<
        Client.GrpcClientConfig<"com.example.v1.HelloWorldAPI">,
        Client.GrpcClientConfig<"com.example.v1.HelloWorldAPI">
      >,
    >(
      configTag: CfgTag,
    ): Layer.Layer<Service1, never, Context.Tag.Identifier<CfgTag>>;
  } = null as any;

  expectTypeOf(liveLayerFn).toBeCallableWith(Service1ConfigTag);

  // @ts-expect-error shouldn't be possible to call
  expectTypeOf(liveLayerFn).toBeCallableWith(Service2ConfigTag);
});
