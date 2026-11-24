# Code generation

A user runs `pnpm run generate:proto` (`buf generate`) in a package whose `buf.gen.yaml` lists `local: protoc-gen-effect`. `protoc-gen-effect` writes Effect server and client bindings next to the `protoc-gen-es` output, and the user imports them from `src/generated`.

## Sub-features

- `gen-emit` writes `<file>_pb.ts` and `<file>_effect.ts` for each proto file into `src/generated/<package path>/`.
- `gen-names` exports these names for a service whose name does not end in `Service` (`HelloWorldAPI`): `HelloWorldAPIProtoId`, `HelloWorldAPIService`, `HelloWorldAPIServiceTag`, `makeHelloWorldAPIServiceTag`, `helloWorldAPIServiceLiveLayer`, `HelloWorldAPIGrpcService`, `HelloWorldAPIClient`, `HelloWorldAPIClientTag`, `makeHelloWorldAPIClientTag`, `helloWorldAPIClientLiveLayer`, `HelloWorldAPIConfigTag`.
- `gen-suffix` does not repeat the suffix for a service whose name ends in `Service` (`NamingTestService`, issue #30). It exports `NamingTestService`, `NamingTestServiceTag`, `makeNamingTestServiceTag`, `namingTestServiceLiveLayer`, `NamingTestGrpcService`, `NamingTestServiceClient`, `NamingTestServiceClientTag`, `makeNamingTestServiceClientTag`, `namingTestServiceClientLiveLayer`, `NamingTestServiceConfigTag`, `NamingTestServiceProtoId`, and nothing containing `ServiceService`.
- `gen-compiles` makes the generated code compile in a consumer package.
- `gen-typed-tags` makes the tags the docs show work at runtime. One Context holds the default service tag and the default client tag, each under its own key, and `makeXServiceTag<Ctx>("key")` and `makeXClientTag<Meta>("key")` return tags that a layer provides and that resolve to that layer's value next to the default tag.

## How to get to it (user POV)

- Run `pnpm run generate:proto` in `packages/example` or `packages/e2e-tests`.
- Run `pnpm -r run build`. The `build` script of each of those packages regenerates the bindings before it compiles.

## Driving it with control-example

Preconditions:

- `pnpm install` has run. No server is needed.
- `.claude/skills/verify/scripts/control-example codegen` rebuilds `packages/effect-grpc` first, because the plugin runs the built `dist/protocGenPlugin.js`.

- **Regenerate.** Run `.claude/skills/verify/scripts/control-example codegen`. The evidence file shows `build_exit_code=0` and the generated files: `hello_world_api_pb.ts` and `hello_world_api_effect.ts` under `packages/example/src/generated/com/example/v1/`, plus the same pair and the two `naming_test_service_*` files under `packages/e2e-tests/src/generated/com/example/v1/`.
- **Names.** Read the `## exports of …hello_world_api_effect.ts` section of the same file. It lists exactly the eleven `gen-names` exports.
- **No duplicate suffix.** Read the `## exports of …naming_test_service_effect.ts` section. It lists the `gen-suffix` names, and no line contains `ServiceService`.
- **Compiles.** The build in the same file compiled `packages/example` and `packages/e2e-tests` against the new bindings, so `build_exit_code=0` covers it.
- **Typed tags work.** Read the `## typed tags in packages/example/dist` section. Pass: four `PASS` lines, `keys: service=com.example.v1.HelloWorldAPI/Service client=com.example.v1.HelloWorldAPI/Client`, `verdict=PASS` and `typed_tags_exit_code=0`. The command exits non-zero when the build or this check fails.

## Gotchas

- A `typeof` check proves nothing about these tags. On Effect 4 every tag is a function, working or broken, and on Effect 3 a working tag is an object. The check uses each tag instead: it builds a layer with it and resolves it from a Context.
- After you edit `packages/effect-grpc/src/protocGenPlugin.ts`, regenerate through `.claude/skills/verify/scripts/control-example codegen` or `.claude/skills/verify/scripts/control-example build`. Both rebuild the library first, and both delete `packages/example/src/generated` before buf runs. buf 1.67 and later do not rewrite a file whose content did not change, so its modification time stays old. Running `pnpm run generate:proto` alone uses the old plugin build, and it leaves such files older than the plugin source. `.claude/skills/verify/scripts/control-example doctor` reports that as generated code that is older than the plugin source.
- `src/generated/` is gitignored, so regenerating never shows in `git status`. Use the evidence file as the record.
