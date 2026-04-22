export interface PhoenixConfig {
  enabled: boolean;
  projectName: string;
  endpoint: string;
  apiKey?: string;
  batch: boolean;
  maxAttrBytes: number;
}

export interface SessionState {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  promptCount: number;
}

export interface LlmToolSchema {
  jsonSchema: string | Record<string, unknown>;
}

export interface PendingLlmInput {
  startedAt: number;
  messages: unknown[];
  systemPrompt?: string;
  tools?: LlmToolSchema[];
  providerPayload?: string;
  invocationParameters?: Record<string, unknown>;
}

export interface ToolSpanState {
  span: import("@opentelemetry/api").Span;
  startedAt: number;
  toolName: string;
}
