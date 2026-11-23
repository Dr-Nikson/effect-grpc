# Code generation

A user runs `pnpm run generate:proto` (`buf generate`) in a package whose `buf.gen.yaml` lists `local: protoc-gen-effect`. `protoc-gen-effect` writes Effect server and client bindings next to the `protoc-gen-es` output, and the user imports them from `src/generated`.

## Sub-features

- `gen-emit` writes `<file>_pb.ts` and `<file>_effect.ts` for each proto file into `src/generated/<package path>/`.
- `gen-names` exports these names for a service whose name does not end in `Service` (`HelloWorldAPI`): `HelloWorldAPIProtoId`, `HelloWorldAPIService`, `HelloWorldAPIServiceTag`, `helloWorldAPIServiceLiveLayer`, `HelloWorldAPIGrpcService`, `HelloWorldAPIClient`, `HelloWorldAPIClientTag`, `helloWorldAPIClientLiveLayer`, `HelloWorldAPIConfigTag`.
- `gen-suffix` does not repeat the suffix for a service whose name ends in `Service` (`NamingTestService`, issue #30). It exports `NamingTestService`, `NamingTestServiceTag`, `namingTestServiceLiveLayer`, `NamingTestGrpcService`, `NamingTestServiceClient`, `NamingTestServiceClientTag`, `namingTestServiceClientLiveLayer`, `NamingTestServiceConfigTag`, `NamingTestServiceProtoId`, and nothing containing `ServiceService`.
- `gen-compiles` makes the generated code compile in a consumer package.
- `gen-typed-tags` makes the typed-tag factories that the docs show, `XClientTag<Meta>("key")` and `XServiceTag<Ctx>("key")`, callable at runtime.

## How to get to it (user POV)

- Run `pnpm run generate:proto` in `packages/example` or `packages/e2e-tests`.
- Run `pnpm -r run build`. The `build` script of each of those packages regenerates the bindings before it compiles.

## Driving it with control-example

Preconditions:

- `pnpm install` has run. No server is needed.
- `$C codegen` rebuilds `packages/effect-grpc` first, because the plugin runs the built `dist/protocGenPlugin.js`.

- **Regenerate.** Run `$C codegen`. The evidence file shows `build_exit_code=0` and the generated files: `hello_world_api_pb.ts` and `hello_world_api_effect.ts` under `packages/example/src/generated/com/example/v1/`, plus the same pair and the two `naming_test_service_*` files under `packages/e2e-tests/src/generated/com/example/v1/`.
- **Names.** Read the `## exports of …hello_world_api_effect.ts` section of the same file. It lists exactly the nine `gen-names` exports.
- **No duplicate suffix.** Read the `## exports of …naming_test_service_effect.ts` section. It lists the `gen-suffix` names, and no line contains `ServiceService`.
- **Compiles.** The build in the same file compiled `packages/example` and `packages/e2e-tests` against the new bindings, so `build_exit_code=0` covers it.
- **Typed tags callable.** Read the `## runtime type of the typed-tag factories` section. Pass: `typeof HelloWorldAPIClientTag = function` and `typeof HelloWorldAPIServiceTag = function`.

## Gotchas

- `gen-typed-tags` fails on the base recorded in SKILL.md: both lines read `= object`. The generated code assigns `Object.assign(makeXTag("any"), makeXTag)`, which returns the tag object, not a function. The declared type still has a call signature, so `tsc` and the type tests pass, but `XClientTag<Meta>("key")` throws `TypeError: … is not a function` at runtime. `packages/example/src/client.ts` uses that form; see [effect-client.md](./effect-client.md).
- The README's "Generated Code API" section still shows names from before #30, such as `UserServiceService` and `HelloServiceService`. Trust the generated file and this map over the README.
- After you edit `packages/effect-grpc/src/protocGenPlugin.ts`, regenerate through `$C codegen` or `$C build`. Both rebuild the library first. Running `pnpm run generate:proto` alone uses the old plugin build. `$C doctor` reports generated code that is older than the plugin source.
- `src/generated/` is gitignored, so regenerating never shows in `git status`. Use the evidence file as the record.
