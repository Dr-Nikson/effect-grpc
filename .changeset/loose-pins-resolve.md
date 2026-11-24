---
"@dr_nikson/effect-grpc": patch
---

Fix `npm install @dr_nikson/effect-grpc` failing with `ERESOLVE` in a fresh project (#66)

npm 11 stopped on `@opentelemetry/api` 1.10.0, because `@opentelemetry/resources` 2.12.1, which `@effect/opentelemetry` needs, accepts only versions below 1.10.0. The library asked for `@opentelemetry/api` 1.9.0 exactly. It now accepts `>=1.9.0 <1.10.0`, the range that the OpenTelemetry SDK 2 packages support, and npm and pnpm install one copy, 1.9.1.
