/**
 * A transport-tolerant MCP tool result.
 *
 * `value` is the canonical machine-readable payload after recognized MCP/JSON
 * envelopes are removed. `text` is the best presentation string without
 * discarding structured data. `raw` always retains the original evidence.
 */
export type NormalizedMcpOutput = Readonly<{
  raw: unknown;
  value: unknown;
  text: string;
  isError: boolean;
}>;

const MAX_MCP_OUTPUT_DEPTH = 8;
const RESULT_ENVELOPE_KEYS = new Set(["result", "isError", "jsonrpc", "id", "_meta"]);

/** Normalize common direct, JSON, and standard MCP result envelopes without throwing. */
export function normalizeMcpOutput(output: unknown): NormalizedMcpOutput {
  const normalized = normalizeValue(output, 0, new Set<object>());
  return {
    raw: output,
    value: normalized.value,
    text: normalized.text,
    isError: normalized.isError,
  };
}

type NormalizedValue = Omit<NormalizedMcpOutput, "raw">;

function normalizeValue(value: unknown, depth: number, ancestors: Set<object>): NormalizedValue {
  if (value === null || value === undefined) {
    return { value, text: "", isError: false };
  }
  if (typeof value === "string") {
    return normalizeText(value, depth, ancestors);
  }
  if (typeof value !== "object") {
    return { value, text: String(value), isError: false };
  }
  if (depth >= MAX_MCP_OUTPUT_DEPTH || ancestors.has(value)) {
    return { value, text: safeStringify(value), isError: false };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return { value, text: safeStringify(value), isError: false };
    }

    const record = value as Record<string, unknown>;
    const envelopeError = record.isError === true;

    if (record.type === "text" && typeof record.text === "string") {
      const normalized = normalizeText(record.text, depth + 1, ancestors);
      return {
        value: normalized.value,
        text: record.text,
        isError: envelopeError || normalized.isError,
      };
    }

    if ("structuredContent" in record) {
      const normalized = normalizeValue(record.structuredContent, depth + 1, ancestors);
      return {
        value: normalized.value,
        text: firstMcpText(record.content) ?? normalized.text,
        isError: envelopeError || normalized.isError,
      };
    }

    if (isMcpContent(record.content)) {
      const text = firstMcpText(record.content);
      if (text !== null) {
        const normalized = normalizeText(text, depth + 1, ancestors);
        return {
          value: normalized.value,
          text,
          isError: envelopeError || normalized.isError,
        };
      }
      return {
        value,
        text: safeStringify(value),
        isError: envelopeError,
      };
    }

    if (isResultEnvelope(record)) {
      const normalized = normalizeValue(record.result, depth + 1, ancestors);
      return {
        value: normalized.value,
        text: normalized.text,
        isError: envelopeError || normalized.isError,
      };
    }

    return {
      value,
      text: safeStringify(value),
      isError: envelopeError,
    };
  } finally {
    ancestors.delete(value);
  }
}

function normalizeText(text: string, depth: number, ancestors: Set<object>): NormalizedValue {
  try {
    const parsed: unknown = JSON.parse(text);
    const normalized = normalizeValue(parsed, depth + 1, ancestors);
    return {
      value: normalized.value,
      text,
      isError: normalized.isError,
    };
  } catch {
    return { value: text, text, isError: false };
  }
}

function isMcpContent(value: unknown): value is readonly Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.some(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { type?: unknown }).type === "string",
    )
  );
}

function firstMcpText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const part of value) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return null;
}

function isResultEnvelope(record: Record<string, unknown>): boolean {
  return "result" in record && Object.keys(record).every((key) => RESULT_ENVELOPE_KEYS.has(key));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
