import {
  boundSessionEventPayload,
  isCredentialHeaderName,
  isSensitiveFieldName,
  redactSensitiveKey,
  redactSensitiveText,
  type SecretForRedaction,
} from "@opengeni/contracts";

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
export type SanitizeEventPayloadOptions = {
  /**
   * Separately trusted, server-created retained-output evidence. Never populate
   * this from a producer-controlled payload field.
   */
  fullEvidence?: unknown;
  /** Exact runtime credential provenance to remove from keys and values. */
  knownSecrets?: readonly SecretForRedaction[];
};

export function sanitizeEventPayload<T>(payload: T, options: SanitizeEventPayloadOptions = {}): T {
  // Bound first. The preview walker caps depth/container fan-out and replaces
  // inline media before this sanitizer allocates a deep clone. Reversing this
  // order lets a cyclic, deeply nested, or multi-megabyte tool result exhaust
  // the stack/heap before the durable 64 KiB event boundary can protect it.
  const bounded = boundSessionEventPayload(payload, {
    fullEvidence: options.fullEvidence,
  });
  return sanitizeEventPayloadDeep(
    bounded === payload ? removeProducerTruncationMetadata(bounded) : bounded,
    options.knownSecrets ?? [],
  );
}

/**
 * `truncation` is reserved durable-boundary metadata. An ordinary payload that
 * already fits the envelope otherwise returns by reference, so remove a
 * producer-supplied value before persistence rather than allowing it to forge
 * byte accounting or an available retained-artifact receipt. A payload changed
 * by `boundSessionEventPayload` already carries freshly computed metadata and
 * never reaches this helper.
 */
function removeProducerTruncationMetadata<T>(payload: T): T {
  if (!isPlainObject(payload)) return payload;
  const descriptor = Object.getOwnPropertyDescriptor(payload, "truncation");
  if (!descriptor?.enumerable) return payload;
  const cleaned = { ...payload };
  delete cleaned.truncation;
  return cleaned as T;
}

function sanitizeEventPayloadDeep<T>(
  payload: T,
  knownSecrets: readonly SecretForRedaction[] = [],
): T {
  if (typeof payload === "string") {
    return sanitizeEventString(redactSensitiveText(payload, knownSecrets)) as unknown as T;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeEventPayloadDeep(item, knownSecrets)) as unknown as T;
  }
  if (payload instanceof Date) {
    return safeDateIso(payload) as unknown as T;
  }
  if (payload && typeof payload === "object") {
    const usedKeys = new Set<string>();
    const entries = Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
      const safeKey = nextUniqueKey(
        sanitizeEventString(redactSensitiveKey(key, knownSecrets)),
        usedKeys,
      );
      return [safeKey, sanitizeSensitiveEventField(key, value, knownSecrets)] as const;
    });
    return Object.fromEntries(entries) as unknown as T;
  }
  return payload;
}

type ModelPayloadSanitizationProfile = "strict" | "private-agent";

const PRIVATE_AGENT_DURABLE_PAYLOAD = Symbol("OpenGeni private agent durable payload");

/**
 * Opaque trusted context for the private model-history/run-state stores. A
 * producer-controlled JSON field cannot opt into this policy; only a DB writer
 * that explicitly constructs this envelope can select it.
 */
export type PrivateAgentDurablePayload<T> = Readonly<{
  payload: T;
  [PRIVATE_AGENT_DURABLE_PAYLOAD]: true;
}>;

export function privateAgentDurablePayload<T>(payload: T): PrivateAgentDurablePayload<T> {
  return Object.freeze({ payload, [PRIVATE_AGENT_DURABLE_PAYLOAD]: true });
}

/**
 * Make general or untrusted model-shaped data safe for Postgres and strictly
 * secret-redacted. This remains the default for unrelated payloads and for any
 * caller that has not selected the opaque private durable-state context.
 */
export function sanitizeModelPayload<T>(
  payload: T,
  knownSecrets: readonly SecretForRedaction[] = [],
): T {
  return sanitizeModelPayloadDeep(payload, new WeakSet<object>(), 0, knownSecrets, "strict");
}

/**
 * Apply database-safety normalization plus exact known-secret replacement to a
 * trusted private-agent envelope. Credential-shaped temporary capabilities are
 * intentionally preserved for durable replay/resume.
 */
export function sanitizePrivateAgentDurablePayload<T>(
  envelope: PrivateAgentDurablePayload<T>,
  knownSecrets: readonly SecretForRedaction[] = [],
): T {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope[PRIVATE_AGENT_DURABLE_PAYLOAD] !== true
  ) {
    throw new TypeError("Private agent payload requires the trusted durable-state envelope");
  }
  return sanitizeModelPayloadDeep(
    envelope.payload,
    new WeakSet<object>(),
    0,
    knownSecrets,
    "private-agent",
  );
}

const MODEL_PAYLOAD_SANITIZE_MAX_DEPTH = 64;
const MODEL_PAYLOAD_CYCLE_MARKER = "[OpenGeni omitted cyclic model payload]";
const MODEL_PAYLOAD_DEPTH_MARKER = "[OpenGeni omitted model payload beyond database-safety depth]";

function sanitizeModelPayloadDeep<T>(
  payload: T,
  seen: WeakSet<object>,
  depth: number,
  knownSecrets: readonly SecretForRedaction[] = [],
  profile: ModelPayloadSanitizationProfile,
): T {
  if (typeof payload === "string") {
    const redacted =
      profile === "strict"
        ? redactSensitiveText(payload, knownSecrets)
        : redactSensitiveKey(payload, knownSecrets);
    return sanitizeEventString(redacted) as unknown as T;
  }
  if (!payload || typeof payload !== "object") return payload;
  if (payload instanceof Date) {
    return safeDateIso(payload) as unknown as T;
  }
  if (depth >= MODEL_PAYLOAD_SANITIZE_MAX_DEPTH) {
    return MODEL_PAYLOAD_DEPTH_MARKER as unknown as T;
  }
  if (seen.has(payload)) return MODEL_PAYLOAD_CYCLE_MARKER as unknown as T;
  seen.add(payload);
  try {
    if (Array.isArray(payload)) {
      return payload.map((item) =>
        sanitizeModelPayloadDeep(item, seen, depth + 1, knownSecrets, profile),
      ) as unknown as T;
    }
    const usedKeys = new Set<string>();
    return Object.fromEntries(
      Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
        const safeKey = nextUniqueKey(
          sanitizeEventString(redactSensitiveKey(key, knownSecrets)),
          usedKeys,
        );
        if (profile === "strict" && isSensitiveFieldName(key)) {
          return [safeKey, REDACTED] as const;
        }
        if (profile === "strict" && normalizeFieldName(key) === "headers") {
          return [safeKey, sanitizeModelHeaders(value, seen, depth + 1, knownSecrets)] as const;
        }
        return [
          safeKey,
          sanitizeModelPayloadDeep(value, seen, depth + 1, knownSecrets, profile),
        ] as const;
      }),
    ) as unknown as T;
  } finally {
    seen.delete(payload);
  }
}

function safeDateIso(value: Date): string | null {
  try {
    const epoch = Date.prototype.getTime.call(value);
    return Number.isFinite(epoch) ? Date.prototype.toISOString.call(value) : null;
  } catch {
    return null;
  }
}

function sanitizeSensitiveEventField(
  key: string,
  value: unknown,
  knownSecrets: readonly SecretForRedaction[],
): unknown {
  if (key === "mcpServers") {
    return sanitizeSessionMcpServerList(value, knownSecrets);
  }
  if (key === "mcpCredentialUpdates") {
    return sanitizeMcpCredentialUpdateList(value, knownSecrets);
  }
  if (normalizeFieldName(key) === "headers") {
    return sanitizeEventHeaders(value, knownSecrets);
  }
  if (isSensitiveFieldName(key)) {
    return REDACTED;
  }
  return sanitizeEventPayloadDeep(value, knownSecrets);
}

function sanitizeEventHeaders(
  value: unknown,
  knownSecrets: readonly SecretForRedaction[],
): unknown {
  if (!isPlainObject(value)) {
    return sanitizeEventPayloadDeep(value, knownSecrets);
  }
  const usedKeys = new Set<string>();
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const safeKey = nextUniqueKey(
        sanitizeEventString(redactSensitiveKey(key, knownSecrets)),
        usedKeys,
      );
      return [
        safeKey,
        isCredentialHeaderName(key) ? REDACTED : sanitizeEventPayloadDeep(child, knownSecrets),
      ];
    }),
  );
}

function sanitizeModelHeaders(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  knownSecrets: readonly SecretForRedaction[],
): unknown {
  if (!isPlainObject(value)) {
    return sanitizeModelPayloadDeep(value, seen, depth, knownSecrets, "strict");
  }
  if (depth >= MODEL_PAYLOAD_SANITIZE_MAX_DEPTH) {
    return MODEL_PAYLOAD_DEPTH_MARKER;
  }
  if (seen.has(value)) return MODEL_PAYLOAD_CYCLE_MARKER;
  seen.add(value);
  try {
    const usedKeys = new Set<string>();
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const safeKey = nextUniqueKey(
          sanitizeEventString(redactSensitiveKey(key, knownSecrets)),
          usedKeys,
        );
        return [
          safeKey,
          isCredentialHeaderName(key)
            ? REDACTED
            : sanitizeModelPayloadDeep(child, seen, depth + 1, knownSecrets, "strict"),
        ];
      }),
    );
  } finally {
    seen.delete(value);
  }
}

function sanitizeSessionMcpServerList(
  value: unknown,
  knownSecrets: readonly SecretForRedaction[],
): unknown {
  if (!Array.isArray(value)) {
    return sanitizeEventPayloadDeep(value, knownSecrets);
  }
  return value.map((item) => {
    if (!isPlainObject(item)) {
      return sanitizeEventPayloadDeep(item, knownSecrets);
    }
    const { headers, headersEncrypted, ...rest } = item;
    const cleaned = sanitizeEventPayloadDeep(rest, knownSecrets) as Record<string, unknown>;
    const headerNames =
      safeHeaderNames(headers, knownSecrets) ?? safeHeaderNames(headersEncrypted, knownSecrets);
    if (headerNames) {
      cleaned.headerNames = headerNames;
    }
    return cleaned;
  });
}

function sanitizeMcpCredentialUpdateList(
  value: unknown,
  knownSecrets: readonly SecretForRedaction[],
): unknown {
  if (!Array.isArray(value)) {
    return sanitizeEventPayloadDeep(value, knownSecrets);
  }
  return value.map((item) => {
    if (!isPlainObject(item)) {
      return sanitizeEventPayloadDeep(item, knownSecrets);
    }
    const { headers, headersEncrypted, ...rest } = item;
    const cleaned = sanitizeEventPayloadDeep(rest, knownSecrets) as Record<string, unknown>;
    const headerNames =
      safeHeaderNames(headers, knownSecrets) ?? safeHeaderNames(headersEncrypted, knownSecrets);
    if (headerNames) {
      cleaned.headerNames = headerNames;
    }
    return cleaned;
  });
}

function safeHeaderNames(
  value: unknown,
  knownSecrets: readonly SecretForRedaction[],
): string[] | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const usedKeys = new Set<string>();
  return Object.keys(value)
    .map((key) =>
      nextUniqueKey(sanitizeEventString(redactSensitiveKey(key, knownSecrets)), usedKeys),
    )
    .sort();
}

function nextUniqueKey(base: string, usedKeys: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (usedKeys.has(candidate)) {
    candidate = `${base}#${suffix}`;
    suffix += 1;
  }
  usedKeys.add(candidate);
  return candidate;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}
