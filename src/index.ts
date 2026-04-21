import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getConfig } from "./config.js";
import { createPhoenixRuntime, type PhoenixRuntime } from "./trace/provider.js";
import { createSpanManager, type SpanManager } from "./trace/span-manager.js";

const STATUS_KEY = "pi-phoenix";

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function getPhoenixBaseUrl(endpoint: string): string {
  const normalized = stripTrailingSlashes(endpoint);
  if (normalized.endsWith("/v1/traces")) {
    return normalized.slice(0, -"/v1/traces".length);
  }
  return normalized;
}

function hyperlink(label: string, url: string): string {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function getSessionUrl(endpoint: string, sessionId: string): string {
  return `${getPhoenixBaseUrl(endpoint)}/redirects/sessions/${encodeURIComponent(sessionId)}`;
}

function getSessionId(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager as { getSessionId?: () => string };
  return sm.getSessionId?.() ?? "unknown";
}

function getSessionFile(ctx: ExtensionContext): string | undefined {
  const sm = ctx.sessionManager as { getSessionFile?: () => string | undefined };
  return sm.getSessionFile?.();
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractUsage(message: unknown): {
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: number;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  upstreamInferenceCost?: number;
} | undefined {
  if (!message || typeof message !== "object") return undefined;
  const msg = message as { role?: string; usage?: Record<string, unknown> };
  if (msg.role !== "assistant" || !msg.usage) return undefined;

  const usage = msg.usage;
  const promptDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const completionDetails =
    usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : undefined;
  const cost =
    usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>) : undefined;
  const costDetails =
    usage.cost_details && typeof usage.cost_details === "object"
      ? (usage.cost_details as Record<string, unknown>)
      : undefined;

  return {
    input: readNumber(usage.input) ?? readNumber(usage.prompt_tokens),
    output: readNumber(usage.output) ?? readNumber(usage.completion_tokens),
    total: readNumber(usage.total) ?? readNumber(usage.totalTokens) ?? readNumber(usage.total_tokens),
    cacheRead: readNumber(usage.cacheRead) ?? readNumber(promptDetails?.cached_tokens),
    cacheWrite: readNumber(usage.cacheWrite) ?? readNumber(promptDetails?.cache_write_tokens),
    reasoning: readNumber(usage.reasoning) ?? readNumber(completionDetails?.reasoning_tokens),
    cost: readNumber(usage.cost) ?? readNumber(cost?.total),
    inputCost: readNumber(cost?.input),
    outputCost: readNumber(cost?.output),
    cacheReadCost: readNumber(cost?.cacheRead),
    cacheWriteCost: readNumber(cost?.cacheWrite),
    upstreamInferenceCost: readNumber(costDetails?.upstream_inference_cost),
  };
}

function extractStopReason(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const msg = message as { role?: string; stopReason?: string };
  if (msg.role !== "assistant") return undefined;
  return msg.stopReason;
}

function extractContent(message: unknown): unknown {
  if (!message || typeof message !== "object") return undefined;
  const msg = message as { content?: unknown };
  return msg.content;
}

function extractProviderModel(
  message: unknown,
  ctx: ExtensionContext,
): { provider?: string; model?: string } {
  if (message && typeof message === "object") {
    const msg = message as { provider?: unknown; model?: unknown; api?: unknown };
    const provider = typeof msg.provider === "string" ? msg.provider : typeof msg.api === "string" ? msg.api : undefined;
    const model = typeof msg.model === "string" ? msg.model : undefined;
    if (provider || model) {
      return { provider, model };
    }
  }

  return {
    provider: ctx.model ? String(ctx.model.provider) : undefined,
    model: ctx.model?.id,
  };
}

export default function piPhoenixExtension(pi: ExtensionAPI): void {
  const config = getConfig();

  if (!config.enabled) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "phoenix off");
    });
    return;
  }

  let runtime: PhoenixRuntime | undefined;
  let spanManager: SpanManager | undefined;

  const ensureRuntime = (): { runtime: PhoenixRuntime; spanManager: SpanManager } => {
    if (!runtime) {
      runtime = createPhoenixRuntime(config);
      spanManager = createSpanManager({
        tracer: runtime.tracer,
        maxAttrBytes: config.maxAttrBytes,
      });
    }
    return { runtime: runtime!, spanManager: spanManager! };
  };

  pi.on("session_start", async (event, ctx) => {
    const { spanManager } = ensureRuntime();
    const sessionId = getSessionId(ctx);

    spanManager.onSessionStart({
      sessionId,
      sessionFile: getSessionFile(ctx),
      cwd: ctx.cwd,
      reason: event.reason,
    });

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        hyperlink("phoenix session ↗", getSessionUrl(config.endpoint, sessionId)),
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!spanManager) return;

    spanManager.onBeforeAgentStart({
      prompt: event.prompt,
      images: event.images?.length,
      model: ctx.model ? { provider: String(ctx.model.provider), id: ctx.model.id } : undefined,
    });
  });

  pi.on("context", async (event) => {
    if (!spanManager) return;
    spanManager.onContext({ messages: event.messages });
  });

  pi.on("message_end", async (event, ctx) => {
    if (!spanManager) return;

    const msg = event.message as { role?: string };
    if (msg?.role !== "assistant") return;

    const modelInfo = extractProviderModel(event.message, ctx);
    spanManager.onMessageEnd({
      role: "assistant",
      provider: modelInfo.provider,
      model: modelInfo.model,
      content: extractContent(event.message),
      usage: extractUsage(event.message),
      stopReason: extractStopReason(event.message),
    });
  });

  pi.on("tool_execution_start", async (event) => {
    if (!spanManager) return;

    spanManager.onToolExecutionStart({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.args,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    if (!spanManager) return;

    spanManager.onToolExecutionEnd({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    });
  });

  pi.on("agent_end", async () => {
    if (!spanManager || !runtime) return;

    spanManager.onAgentEnd();
    await runtime.forceFlush();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!spanManager || !runtime) return;

    spanManager.shutdown();
    await runtime.shutdown();

    runtime = undefined;
    spanManager = undefined;

    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
