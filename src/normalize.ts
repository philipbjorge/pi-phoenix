import { captureValue, safeStringify } from "./capture.js";
import type { LlmToolSchema } from "./types.js";

export interface NormalizedToolCall {
	id?: string;
	function?: { name?: string; arguments?: string };
}

/**
 * Extracts plain text from a pi message's content field.
 * Pi messages have content as arrays of typed blocks or plain strings.
 */
export function extractText(
	content: unknown,
	options?: { includeThinking?: boolean },
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return safeStringify(content);

	const includeThinking = options?.includeThinking ?? false;
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; thinking?: string };
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (
			includeThinking &&
			b.type === "thinking" &&
			typeof b.thinking === "string"
		) {
			parts.push(b.thinking);
		}
	}
	return parts.join("\n");
}

function extractThinkingText(content: unknown): string {
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; thinking?: string };
		if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push(b.thinking);
		}
	}
	return parts.join("\n");
}

function appendThinkingDetails(text: string, thinking: string): string {
	if (!thinking.trim()) return text;
	const details = `<details><summary>🧠 Thinking</summary>\n\n${thinking}\n\n</details>`;
	return text.trim() ? `${details}\n\n${text}` : details;
}

function extractTextForPhoenix(content: unknown): string {
	return appendThinkingDetails(
		extractText(content),
		extractThinkingText(content),
	);
}

/**
 * Extracts tool calls from a pi assistant message's content.
 */
export function extractToolCalls(content: unknown): NormalizedToolCall[] {
	if (!Array.isArray(content)) return [];

	const calls: NormalizedToolCall[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as {
			type?: string;
			id?: string;
			name?: string;
			arguments?: unknown;
		};
		if (b.type === "toolCall") {
			calls.push({
				id: b.id,
				function: {
					name: b.name,
					arguments:
						typeof b.arguments === "string"
							? b.arguments
							: safeStringify(b.arguments),
				},
			});
		}
	}
	return calls;
}

/**
 * Normalize pi context messages into OpenInference Message format.
 */
export function normalizeMessages(
	messages: unknown[],
	maxBytes: number,
): Array<{
	role: string;
	content: string;
	toolCalls?: NormalizedToolCall[];
	toolCallId?: string;
}> {
	const result: Array<{
		role: string;
		content: string;
		toolCalls?: NormalizedToolCall[];
		toolCallId?: string;
	}> = [];

	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const m = msg as { role?: string; content?: unknown; toolCallId?: string };
		if (!m.role) continue;

		const text = captureValue(extractTextForPhoenix(m.content), maxBytes);
		const entry: {
			role: string;
			content: string;
			toolCalls?: NormalizedToolCall[];
			toolCallId?: string;
		} = {
			role: m.role === "toolResult" ? "tool" : m.role,
			content: text,
		};

		if (m.role === "assistant") {
			const toolCalls = extractToolCalls(m.content);
			if (toolCalls.length > 0) {
				entry.toolCalls = toolCalls;
			}
		}

		if (m.role === "toolResult" && m.toolCallId) {
			entry.toolCallId = m.toolCallId;
		}

		result.push(entry);
	}

	return result;
}

function byteSize(value: string): number {
	return new TextEncoder().encode(value).length;
}

function previewBlock(value: unknown, maxBytes: number): string {
	const text = extractText(value);
	return captureValue(text, Math.min(maxBytes, 240));
}

export function normalizeToolInput(
	toolName: string,
	input: unknown,
	maxBytes: number,
): string {
	if (!input || typeof input !== "object") {
		return captureValue(input, maxBytes);
	}

	const value = input as Record<string, unknown>;

	if (toolName === "bash" && typeof value.command === "string") {
		return captureValue(value.command, maxBytes);
	}

	if (toolName === "read" && typeof value.path === "string") {
		const parts = [value.path];
		if (typeof value.offset === "number") parts.push(`offset=${value.offset}`);
		if (typeof value.limit === "number") parts.push(`limit=${value.limit}`);
		return captureValue(parts.join(" "), maxBytes);
	}

	if (toolName === "write" && typeof value.path === "string") {
		const content =
			typeof value.content === "string"
				? value.content
				: safeStringify(value.content);
		const parts = [value.path, `write ${byteSize(content)} bytes`];
		if (content.trim()) parts.push(previewBlock(content, maxBytes));
		return captureValue(parts.join("\n"), maxBytes);
	}

	if (toolName === "edit" && typeof value.path === "string") {
		const edits = Array.isArray(value.edits) ? value.edits : [];
		const parts = [
			value.path,
			`${edits.length} edit block${edits.length === 1 ? "" : "s"}`,
		];
		const first = edits[0];
		if (first && typeof first === "object") {
			const block = first as { oldText?: unknown; newText?: unknown };
			parts.push(`old: ${previewBlock(block.oldText, maxBytes)}`);
			parts.push(`new: ${previewBlock(block.newText, maxBytes)}`);
		}
		return captureValue(parts.join("\n"), maxBytes);
	}

	if (toolName === "grep") {
		const parts: string[] = [];
		if (typeof value.pattern === "string") parts.push(value.pattern);
		if (typeof value.path === "string") parts.push(`path=${value.path}`);
		if (typeof value.glob === "string") parts.push(`glob=${value.glob}`);
		return captureValue(parts.join(" "), maxBytes);
	}

	if (toolName === "find") {
		const parts: string[] = [];
		if (typeof value.pattern === "string") parts.push(value.pattern);
		if (typeof value.path === "string") parts.push(`path=${value.path}`);
		return captureValue(parts.join(" "), maxBytes);
	}

	if (toolName === "ls" && typeof value.path === "string") {
		return captureValue(value.path, maxBytes);
	}

	return captureValue(input, maxBytes);
}

export function normalizeSystemPrompt(
	systemPrompt: string | undefined,
	maxBytes: number,
): { role: string; content: string } | undefined {
	if (!systemPrompt?.trim()) return undefined;
	return {
		role: "system",
		content: captureValue(systemPrompt, maxBytes),
	};
}

export function normalizeLlmTools(
	tools: Array<{ name: string; description?: string; parameters?: unknown }>,
): LlmToolSchema[] {
	return tools.map((tool) => ({
		jsonSchema: {
			type: "function",
			function: {
				name: tool.name,
				...(tool.description ? { description: tool.description } : {}),
				parameters: tool.parameters ?? {
					type: "object",
					properties: {},
					additionalProperties: true,
				},
			},
		},
	}));
}

export function normalizeToolOutput(result: unknown, maxBytes: number): string {
	if (!result || typeof result !== "object") {
		return captureValue(result, maxBytes);
	}

	const value = result as {
		content?: unknown;
		details?:
			| { path?: unknown; edits?: unknown; targetFile?: unknown }
			| unknown;
	};
	const text = extractText(value.content);
	if (text.trim()) {
		return captureValue(text, maxBytes);
	}

	const details = value.details;
	if (details && typeof details === "object") {
		const obj = details as {
			path?: unknown;
			edits?: unknown;
			targetFile?: unknown;
		};
		const path =
			typeof obj.path === "string"
				? obj.path
				: typeof obj.targetFile === "string"
					? obj.targetFile
					: undefined;
		if (path && Array.isArray(obj.edits)) {
			return captureValue(
				`applied ${obj.edits.length} edits to ${path}`,
				maxBytes,
			);
		}
		if (path) {
			return captureValue(`wrote ${path}`, maxBytes);
		}
	}

	return captureValue(value.details ?? result, maxBytes);
}

export function assistantHasToolCalls(content: unknown): boolean {
	return extractToolCalls(content).length > 0;
}

export function extractAssistantText(
	content: unknown,
	maxBytes: number,
): string {
	return captureValue(extractTextForPhoenix(content), maxBytes);
}

export function normalizeAssistantOutputMessage(
	content: unknown,
	maxBytes: number,
): { role: string; content: string; toolCalls?: NormalizedToolCall[] } {
	const text = captureValue(extractTextForPhoenix(content), maxBytes);
	const toolCalls = extractToolCalls(content);
	return {
		role: "assistant",
		content: text,
		...(toolCalls.length > 0 ? { toolCalls } : {}),
	};
}

export function normalizeProviderTools(
	payload: unknown,
): LlmToolSchema[] | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return undefined;

	const value = payload as { tools?: unknown; functions?: unknown };
	if (Array.isArray(value.tools)) {
		return value.tools.map((tool) => ({
			jsonSchema: tool as Record<string, unknown>,
		}));
	}
	if (Array.isArray(value.functions)) {
		return value.functions.map((tool) => ({
			jsonSchema: tool as Record<string, unknown>,
		}));
	}
	return undefined;
}

export function normalizeInvocationParameters(
	payload: unknown,
): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return undefined;

	const value = payload as Record<string, unknown>;
	const invocationParameters: Record<string, unknown> = {};

	for (const [key, entry] of Object.entries(value)) {
		if (key === "messages" || key === "input") continue;
		invocationParameters[key] = entry;
	}

	return Object.keys(invocationParameters).length > 0
		? invocationParameters
		: undefined;
}
