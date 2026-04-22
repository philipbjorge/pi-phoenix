import { SpanStatusCode, context, trace, type Context, type Span, type Tracer } from "@opentelemetry/api";
import {
  OpenInferenceSpanKind,
  setSession,
  setMetadata,
  getAttributesFromContext,
  getLLMAttributes,
  getInputAttributes,
  getOutputAttributes,
} from "@arizeai/phoenix-otel";
import {
  assistantHasToolCalls,
  normalizeAssistantOutputMessage,
  normalizeMessages,
  normalizeSystemPrompt,
  normalizeToolInput,
  normalizeToolOutput,
} from "../normalize.js";
import { captureValue } from "../capture.js";
import type { LlmToolSchema, PendingLlmInput, SessionState, ToolSpanState } from "../types.js";

interface SpanManagerOptions {
  tracer: Tracer;
  maxAttrBytes: number;
}

function previewText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function buildToolSpanName(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return toolName;

  const obj = input as Record<string, unknown>;
  if (toolName === "bash" && typeof obj.command === "string") {
    return `${toolName}: ${previewText(obj.command, 60)}`;
  }
  if (typeof obj.path === "string") {
    return `${toolName}: ${obj.path}`;
  }
  return toolName;
}

export function createSpanManager(options: SpanManagerOptions) {
  const { tracer, maxAttrBytes } = options;

  let state: SessionState | undefined;
  let sessionContext: Context | undefined;
  let turnSpan: Span | undefined;
  let turnContext: Context | undefined;
  let activeLlmSpan: Span | undefined;
  let activeLlmContext: Context | undefined;
  let lastAssistantText: string | undefined;
  const pendingLlmInputs: PendingLlmInput[] = [];
  const toolSpans = new Map<string, ToolSpanState>();

  const safeEnd = (span: Span | undefined): void => {
    span?.end();
  };

  const finalizeActiveLlmSpan = (): void => {
    if (!activeLlmSpan) return;
    safeEnd(activeLlmSpan);
    activeLlmSpan = undefined;
    activeLlmContext = undefined;
  };

  const closeToolSpans = (): void => {
    for (const [id, { span }] of toolSpans) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "orphaned" });
      safeEnd(span);
      toolSpans.delete(id);
    }
  };

  const closeTurnSpan = (): void => {
    if (turnSpan && lastAssistantText) {
      turnSpan.setAttributes(getOutputAttributes(lastAssistantText));
    }
    closeToolSpans();
    finalizeActiveLlmSpan();
    safeEnd(turnSpan);
    turnSpan = undefined;
    turnContext = undefined;
    lastAssistantText = undefined;
    pendingLlmInputs.length = 0;
  };

  return {
    getTraceId(): string | undefined {
      return turnSpan?.spanContext().traceId ?? activeLlmSpan?.spanContext().traceId;
    },

    onSessionStart(args: { sessionId: string; sessionFile?: string; cwd: string; reason?: string }): void {
      closeTurnSpan();

      state = {
        sessionId: args.sessionId,
        sessionFile: args.sessionFile,
        cwd: args.cwd,
        promptCount: 0,
      };

      let ctx = context.active();
      ctx = setSession(ctx, { sessionId: args.sessionId });
      ctx = setMetadata(ctx, {
        cwd: args.cwd,
        ...(args.sessionFile && { sessionFile: args.sessionFile }),
        ...(args.reason && { reason: args.reason }),
      });
      sessionContext = ctx;
    },

    onBeforeAgentStart(args: { prompt: string; images?: number; model?: { provider: string; id: string } }): void {
      if (!sessionContext || !state) return;

      closeTurnSpan();

      state.promptCount += 1;
      const turnIndex = state.promptCount;
      const preview = previewText(args.prompt, 40);
      const spanName = `Turn ${turnIndex}${preview ? `: ${preview}` : ""}`;

      turnSpan = tracer.startSpan(
        spanName,
        {
          attributes: {
            ...getAttributesFromContext(sessionContext),
            "openinference.span.kind": OpenInferenceSpanKind.AGENT,
            "pi.turn.index": turnIndex,
            ...(args.images && { "pi.turn.images": args.images }),
            ...(args.model && {
              "llm.provider": args.model.provider,
              "llm.model_name": args.model.id,
            }),
            ...getInputAttributes(args.prompt),
          },
        },
        sessionContext,
      );
      turnContext = trace.setSpan(sessionContext, turnSpan);
      lastAssistantText = undefined;
    },

    onContext(args: { messages: unknown[]; systemPrompt?: string; tools?: LlmToolSchema[] }): void {
      if (!turnSpan) return;

      finalizeActiveLlmSpan();
      pendingLlmInputs.push({
        startedAt: Date.now(),
        messages: args.messages,
        systemPrompt: args.systemPrompt,
        tools: args.tools,
      });
    },

    onBeforeProviderRequest(args: {
      payload: unknown;
      invocationParameters?: Record<string, unknown>;
      tools?: LlmToolSchema[];
    }): void {
      if (!turnSpan) return;

      for (const pending of pendingLlmInputs) {
        if (!pending.providerPayload) {
          pending.providerPayload = captureValue(args.payload, maxAttrBytes);
          pending.invocationParameters = args.invocationParameters;
          pending.tools = args.tools ?? pending.tools;
          return;
        }
      }
    },

    onMessageEnd(args: {
      role: string;
      provider?: string;
      model?: string;
      content?: unknown;
      rawMessage?: unknown;
      usage?: {
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
      };
      stopReason?: string;
      isError?: boolean;
    }): void {
      if (args.role !== "assistant") return;
      if (!turnSpan || !turnContext) return;

      const pending = pendingLlmInputs.shift();
      const inputMsgs = pending ? normalizeMessages(pending.messages, maxAttrBytes) : [];
      const systemPrompt = normalizeSystemPrompt(pending?.systemPrompt, maxAttrBytes);
      const inputMessages = systemPrompt ? [systemPrompt, ...inputMsgs] : inputMsgs;
      const outputMessage = normalizeAssistantOutputMessage(args.content, maxAttrBytes);
      lastAssistantText = outputMessage.content;
      const keepOpenForTools = assistantHasToolCalls(args.content);

      const llmAttrs = getLLMAttributes({
        provider: args.provider,
        system: args.provider,
        modelName: args.model,
        invocationParameters: pending?.invocationParameters,
        inputMessages: inputMessages.length > 0 ? inputMessages : undefined,
        outputMessages: [outputMessage],
        tools: pending?.tools,
        tokenCount: args.usage
          ? {
              prompt: args.usage.input,
              completion: args.usage.output,
              total: args.usage.total ?? (args.usage.input ?? 0) + (args.usage.output ?? 0),
              promptDetails: {
                cacheRead: args.usage.cacheRead,
                cacheWrite: args.usage.cacheWrite,
              },
            }
          : undefined,
      });

      const llmSpan = tracer.startSpan(
        args.model ? `${args.provider}/${args.model}` : "llm",
        {
          attributes: {
            "openinference.span.kind": OpenInferenceSpanKind.LLM,
            ...llmAttrs,
            ...(args.usage?.reasoning !== undefined && {
              "llm.token_count.completion_details.reasoning": args.usage.reasoning,
            }),
            ...(args.usage?.cost !== undefined && { "llm.cost.total": args.usage.cost }),
            ...((args.usage?.inputCost !== undefined ||
              args.usage?.cacheReadCost !== undefined ||
              args.usage?.cacheWriteCost !== undefined) && {
              "llm.cost.prompt":
                (args.usage?.inputCost ?? 0) +
                (args.usage?.cacheReadCost ?? 0) +
                (args.usage?.cacheWriteCost ?? 0),
            }),
            ...(args.usage?.outputCost !== undefined && { "llm.cost.completion": args.usage.outputCost }),
            ...(args.usage?.inputCost !== undefined && {
              "llm.cost.prompt_details.input": args.usage.inputCost,
            }),
            ...(args.usage?.cacheReadCost !== undefined && {
              "llm.cost.prompt_details.cache_read": args.usage.cacheReadCost,
            }),
            ...(args.usage?.cacheWriteCost !== undefined && {
              "llm.cost.prompt_details.cache_write": args.usage.cacheWriteCost,
            }),
            ...(args.usage?.outputCost !== undefined && {
              "llm.cost.completion_details.output": args.usage.outputCost,
            }),
            ...(args.usage?.upstreamInferenceCost !== undefined && {
              "openrouter.cost.upstream_inference_cost": args.usage.upstreamInferenceCost,
            }),
            ...(pending?.providerPayload && {
              "input.value": pending.providerPayload,
              "input.mime_type": "application/json",
              "pi.provider.request_payload": pending.providerPayload,
            }),
            ...(args.stopReason && { "llm.finish_reason": args.stopReason }),
            ...(args.rawMessage !== undefined && {
              "output.value": captureValue(args.rawMessage, maxAttrBytes),
              "output.mime_type": "application/json",
            }),
          },
          startTime: pending?.startedAt,
        },
        turnContext,
      );

      if (args.isError) {
        llmSpan.setStatus({ code: SpanStatusCode.ERROR });
      }

      if (keepOpenForTools) {
        finalizeActiveLlmSpan();
        activeLlmSpan = llmSpan;
        activeLlmContext = trace.setSpan(turnContext, llmSpan);
        return;
      }

      llmSpan.end();
    },

    onToolExecutionStart(args: { toolCallId: string; toolName: string; input: unknown }): void {
      const parentContext = activeLlmContext ?? turnContext;
      if (!parentContext) return;

      const span = tracer.startSpan(
        buildToolSpanName(args.toolName, args.input),
        {
          attributes: {
            "openinference.span.kind": OpenInferenceSpanKind.TOOL,
            "tool.name": args.toolName,
            "tool.call_id": args.toolCallId,
            ...getInputAttributes(normalizeToolInput(args.toolName, args.input, maxAttrBytes)),
          },
        },
        parentContext,
      );

      toolSpans.set(args.toolCallId, {
        span,
        startedAt: Date.now(),
        toolName: args.toolName,
      });
    },

    onToolExecutionEnd(args: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean }): void {
      const entry = toolSpans.get(args.toolCallId);
      if (!entry) return;

      const { span } = entry;
      span.setAttributes(getOutputAttributes(normalizeToolOutput(args.result, maxAttrBytes)));

      if (args.isError) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
      toolSpans.delete(args.toolCallId);
    },

    onAgentEnd(): void {
      closeTurnSpan();
    },

    shutdown(): void {
      closeTurnSpan();
      sessionContext = undefined;
      state = undefined;
    },
  };
}

export type SpanManager = ReturnType<typeof createSpanManager>;
