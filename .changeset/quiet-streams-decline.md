---
"@dr_nikson/effect-grpc": patch
---

Compile the generated server for a service that mixes unary and streaming rpcs (#100)

A proto service with a streaming rpc next to unary ones made the generated server fail `tsc` with TS2739, so you could not serve even its unary rpcs. The generated server now compiles. Its unary rpcs work as they do for a unary-only service. A call to a streaming rpc gets the status `UNIMPLEMENTED` over gRPC, gRPC-web and Connect.

The cause was the type of the implementation that `GrpcService` takes, which asked for a handler for every method of the service. That type is now `EffectGrpcServer.GrpcServiceImplementation`. It requires a handler for each unary method and lets you leave out any other method. A full Connect `ServiceImpl` still fits, and a missing unary method is still a compile error. The generator's output does not change, so code that you generated earlier compiles after you upgrade the library. If you read `service.implementation(executor)` yourself, its streaming members are now optional.

Connect answers a streaming rpc before the library's executor runs, so such a call gets no server span and no context transformer.

Known limitation: a service whose rpcs are all streaming still fails `tsc` under `noUnusedParameters`, because with no unary rpc nothing reads the generated `Ctx`, `Meta`, `service` and `executor`. It has nothing to serve until streaming support (#94) lands.
