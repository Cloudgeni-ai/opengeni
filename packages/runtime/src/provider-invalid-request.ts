/**
 * The bounded signature of a provider's 400 invalid-request error, for the
 * monitoring-only `opengeni_model_invalid_requests_total` counter: the
 * request path the provider names with every index collapsed
 * (`input[].tools[].name`) and its error code. A new class of malformed
 * request then shows up as a new path before people report it. It never
 * carries the message, values or ids, and it never affects the request.
 */
export type InvalidRequestSignature = { path: string; code: string };

const MAX_BODY_CHARACTERS = 64 * 1024;
const MAX_PATH_CHARACTERS = 96;
const PATH_CHARACTERS = /^[A-Za-z_][A-Za-z0-9_.[\]*]*$/;
const CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/**
 * A request path inside a message, such as `messages.3.content.0.tool_use.name:`
 * (Claude) or `[input[26].tools[1].name]` (a gateway). Only these request
 * roots count, so no other word of a message is ever taken for a path.
 */
const EMBEDDED_PATH =
  /\b((?:input|messages|tools|tool_choice|contents|system|instructions)(?:\[\d+\]|\.\d+|\.[A-Za-z_]\w*)+)/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `input[26].tools[1].name` and `messages.3.content.0` with every index as
 * `[]`, and a tool schema's property names as `*`, so the label stays
 * structural and bounded.
 */
function normalizedPath(raw: string): string | null {
  const path = raw
    .trim()
    .replace(/\[\d+\]/g, "[]")
    .replace(/\.\d+(?=\.|\[|$)/g, "[]")
    .replace(/\.properties\.[A-Za-z0-9_-]+/g, ".properties.*");
  return path.length <= MAX_PATH_CHARACTERS && PATH_CHARACTERS.test(path) ? path : null;
}

function errorCode(error: Record<string, unknown>): string {
  for (const candidate of [error.code, error.type]) {
    if (typeof candidate === "string" && CODE.test(candidate)) return candidate;
  }
  return "unknown";
}

function errorRecord(body: unknown): Record<string, unknown> {
  const envelope = record(body);
  return record(envelope?.error) ?? envelope ?? {};
}

/** The message of a parsed provider error body, never recorded. */
export function invalidRequestMessage(body: unknown): string {
  const message = errorRecord(body).message;
  return typeof message === "string" ? message : "";
}

/** The signature of a parsed provider error body (OpenAI, Claude, gateways). */
export function invalidRequestSignature(body: unknown): InvalidRequestSignature {
  const error = errorRecord(body);
  const message = typeof error.message === "string" ? error.message : "";
  const raw =
    (typeof error.param === "string" && error.param) || EMBEDDED_PATH.exec(message)?.[1] || null;
  return { path: (raw && normalizedPath(raw)) || "unknown", code: errorCode(error) };
}

/** A provider error body's text, parsed; text that is not JSON is its message. */
export function parseInvalidRequestText(text: string): unknown {
  if (text.length > MAX_BODY_CHARACTERS) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** A 400 response's error body, read from a clone; null when unreadable. */
export async function invalidRequestBodyOfResponse(response: Response): Promise<unknown> {
  try {
    return parseInvalidRequestText(await response.clone().text());
  } catch {
    return null;
  }
}

/** The signature of a 400 response's body, read from a clone; null when unreadable. */
export async function invalidRequestSignatureOfResponse(
  response: Response,
): Promise<InvalidRequestSignature | null> {
  const body = await invalidRequestBodyOfResponse(response);
  return body === null ? null : invalidRequestSignature(body);
}
