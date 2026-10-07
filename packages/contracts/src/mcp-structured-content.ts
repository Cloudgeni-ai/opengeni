import type { AttemptToolResult } from "./tool-catalog";

/**
 * Remove the backwards-compatibility text copy of an MCP result's
 * `structuredContent`.
 *
 * The MCP specification asks a server that returns `structuredContent` to also
 * return the same value serialized in a text content block. Printing or sending
 * both pays for the payload twice, and the text copy pays again for JSON string
 * escaping inside the result envelope.
 *
 * The envelope (`content`, `structuredContent`, `_meta`, `isError`, extension
 * fields) and its key order are kept. Only a plain `{type: "text", text}` block
 * whose text parses as JSON to a value equal to `structuredContent` is removed.
 * Prose, differing JSON, annotated text, images, resources, and every other
 * block stay. A text block whose JSON carries an integer outside the IEEE-754
 * safe range also stays, because its digits may be more precise than the
 * parsed `structuredContent`. Numbers compare by IEEE-754 value.
 *
 * Results without a removable block are returned as the same object.
 *
 * Callers: the runtime's model-facing MCP projection, and the default
 * `ogtool call` print. The native Connected Machine client implements the
 * same rule in `agent/crates/opengeni-agent/src/codemode.rs`; keep them equal.
 */
export function omitStructuredContentTextDuplicates<T extends AttemptToolResult>(result: T): T {
  const structured: unknown = result.structuredContent;
  if (structured === undefined || structured === null) return result;
  const content = result.content.filter(
    (entry) => !isPlainTextBlock(entry) || !textDuplicatesStructuredContent(entry.text, structured),
  );
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

function textDuplicatesStructuredContent(text: string, structured: unknown): boolean {
  const trimmed = text.replace(/^[ \t\n\r]+/u, "");
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
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key]),
  );
}
