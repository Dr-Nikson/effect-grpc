---
"@dr_nikson/effect-grpc": major
---

Remove the debug output, the stubs and the leaked internals, and keep the process running when the HTTP/2 server reports an error (#63)

The server no longer prints a line for every request, connection, session and stream, and the client no longer logs at INFO when it releases its session. The library's own log lines are the ready line, the two stop lines and the server error line, and they go through the Effect logger.

An HTTP/2 CONNECT request now gets Node's 405 response. Before, a debug listener marked it as handled, so the request never got an answer and its stream stayed open.

An error that the HTTP/2 server emits after it starts listening, such as a failed accept of an incoming connection, is logged through the Effect logger as `gRPC server error`, and the process keeps running. A bind failure still fails `listen` with `GrpcServerBindError` and is not logged a second time.

**Breaking.** `GrpcServerBuilder` no longer lists its implementation fields `transformCtx` and `services`. The interface has only `withContextTransformer`, `withService` and `build`.

**Breaking.** `GrpcService`, `withService`, `ConcatServiceTags`, `UniqueTag` and `GrpcClientRuntime#makeExecutor` no longer use `any`, which tightens two bounds. `GrpcService` takes a `Proto` that extends `GenService<GenServiceMethods>` instead of `GenService<any>`, and `withService` takes a `GrpcService<unknown, GenService<GenServiceMethods>, Ctx>`. A service that generated code produces still fits. `ConcatServiceTags` and `UniqueTag` take any type that has a `_Tag`, and `GrpcClientRuntime#makeExecutor` takes a `GrpcClientConfig<never>`, which every `GrpcClientConfig<Service>` fits.

`EffectGrpcServer.ServerExecutor` and `EffectGrpcClient.ClientExecutor` are now exported types. Before, the signatures of `GrpcService` and `GrpcClientRuntime#makeExecutor` named them, but nothing exported them, so a consumer could not write them down.

The package no longer ships `dist/typeUtils.js` and `dist/typeUtils.d.ts`, which nothing imported.
