// packages/effect-grpc/readme-check/modules.d.ts
declare module "@opentelemetry/exporter-trace-otlp-http" {
  import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

  export const OTLPTraceExporter: new (config?: { readonly url?: string }) => SpanExporter;
}
