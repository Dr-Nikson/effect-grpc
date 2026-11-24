// packages/e2e-tests/readme/modules.d.ts
// Packages that README examples import but no workspace package installs. The README check compiles
// the examples against these declarations, so the examples' own code is still checked. Declare only
// what the README uses.
declare module "@opentelemetry/exporter-trace-otlp-http" {
  import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

  export const OTLPTraceExporter: new (config?: { readonly url?: string }) => SpanExporter;
}
