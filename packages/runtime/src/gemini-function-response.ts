import type { ModelJsonRequestPolicy } from "./replayable-json-body";

/**
 * Gemini function-response `$ref` projection (request-local only).
 *
 * OpenAI-compatible gateways in front of Gemini (Vercel AI Gateway, Google's
 * own OpenAI-compatible surface, OpenRouter) parse a JSON tool-output string
 * into Gemini's `functionResponse.response` object. Gemini reserves the object
 * key `$ref` there as a pointer to a multimodal `functionResponse.parts` entry
 * by display name, so any ordinary JSON tool result that contains a `$ref` key
 * (for example a JSON Schema returned by `tool_search`) fails the whole request
 * with `400 The referenced name '...' in function_response.response does not
 * match to a display_name in the function_response.parts`.
 *
 * The property belongs to the upstream model family rather than to one route,
 * so the projection keys on a Gemini upstream model id. It rewrites only object
 * KEYS that decode to exactly `$ref`, inside tool outputs that are valid JSON,
 * in a copy-on-write request body. Every other byte is preserved, the result is
 * deterministic (prompt-cache stable), and durable history is never touched.
 */
export const GEMINI_FUNCTION_RESPONSE_REF_KEY_REPLACEMENT = "_$ref";

const GEMINI_UPSTREAM_MODEL = /gemini/iu;
// Cheap prefilter: a `$ref` (or `$ref`) string token followed by a colon.
const CANDIDATE_REF_KEY = /"(?:\$|\\u0024)ref"\s*:/u;

export function isGeminiUpstreamModel(model: unknown): boolean {
  return typeof model === "string" && GEMINI_UPSTREAM_MODEL.test(model);
}

/**
 * Rename every JSON object key that decodes to `$ref` in a valid JSON text.
 * Returns the input string unchanged (same reference) when nothing applies,
 * including non-JSON text, which a gateway does not parse into an object.
 */
export function escapeGeminiFunctionResponseRefKeys(text: string): string {
  if (!CANDIDATE_REF_KEY.test(text)) return text;
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  let output = "";
  let copiedThrough = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== '"') {
      index += text[index] === "\\" ? 2 : 1;
    }
    const end = index; // closing quote
    index += 1;
    let next = index;
    while (next < text.length && /\s/u.test(text[next]!)) next += 1;
    if (text[next] !== ":" || end - start - 1 > 16) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (decoded !== "$ref") continue;
    output += `${text.slice(copiedThrough, start)}${JSON.stringify(
      GEMINI_FUNCTION_RESPONSE_REF_KEY_REPLACEMENT,
    )}`;
    copiedThrough = end + 1;
  }
  return copiedThrough === 0 ? text : output + text.slice(copiedThrough);
}

function projectTextParts(parts: unknown[], textType: string): unknown[] {
  let changed = false;
  const projected = parts.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const record = part as Record<string, unknown>;
    if (record.type !== textType || typeof record.text !== "string") return part;
    const text = escapeGeminiFunctionResponseRefKeys(record.text);
    if (text === record.text) return part;
    changed = true;
    return { ...record, text };
  });
  return changed ? projected : parts;
}

function projectToolResultValue(value: unknown, textType: string): unknown {
  if (typeof value === "string") return escapeGeminiFunctionResponseRefKeys(value);
  if (Array.isArray(value)) return projectTextParts(value, textType);
  return value;
}

const RESPONSES_TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

/**
 * Object-stage request policy for both Responses (`input[]` tool outputs) and
 * Chat Completions (`role: "tool"` messages). Returns undefined when the
 * upstream model is not Gemini or no tool output carries a `$ref` key.
 */
export const geminiFunctionResponseRefPolicy: ModelJsonRequestPolicy = ({ body }) => {
  if (!isGeminiUpstreamModel(body.model)) return undefined;
  if (Array.isArray(body.input)) {
    let changed = false;
    const input = body.input.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const record = item as Record<string, unknown>;
      if (typeof record.type !== "string" || !RESPONSES_TOOL_OUTPUT_TYPES.has(record.type)) {
        return item;
      }
      const output = projectToolResultValue(record.output, "input_text");
      if (output === record.output) return item;
      changed = true;
      return { ...record, output };
    });
    return changed ? { body: { ...body, input } } : undefined;
  }
  if (Array.isArray(body.messages)) {
    let changed = false;
    const messages = body.messages.map((message: unknown) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return message;
      const record = message as Record<string, unknown>;
      if (record.role !== "tool") return message;
      const content = projectToolResultValue(record.content, "text");
      if (content === record.content) return message;
      changed = true;
      return { ...record, content };
    });
    return changed ? { body: { ...body, messages } } : undefined;
  }
  return undefined;
};
