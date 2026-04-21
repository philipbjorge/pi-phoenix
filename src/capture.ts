export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (value === null) return "null";

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
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

  return value.slice(0, low) + "...";
}

export function captureValue(value: unknown, maxBytes: number): string {
  const text = safeStringify(value);
  return truncateText(text, maxBytes);
}
