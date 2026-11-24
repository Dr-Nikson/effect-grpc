// .claude/skills/verify/scripts/effect-client-probe.mjs
//
// Calls the example server through the generated Effect client on its default tag, the way the
// generated JSDoc's first example does. Prints one JSON line as its last line of stdout.
// Run it through `control-example probe`, which feeds this file to `node --input-type=module`
// from packages/example so `effect`, `@dr_nikson/effect-grpc` and ./dist resolve there.
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";

import { Cause, Effect, Exit, Layer, Option } from "effect";

import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

import * as effectProto from "./dist/generated/com/example/v1/hello_world_api_effect.js";

const url = process.env.PROBE_URL;
if (!url) throw new Error("PROBE_URL is not set; run this file through control-example probe");
const method = process.env.PROBE_METHOD ?? "getGreeting";
const name = process.env.PROBE_NAME ?? "verify";

const clientLayer = effectProto.helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag).pipe(
  Layer.provide(
    Layer.succeed(
      effectProto.HelloWorldAPIConfigTag,
      EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL(url) }),
    ),
  ),
  Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
);

const program = Effect.gen(function* () {
  const client = yield* effectProto.HelloWorldAPIClientTag;
  return yield* client[method]({ name }, {});
});

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(clientLayer), Effect.scoped));

if (Exit.isSuccess(exit)) {
  console.log(JSON.stringify({ url, method, ok: true, response: exit.value }));
} else {
  const kind = Option.isSome(Cause.dieOption(exit.cause))
    ? "defect"
    : Option.isSome(Cause.failureOption(exit.cause))
      ? "failure"
      : "interrupt";
  const error = Cause.squash(exit.cause);
  console.log(JSON.stringify({ url, method, ok: false, kind, code: error?.code, error: String(error) }));
  process.exitCode = 1;
}
