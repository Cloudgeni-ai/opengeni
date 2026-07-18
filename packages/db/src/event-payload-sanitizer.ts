import { boundSessionEventPayload } from "@opengeni/contracts";

/**
 * Last line of defense against a session event crashing a whole turn.
 *
 * Postgres `text`/`jsonb` cannot store a NUL byte (U+0000) nor lone UTF-16
 * surrogates. Raw exec output routinely carries both -- chrome/crashpad logs,
 * `cat` of a binary, random bytes -- and the worker persists that output verbatim
 * inside `agent.toolCall.output` / `sandbox.command.output` event payloads. When
 * such a payload reaches `INSERT INTO session_events`, the driver rejects it
 * ("Failed query: insert into session_events") and the turn dies.
 *
 * `sanitizeEventPayload` deep-walks any payload value (objects, arrays, nested),
 * repairs every string, redacts sensitive fields, then applies the canonical
 * byte-bounded human/audit preview. Conversation truth uses
 * `sanitizeModelPayload` below and remains a separate representation.
 */

const REPLACEMENT = "�";
const REDACTED = "[redacted]";
const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "headers",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "apikey",
  "secret",
  "clientsecret",
  "credential",
  "credentialencrypted",
  "encryptedpkceverifier",
  "codeverifier",
]);

/**
 * Strip NUL and repair invalid/lone UTF-16 surrogates in a single string.
 * Returns the input unchanged (same reference) when it is already clean, so the
 * common case allocates nothing.
 */
export function sanitizeEventString(value: string): string {
  // Fast path: no NUL and no surrogate code unit at all -> nothing to do.
  // Surrogates live in U+D800..U+DFFF; a quick scan avoids the rebuild cost.
  let needsWork = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0000 || (code >= 0xd800 && code <= 0xdfff)) {
      needsWork = true;
      break;
    }
  }
  if (!needsWork) {
    return value;
  }

  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0000) {
      // Drop NUL entirely.
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: valid only when immediately followed by a low surrogate.
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i]! + value[i + 1]!;
        i += 1;
        continue;
      }
      out += REPLACEMENT;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate (a valid pair would have been consumed above).
      out += REPLACEMENT;
      continue;
    }
    out += value[i]!;
  }
  return out;
}

/**
 * Deep-walk a session event payload and sanitize every string value. Mirrors the
 * shape of the worker redaction deep-walk: objects, arrays, and nested
 * combinations are traversed; non-string leaves pass through untouched. Object
 * keys are sanitized too -- they are jsonb-constrained the same as values.
 */
export function sanitizeEventPayload<T>(payload: T): T {
  return boundSessionEventPayload(sanitizeEventPayloadDeep(payload));
}

function sanitizeEventPayloadDeep<T>(payload: T): T {
  if (typeof payload === "string") {
    return sanitizeEventString(payload) as unknown as T;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeEventPayloadDeep(item)) as unknown as T;
  }
  if (payload && typeof payload === "object") {
    const entries = Object.entries(payload as Record<string, unknown>).map(
      ([key, value]) =>
        [sanitizeEventString(key), sanitizeSensitiveEventField(key, value)] as const,
    );
    return Object.fromEntries(entries) as unknown as T;
  }
  return payload;
}

/**
 * Make model-facing conversation data safe for Postgres without redacting it.
 *
 * Session events are an audit/UI projection and deliberately redact fields such
 * as `token` and `authorization`. Conversation history is the replay source for
 * the model, so applying event redaction there silently changes tool arguments
 * and can make recovery diverge from the call that actually ran. This walker
 * performs only the database-safety repair (NUL removal and UTF-16 repair).
 */
export function sanitizeModelPayload<T>(payload: T): T {
  if (typeof payload === "string") {
    return sanitizeEventString(payload) as unknown as T;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeModelPayload(item)) as unknown as T;
  }
  if (payload && typeof payload === "object") {
    return Object.fromEntries(
      Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
        sanitizeEventString(key),
        sanitizeModelPayload(value),
      ]),
    ) as unknown as T;
  }
  return payload;
}

function sanitizeSensitiveEventField(key: string, value: unknown): unknown {
  if (key === "mcpServers") {
    return sanitizeSessionMcpServerList(value);
  }
  if (key === "mcpCredentialUpdates") {
    return sanitizeMcpCredentialUpdateList(value);
  }
  if (SENSITIVE_FIELD_NAMES.has(normalizeFieldName(key))) {
    return REDACTED;
  }
  return sanitizeEventPayloadDeep(value);
}

function sanitizeSessionMcpServerList(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return sanitizeEventPayloadDeep(value);
  }
  return value.map((item) => {
    if (!isPlainObject(item)) {
      return sanitizeEventPayloadDeep(item);
    }
    const { headers, headersEncrypted, ...rest } = item;
    const cleaned = sanitizeEventPayloadDeep(rest) as Record<string, unknown>;
    const headerNames = safeHeaderNames(headers) ?? safeHeaderNames(headersEncrypted);
    if (headerNames) {
      cleaned.headerNames = headerNames;
    }
    return cleaned;
  });
}

function sanitizeMcpCredentialUpdateList(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return sanitizeEventPayloadDeep(value);
  }
  return value.map((item) => {
    if (!isPlainObject(item)) {
      return sanitizeEventPayloadDeep(item);
    }
    const { headers, headersEncrypted, ...rest } = item;
    const cleaned = sanitizeEventPayloadDeep(rest) as Record<string, unknown>;
    const headerNames = safeHeaderNames(headers) ?? safeHeaderNames(headersEncrypted);
    if (headerNames) {
      cleaned.headerNames = headerNames;
    }
    return cleaned;
  });
}

function safeHeaderNames(value: unknown): string[] | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return Object.keys(value).map(sanitizeEventString).sort();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}
