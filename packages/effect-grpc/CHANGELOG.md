# @dr_nikson/effect-grpc

## 3.0.0-alpha.2

### Minor Changes

- [#32](https://github.com/Dr-Nikson/effect-grpc/pull/32) [`8764bc8`](https://github.com/Dr-Nikson/effect-grpc/commit/8764bc8b73209338aed894173bc860b061a6f36d) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - fix(server): enforce context type safety in GrpcServerBuilder

  **Breaking Change:** `GrpcServerBuilder()` now returns `GrpcServerBuilder<unknown, never>` instead of `GrpcServerBuilder<any, never>`.

  This fixes a critical type safety issue where services with specific context requirements (like `HandlerContext`) could be incorrectly added to a builder that doesn't provide that context. The previous behavior using `any` bypassed all type checking.

  **Migration:**

  Services with specific context types now require `withContextTransformer` before being added:

  ```typescript
  // Before (broken - compiled but failed at runtime)
  const server = GrpcServerBuilder()
  .withService(myHandlerContextService)
  .build();

  // After (correct)
  const server = GrpcServerBuilder()
  .withContextTransformer((ctx) => Effect.succeed(ctx))
  .withService(myHandlerContextService)
  .build();
  ```

  Services with `any` context can still be added directly without transformation.

  Fixes #31

## 3.0.0-alpha.1

### Major Changes

- [#25](https://github.com/Dr-Nikson/effect-grpc/pull/25) [`9346226`](https://github.com/Dr-Nikson/effect-grpc/commit/934622682aceb4451b673b10ff2c84b740e5c212) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - Refactor code generator API structure and add comprehensive JSDoc documentation

  **Breaking Changes:**
  - Service layer API: `Service.liveLayer(service)(tag)` → `serviceLiveLayer(tag, service)`
  - Client tag API: `Client.makeTag<Meta>("key")` → `ClientTag<Meta>("key")`
  - Client layer API: `Client.liveLayer(tag)` → `clientLiveLayer(tag)`
  - Service ID naming: `ServiceId` → `ServiceProtoId`
  - Default context type changed from `HandlerContext` to `any` for better flexibility

  **Improvements:**
  - Added comprehensive JSDoc documentation with usage examples for all generated exports
  - Fixed nested comment syntax in JSDoc that was breaking TypeScript parsing
  - Fixed import paths in JSDoc examples to use correct proto file basename
  - Improved type signature formatting for better readability
  - Simplified API with direct exports instead of namespace objects
  - Updated transformCtx signature to only accept HandlerContext as input
  - Support dual-context transformation API in withContextTransformer

  Closes #13, #24

## 3.0.0-alpha.0

### Major Changes

- [#3](https://github.com/Dr-Nikson/effect-grpc/pull/3) [`bd982f3`](https://github.com/Dr-Nikson/effect-grpc/commit/bd982f32cb07293538deb40e15fc2248f148bb33) Thanks [@Dr-Nikson](https://github.com/Dr-Nikson)! - gRPC Library with effect 3.0 supported
