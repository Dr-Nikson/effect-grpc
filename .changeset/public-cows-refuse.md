---
"@dr_nikson/effect-grpc": major
---

Refactor code generator API structure and add comprehensive JSDoc documentation

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
