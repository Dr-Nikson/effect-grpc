// .claude/skills/verify/scripts/typed-tags-probe.mjs
import { Context, Effect, Layer } from "effect";
import console from "node:console";
import { isAbsolute } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const specifier = (path) => (isAbsolute(path) ? pathToFileURL(path).href : path);
const m = await import(
  specifier(process.argv[2] ?? "./dist/generated/com/example/v1/hello_world_api_effect.js")
);
const { EffectGrpcClient } = await import(specifier(process.argv[3] ?? "@dr_nikson/effect-grpc"));

const deps = Layer.mergeAll(
  Layer.succeed(
    m.HelloWorldAPIConfigTag,
    EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL("http://127.0.0.1:9") }),
  ),
  EffectGrpcClient.liveGrpcClientRuntimeLayer(),
);

const impl = (label) => {
  const answer = (request, ctx) =>
    Effect.succeed({ greeting: `${label}:${request.name}:ctx=${ctx ?? "none"}` });
  return { getGreeting: answer, faceTheError: answer };
};

const serve = (service, ctx) =>
  Effect.promise(() =>
    service
      .implementation({
        unary: (_method, request, _handlerCtx, prog) => Effect.runPromise(prog(request, ctx)),
      })
      .getGreeting({ name: "probe" }, {}),
  ).pipe(Effect.map((response) => response.greeting));

const isService = (value) => typeof value?.implementation === "function";
const isClient = (value) => typeof value?.getGreeting === "function";
const expect = (ok, why) => {
  if (!ok) throw new Error(why);
};

const checks = [
  [
    "one Context holds a value under each of the four tags: both default tags and one tag from each factory",
    () =>
      Effect.sync(() => {
        const tags = [
          m.HelloWorldAPIServiceTag,
          m.makeHelloWorldAPIServiceTag("Typed"),
          m.HelloWorldAPIClientTag,
          m.makeHelloWorldAPIClientTag("Typed"),
        ];
        const values = tags.map((_, index) => ({ index }));
        const context = tags.reduce(
          (ctx, tag, index) => Context.add(ctx, tag, values[index]),
          Context.empty(),
        );
        tags.forEach((tag, index) =>
          expect(
            Context.get(context, tag) === values[index],
            `the tag with key ${tag.key} resolved to another tag's value`,
          ),
        );
      }),
  ],
  [
    "one Context holds the default service and the default client, each under its own key",
    () =>
      Effect.gen(function* () {
        expect(
          m.HelloWorldAPIServiceTag.key !== m.HelloWorldAPIClientTag.key,
          `both default tags have the key ${m.HelloWorldAPIServiceTag.key}`,
        );
        const service = yield* m.HelloWorldAPIServiceTag;
        const client = yield* m.HelloWorldAPIClientTag;
        expect(isService(service), "the default service tag resolved to a client");
        expect(isClient(client), "the default client tag resolved to a service");
        const served = yield* serve(service, undefined);
        expect(served === "default:probe:ctx=none", `the default service answered ${served}`);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            m.helloWorldAPIServiceLiveLayer(m.HelloWorldAPIServiceTag, impl("default")),
            m.helloWorldAPIClientLiveLayer(m.HelloWorldAPIClientTag),
          ).pipe(Layer.provide(deps)),
        ),
      ),
  ],
  [
    'makeHelloWorldAPIServiceTag("Typed") gives a tag that resolves to its own service, next to the default tag',
    () => {
      const TypedTag = m.makeHelloWorldAPIServiceTag("Typed");
      expect(typeof TypedTag?.key === "string", `the factory returned ${String(TypedTag)}`);
      expect(
        TypedTag.key !== m.HelloWorldAPIServiceTag.key,
        `the typed tag has the default key ${TypedTag.key}`,
      );
      return Effect.gen(function* () {
        const typed = yield* serve(yield* TypedTag, "u-1");
        const plain = yield* serve(yield* m.HelloWorldAPIServiceTag, undefined);
        expect(typed === "typed:probe:ctx=u-1", `the typed service tag answered ${typed}`);
        expect(plain === "default:probe:ctx=none", `the default service tag answered ${plain}`);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            m.helloWorldAPIServiceLiveLayer(m.HelloWorldAPIServiceTag, impl("default")),
            m.helloWorldAPIServiceLiveLayer(TypedTag, impl("typed")),
          ),
        ),
      );
    },
  ],
  [
    'makeHelloWorldAPIClientTag("Typed") gives a tag that resolves to its own client, next to the default tag',
    () => {
      const TypedTag = m.makeHelloWorldAPIClientTag("Typed");
      expect(typeof TypedTag?.key === "string", `the factory returned ${String(TypedTag)}`);
      const keys = [m.HelloWorldAPIServiceTag.key, m.HelloWorldAPIClientTag.key, TypedTag.key];
      expect(new Set(keys).size === keys.length, `keys repeat: ${keys.join(" ")}`);
      return Effect.gen(function* () {
        const typed = yield* TypedTag;
        const plain = yield* m.HelloWorldAPIClientTag;
        expect(isClient(typed) && isClient(plain), "a client tag resolved to something else");
        expect(typed !== plain, "the typed and the default client tag resolved to one client");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            m.helloWorldAPIClientLiveLayer(m.HelloWorldAPIClientTag),
            m.helloWorldAPIClientLiveLayer(
              (meta) => ({ headers: new Headers({ authorization: String(meta) }) }),
              TypedTag,
            ),
          ).pipe(Layer.provide(deps)),
        ),
      );
    },
  ],
];

let failed = 0;
for (const [label, check] of checks) {
  try {
    await Effect.runPromise(check());
    console.log(`PASS ${label}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${label}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}
console.log(
  `keys: service=${m.HelloWorldAPIServiceTag?.key} client=${m.HelloWorldAPIClientTag?.key}`,
);
console.log(`verdict=${failed === 0 ? "PASS" : "FAIL"}`);
process.exitCode = failed === 0 ? 0 : 1;
