import type { AttemptToolResult as AttemptToolResultValue } from "@opengeni/contracts";

/**
 * Model-visible projection of one MCP `tools/call` result.
 *
 * The MCP specification asks a server that returns `structuredContent` to also
 * return the same value serialized in a text content block for backwards
 * compatibility. Sending both to the model pays for the payload twice, and the
 * text copy pays again for JSON string escaping inside the result envelope.
 *
 * This keeps the envelope shape (`content`, `structuredContent`, `_meta`,
 * `isError`) and removes only plain text blocks whose text is exactly a JSON
 * serialization of `structuredContent`. Prose, differing JSON, annotated text,
 * images, resources, and every other content block are retained, so the model
 * loses no information. A text block whose JSON carries an integer beyond the
 * IEEE-754 safe range is retained too, because its digits are more precise
 * than the parsed `structuredContent`.
 *
 * This is a model-input projection only. The exact result remains the durable
 * event/audit truth, and already-stored history rows are never rewritten.
 * Results without a removable duplicate are returned as the same object, so
 * their serialized bytes are unchanged.
 */
export function modelVisibleMcpResult(result: AttemptToolResultValue): AttemptToolResultValue {
  if (result.structuredContent === undefined || result.structuredContent === null) return result;
  const structured = result.structuredContent;
  let compact: string | undefined;
  const content = result.content.filter((entry) => {
    if (!isPlainTextBlock(entry)) return true;
    compact ??= JSON.stringify(structured);
    return !textDuplicatesStructuredContent(entry.text, structured, compact);
  });
  if (content.length === result.content.length) return result;
  return { ...result, content };
}

function isPlainTextBlock(entry: unknown): entry is { type: "text"; text: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") return false;
  // Annotations or _meta are block-level facts the structured value lacks.
  return Object.keys(record).every((key) => key === "type" || key === "text");
}

function textDuplicatesStructuredContent(
  text: string,
  structured: unknown,
  compact: string,
): boolean {
  if (text === compact) return true;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return !containsUnsafeInteger(parsed) && jsonValuesEqual(parsed, structured);
}

function containsUnsafeInteger(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(containsUnsafeInteger);
  if (value && typeof value === "object") return Object.values(value).some(containsUnsafeInteger);
  return false;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key]),
  );
}
