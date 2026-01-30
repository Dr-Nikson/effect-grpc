---
"@dr_nikson/effect-grpc": minor
---

fix(server): enforce context type safety in GrpcServerBuilder

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

