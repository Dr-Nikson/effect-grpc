// packages/e2e-tests/readme/modules.d.ts
declare module "@opentelemetry/exporter-trace-otlp-http" {
  import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

  export const OTLPTraceExporter: new (config?: { readonly url?: string }) => SpanExporter;
}
