---
"@dr_nikson/effect-grpc": major
---

Keep the process running when an interrupt stops `listen` on a taken port, hide the builder's fields, and export the executor types (#63)

When an interrupt stops `listen` on a taken port, for example because a sibling layer failed while the server layer started, the process keeps running. `listen` keeps an `'error'` listener on the HTTP/2 server for the server's whole life, so the `EADDRINUSE` that Node reports afterwards is never an uncaught exception.

The client no longer logs at INFO when it releases its HTTP/2 session.

**Breaking.** `GrpcServerBuilder` no longer lists its implementation fields `transformCtx` and `services`. The interface has only `withContextTransformer`, `withService` and `build`.

`EffectGrpcServer.ServerExecutor` and `EffectGrpcClient.ClientExecutor` are now exported types. Before, the signatures of `GrpcService` and `GrpcClientRuntime#makeExecutor` named them, but nothing exported them, so a consumer could not write them down.

The package no longer ships `dist/typeUtils.js` and `dist/typeUtils.d.ts`, which nothing imported.
