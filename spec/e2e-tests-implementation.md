# E2E Test Package Implementation Plan

## Overview
Create a separate private package for end-to-end testing with `@effect/vitest` and dynamic port allocation using `get-port-please`.

## Goals
- Test client-server interactions in a real gRPC environment
- Use dynamic port allocation to avoid conflicts
- Leverage Effect's scoped resource management
- Follow project structure and conventions

## Technology Stack
- **Testing Framework**: `@effect/vitest` - Effect-native testing with Vitest
- **Port Management**: `get-port-please` - Dynamic available port allocation
- **gRPC**: Effect-gRPC library (workspace dependency)
- **Protocol Buffers**: Buf for code generation

## Implementation Checklist

### 1. Update Root Configuration
- [ ] Add `"packages/e2e-tests"` to `package.json` workspaces array
- [ ] Update root test script: `"test": "pnpm -r run test"`
- [ ] Update root test:types script if needed

### 2. Create Package Structure
- [ ] Create `packages/e2e-tests/` directory
- [ ] Create `packages/e2e-tests/package.json` with:
  - [ ] Set `"private": true`
  - [ ] Add `@dr_nikson/effect-grpc: "workspace:*"` dependency
  - [ ] Add `@effect/vitest` (install it to catalog first) from catalog
  - [ ] Add `get-port-please` as devDependency
  - [ ] Add Effect, Connect, Buf dependencies from catalog
  - [ ] Add scripts: `generate:proto`, `build`, `test`
- [ ] Create `packages/e2e-tests/tsconfig.json` extending `../../tsconfig.base.json`
- [ ] Create `packages/e2e-tests/vitest.config.ts` for runtime tests

### 3. Protocol Buffers Setup
- [ ] Create `packages/e2e-tests/proto/com/example/v1/` directory structure
- [ ] Copy `hello_world_api.proto` from example package
- [ ] Create `packages/e2e-tests/buf.gen.yaml` (copy from example)
- [ ] Run `pnpm generate:proto` to generate TypeScript bindings

### 4. E2E Test Implementation (`src/index.test.ts`)
- [ ] Import `it` from `@effect/vitest`
- [ ] Import `getPort` from `get-port-please`
- [ ] Import generated proto types and service definitions
- [ ] Implement server service with both RPCs:
  - [ ] `getGreeting` - returns success response
  - [ ] `faceTheError` - returns GrpcException
- [ ] Write test using `it.scoped`:
  - [ ] Get available port with `getPort()`
  - [ ] Start server on dynamic port
  - [ ] Create client configured to same port
  - [ ] Provide all required layers
  - [ ] Test successful `getGreeting` call
  - [ ] Test error handling for `faceTheError`
  - [ ] Verify proper cleanup via Effect scopes

### 5. Build and Test
- [ ] Run `pnpm --filter ./packages/e2e-tests run build`
- [ ] Run `pnpm --filter ./packages/e2e-tests run test`
- [ ] Verify tests pass
- [ ] Run from root: `pnpm -r run test`

### 6. Code Style and Quality
- [ ] Run `pnpm run codestyle:fix`
- [ ] Run `pnpm run lint`
- [ ] Fix any issues
- [ ] Run full monorepo build: `pnpm -r run build`

## Test Structure

### Test Flow
1. **Setup Phase** (within `it.scoped`):
   - Get available port dynamically
   - Create and configure server with service implementation
   - Start server on dynamic port
   - Create client configured to connect to server

2. **Test Execution**:
   - Test successful RPC calls
   - Test error handling and exceptions
   - Verify request/response data

3. **Cleanup Phase** (automatic):
   - Effect Scope handles server shutdown
   - Resources are cleaned up properly

### Expected Test Cases
1. **Successful RPC Call** (`getGreeting`):
   - Send request with name
   - Verify greeting response format
   - Check response contains expected data

2. **Error Handling** (`faceTheError`):
   - Send request that triggers error
   - Verify GrpcException is thrown
   - Check error code matches expected (FailedPrecondition)
   - Verify error message

## Key Implementation Details

### Dynamic Port Allocation
```typescript
import { getPort } from "get-port-please"

// Get available port before starting server
const port = await getPort()
```

### Effect Scoped Testing
```typescript
import { it } from "@effect/vitest"

it.scoped("E2E test", () =>
  Effect.gen(function* () {
    const port = yield* Effect.promise(() => getPort())
    const server = yield* createServer()
    yield* server.run({ host: "localhost", port })
    // Test logic...
  })
)
```

### Layer Composition
- Server service layer (with RPC implementations)
- Client runtime layer
- Logger configuration layer
- Scope layer for resource management

## Dependencies to Add

### Package-specific
- `get-port-please`: `^3.2.0` (or latest)

### From Catalog
- `@effect/vitest`
- `@effect/platform`
- `@effect/platform-node`
- `effect`
- `vitest`
- `@bufbuild/buf`
- `@bufbuild/protobuf`
- `@bufbuild/protoc-gen-es`
- `@connectrpc/connect`
- `@connectrpc/connect-node`
- `typescript`

## References
- Example implementation: `packages/example/src/client.ts` and `packages/example/src/server.ts`
- @effect/vitest documentation: https://github.com/Effect-TS/effect/tree/main/packages/vitest
- get-port-please: https://github.com/unjs/get-port-please