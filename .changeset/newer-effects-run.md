---
"@dr_nikson/effect-grpc": major
---

Run on Effect 4 (#71)

**Breaking.** effect-grpc now needs Effect 4. The peer range of `effect` is `^4.1.5` (it was `^3.19.15`), and the peer range of `@effect/opentelemetry` is `^4.1.5` (it was `^0.61.0`). The package now declares `engines.node` as `>=22.19.0`, which Effect 4's platform packages need. On an older Node.js, npm warns with `EBADENGINE`, and an install fails only when `engine-strict` is set. Move your application to Effect 4 in the same change. Effect's guide is `MIGRATION.md` in the Effect repository.

**Breaking.** Run `buf generate` again. `protoc-gen-effect` now emits Effect 4 code, and code that an earlier version generated does not compile against Effect 4. The generated exports keep their names. Their types change with Effect: a tag is a `Context.Service<...>` where it was a `Context.Tag<...>`. The same holds for `GrpcClientRuntime` and for the result of `GrpcClientConfig.makeTag`. In your own types, `Context.Tag.Service<typeof X>` becomes `Context.Service.Shape<typeof X>`, and `Context.Tag.Identifier<typeof X>` becomes `Context.Service.Identifier<typeof X>`. For a tag that is a type parameter, write `Tag["Identifier"]`, as the generated code does. When you assign a generic function to a constant whose type lists overloads, `Context.Service.Identifier<Tag>` in those overloads can resolve to `unknown`, and the assignment then fails with TS2322.

What else changes for a user:

- A handler that runs effects concurrently and fails in one of them now sends that failure's own status. One branch of `Effect.all(..., { concurrency: "unbounded" })` that fails with `NotFound` sends `NotFound`. On Effect 3 the server sent `Code.Internal`, with a message such as `first | Unknown error; Request was canceled`, because the interruption of the other branches was part of the cause. Effect 4 keeps the first failure only.
- A handler that fails or dies leaves no line in the server's log at any level. Effect 3 logged `Fiber terminated with an unhandled error` at DEBUG for it, and Effect 4 has no such line. Log failures in the handler until the library logs failed calls itself (#56).
- A program started with `NodeRuntime.runMain`, as the README's server is, now exits with code 130 after Ctrl+C or SIGTERM. It exited with code 0 on Effect 3. This is Effect 4's convention for a program that a signal stopped. Pass `teardown` to `runMain` to choose another code.
- Effect 4 shares a layer across nested `Effect.provide` calls. A handler that provides a layer the application also provided above `listen` now gets the application's instance, where Effect 3 built a new one for each call. Wrap the layer in `Layer.fresh`, or pass `{ local: true }` to `Effect.provide`, for one instance per call.
- `@effect/opentelemetry` 4 makes the OpenTelemetry SDK packages optional peers, so an application that does not export traces no longer installs them. effect-grpc loads only the `OtelTracer` module of `@effect/opentelemetry`, which needs `@opentelemetry/api` alone. To export traces, install the SDK packages yourself and import the SDK layer from its own module, `import * as NodeSdk from "@effect/opentelemetry/NodeSdk"`. The package root no longer exports it. `@effect/opentelemetry` 4.1 accepts versions 2.x of the SDK packages, and 0.203 to 0.299 of the logs packages. The README gives the install lines.
- A typed call of a generated tag constant, such as `HelloWorldAPIClientTag<Meta>("key")`, still does not compile. In untyped JavaScript the same call now returns `undefined`, where it threw a `TypeError` on Effect 3. Make a typed tag with `makeHelloWorldAPIClientTag<Meta>("key")`.

The `version` field of the package changes from `3.0.0-alpha.5` to `3.0.0` with this change. It is the base that the release tooling computes `4.0.0-alpha.0` from, and no `3.0.0` is published.
