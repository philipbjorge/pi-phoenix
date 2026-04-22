import stripAnsi from "strip-ansi";

function stripTerminalFormatting(value: string): string {
	return stripAnsi(
		value.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, ""),
	);
}

function sanitizeForJson(
	value: unknown,
	seen = new WeakSet<object>(),
): unknown {
	if (typeof value === "string") return stripTerminalFormatting(value);
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";

	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeForJson(entry, seen));
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		sanitized[key] = sanitizeForJson(entry, seen);
	}
	return sanitized;
}

export function safeStringify(value: unknown): string {
	if (typeof value === "string") return stripTerminalFormatting(value);
	if (value === undefined) return "";
	if (value === null) return "null";

	try {
		return JSON.stringify(sanitizeForJson(value));
	} catch {
		return stripTerminalFormatting(String(value));
	}
}

export function truncateText(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";

	const encoder = new TextEncoder();
	const bytes = encoder.encode(value);

	if (bytes.length <= maxBytes) return value;

	// Binary search for the right character count
	let low = 0;
	let high = value.length;

	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const slice = value.slice(0, mid);
		if (encoder.encode(slice).length <= maxBytes - 3) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}

	return `${value.slice(0, low)}...`;
}

export function captureValue(value: unknown, maxBytes: number): string {
	const text = safeStringify(value);
	return truncateText(text, maxBytes);
}
