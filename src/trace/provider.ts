import type { Tracer } from "@opentelemetry/api";
import { register, type NodeTracerProvider } from "@arizeai/phoenix-otel";
import type { PhoenixConfig } from "../types.js";

export interface PhoenixRuntime {
  tracer: Tracer;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export function createPhoenixRuntime(config: PhoenixConfig): PhoenixRuntime {
  const provider: NodeTracerProvider = register({
    projectName: config.projectName,
    url: config.endpoint,
    apiKey: config.apiKey,
    batch: config.batch,
    global: false,
  });

  const tracer = provider.getTracer("pi-phoenix");

  return {
    tracer,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}
