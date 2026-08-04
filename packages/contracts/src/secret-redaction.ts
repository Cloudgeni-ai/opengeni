const MIN_REDACTABLE_VALUE_LENGTH = 6;
const REDACTED = "[redacted]";
const MAX_REDACTION_DEPTH = 64;
const CYCLE_MARKER = "[OpenGeni omitted cyclic value during secret redaction]";
const DEPTH_MARKER = "[OpenGeni omitted value beyond secret-redaction depth]";

export type SecretForRedaction = {
  name: string;
  value: string;
};

type RedactionProfile = "strict" | "private-agent";

type PreparedSecret = {
  marker: string;
  value: string;
};

const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "privatekey",
  "credential",
  "credentials",
  "credentialencrypted",
  "encryptedcredential",
  "headersencrypted",
  "encryptedpkceverifier",
  "codeverifier",
  "signingkey",
]);

const CREDENTIAL_HEADER_PATTERNS = [
  /^(?:proxy-)?authorization$/i,
  /^(?:set-)?cookie$/i,
  /^(?:x[-_])?api[-_]?key$/i,
  /^(?:x[-_])?(?:access|refresh|id)[-_]?token$/i,
  /^(?:x[-_])?(?:auth|session)[-_]?(?:token|key|secret)$/i,
  /^(?:x[-_])?(?:client|app|consumer)[-_]?secret$/i,
  /^x-opengeni-access-key$/i,
] as const;

const SECRET_KEY_SOURCE =
  "(?:proxy[-_ ]?authorization|authorization|set[-_ ]?cookie|cookie|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|secret|password|passwd|private[-_ ]?key|credential(?:s|[-_ ]?encrypted)?|encrypted[-_ ]?credential|encrypted[-_ ]?pkce[-_ ]?verifier|code[-_ ]?verifier|signing[-_ ]?key)";
const UNQUOTED_SECRET_KEY_SOURCE =
  "(?:access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|secret|password|passwd|private[-_ ]?key|credential(?:s|[-_ ]?encrypted)?|encrypted[-_ ]?credential|encrypted[-_ ]?pkce[-_ ]?verifier|code[-_ ]?verifier|signing[-_ ]?key)";

const AUTHORIZATION_HEADER_PATTERN =
  /(\b(?:proxy-)?authorization[^\S\r\n]*:[^\S\r\n]*)([^\r\n'"`]+)/gi;
const COOKIE_HEADER_PATTERN = /(\b(?:set-cookie|cookie)\s*:\s*)([^\r\n'"`]+)/gi;
const API_KEY_HEADER_PATTERN = /(\b(?:x[-_])?api[-_]?key[^\S\r\n]*:[^\S\r\n]*)([^\r\n'"`]+)/gi;
const CURL_USER_PATTERN = /((?:^|\s)(?:-u|--user)(?:=|\s+))(?:("[^"]*")|('[^']*')|([^\s]+))/gm;
const URL_USERINFO_PATTERN = /(https?:\/\/)[^\s/@]+@/gi;
const SIGNED_QUERY_PATTERN = new RegExp(
  `([?&](?:sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|access_token|refresh_token|token)=)([^&#\\s'"<>]+)`,
  "gi",
);
const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:["']${SECRET_KEY_SOURCE}["']|\\b${SECRET_KEY_SOURCE})\\s*[:=]\\s*)(["'])(.*?)\\2`,
  "gi",
);
const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:\\b${UNQUOTED_SECRET_KEY_SOURCE})\\s*[:=]\\s*)([^\\s,;}&]+)`,
  "gi",
);
const SECRET_ENV_ASSIGNMENT_PATTERN =
  /((?:^|[\s;])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION|COOKIE)[A-Za-z0-9_]*\s*=\s*)(?:("[^"]*")|('[^']*')|([^\s;]+))/gim;

const PROVIDER_TOKEN_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bogd_[A-Za-z0-9._~-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
] as const;

/**
 * Returns true only for fields whose value is itself credential material.
 * Container fields such as `headers` and URL fields are intentionally not
 * included: their nested/value sanitizers retain useful names, hosts, paths,
 * and non-sensitive query parameters.
 */
export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(normalizeFieldName(name));
}

/**
 * Return true only for header names whose values are credential material.
 * Ordinary protocol metadata (`content-type`, `accept`, `user-agent`, and
 * pagination/signature headers outside this allowlist) must remain intact.
 */
export function isCredentialHeaderName(name: string): boolean {
  return CREDENTIAL_HEADER_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Redact only exact known-secret provenance from a structured object key.
 * Generic field/header heuristics intentionally do not run here: a key is
 * metadata unless the caller has proved that its bytes are secret material.
 */
export function redactSensitiveKey(
  key: string,
  knownSecrets: readonly SecretForRedaction[] = [],
): string {
  return replacePreparedSecrets(key, prepareSecrets(knownSecrets));
}

/**
 * Redact known secret provenance and common credential-bearing text shapes.
 * This is deliberately a conservative safety boundary, not a promise of
 * general-purpose DLP. It never includes a matched value in a marker or error.
 */
export function redactSensitiveText(
  text: string,
  knownSecrets: readonly SecretForRedaction[] = [],
): string {
  let redacted = replacePreparedSecrets(text, prepareSecrets(knownSecrets));

  redacted = redacted.replace(
    AUTHORIZATION_HEADER_PATTERN,
    (match, prefix: string, rawValue: string) => {
      const value = rawValue.trimEnd();
      const trailingWhitespace = rawValue.slice(value.length);
      const schemeMatch = value.match(/^([A-Za-z][A-Za-z0-9_-]*)(\s+)(.+)$/);
      if (schemeMatch) {
        const scheme = schemeMatch[1];
        const whitespace = schemeMatch[2];
        const credential = schemeMatch[3];
        if (scheme && whitespace && credential) {
          return isRedactionMarker(credential.trim())
            ? match
            : `${prefix}${scheme}${whitespace}${REDACTED}${trailingWhitespace}`;
        }
      }
      return isRedactionMarker(value) ? match : `${prefix}${REDACTED}${trailingWhitespace}`;
    },
  );
  redacted = redacted.replace(COOKIE_HEADER_PATTERN, `$1${REDACTED}`);
  redacted = redacted.replace(API_KEY_HEADER_PATTERN, `$1${REDACTED}`);
  redacted = redacted.replace(CURL_USER_PATTERN, (_match, prefix: string) => {
    return `${prefix}${REDACTED}`;
  });
  redacted = redacted.replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`);
  redacted = redacted.replace(SIGNED_QUERY_PATTERN, `$1${REDACTED}`);
  redacted = redacted.replace(
    QUOTED_SECRET_ASSIGNMENT_PATTERN,
    (match, prefix: string, quote: string, value: string) =>
      isRedactionMarker(value) ? match : `${prefix}${quote}${REDACTED}${quote}`,
  );
  redacted = redacted.replace(
    UNQUOTED_SECRET_ASSIGNMENT_PATTERN,
    (match, prefix: string, value: string) =>
      isRedactionMarker(value) ? match : `${prefix}${REDACTED}`,
  );
  redacted = redacted.replace(
    SECRET_ENV_ASSIGNMENT_PATTERN,
    (
      match,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      return isRedactionMarker(stripMatchingQuotes(value)) ? match : `${prefix}${REDACTED}`;
    },
  );
  for (const pattern of PROVIDER_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

/** Deeply redact plain structured data while retaining its diagnostic shape. */
export function redactSensitiveData<T>(
  value: T,
  knownSecrets: readonly SecretForRedaction[] = [],
): T {
  return redactSensitiveDataDeep(value, knownSecrets, new WeakSet<object>(), 0, "strict");
}

/** Build the strict redactor for public, audit, and diagnostic boundaries. */
export function createSecretRedactor(
  knownSecrets: readonly SecretForRedaction[],
): (value: unknown) => unknown {
  return createDataRedactor(knownSecrets, "strict");
}

/**
 * Build the redactor for private model input, conversation history, tool
 * receipts, and resumable run state. Intentional tool-returned capabilities
 * remain usable here; exact host-known secrets are still removed by provenance.
 */
export function createPrivateAgentRedactor(
  knownSecrets: readonly SecretForRedaction[],
): (value: unknown) => unknown {
  return createDataRedactor(knownSecrets, "private-agent");
}

function createDataRedactor(
  knownSecrets: readonly SecretForRedaction[],
  profile: RedactionProfile,
): (value: unknown) => unknown {
  const prepared = prepareSecrets(knownSecrets).map(({ marker, value }) => ({
    name: marker.slice("[redacted:".length, -1),
    value,
  }));
  return (value: unknown) =>
    redactSensitiveDataDeep(value, prepared, new WeakSet<object>(), 0, profile);
}

/**
 * Redact a serialized JSON checkpoint without requiring it to be valid JSON.
 * Valid JSON retains structure; malformed/opaque text still receives text
 * classification and exact-known-value replacement.
 */
export function redactSerializedJson(
  serialized: string,
  knownSecrets: readonly SecretForRedaction[] = [],
): string {
  try {
    return JSON.stringify(redactSensitiveData(JSON.parse(serialized), knownSecrets));
  } catch {
    return redactSensitiveText(serialized, knownSecrets);
  }
}

export function identityRedactor<T>(value: T): T {
  return value;
}

function redactSensitiveDataDeep<T>(
  value: T,
  knownSecrets: readonly SecretForRedaction[],
  seen: WeakSet<object>,
  depth: number,
  profile: RedactionProfile,
): T {
  if (typeof value === "string") {
    return (
      profile === "strict"
        ? redactSensitiveText(value, knownSecrets)
        : replacePreparedSecrets(value, prepareSecrets(knownSecrets))
    ) as T;
  }
  if (!value || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return DEPTH_MARKER as T;
  }
  if (seen.has(value)) {
    return CYCLE_MARKER as T;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        redactSensitiveDataDeep(item, knownSecrets, seen, depth + 1, profile),
      ) as T;
    }
    if (!isPlainObject(value)) {
      return value;
    }
    const usedKeys = new Set<string>();
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const safeKey = nextUniqueKey(redactSensitiveKey(key, knownSecrets), usedKeys);
        if (profile === "strict" && isSensitiveFieldName(key)) {
          return [safeKey, REDACTED] as const;
        }
        if (normalizeFieldName(key) === "headers") {
          return [safeKey, redactHeaderMap(child, knownSecrets, seen, depth + 1, profile)] as const;
        }
        return [
          safeKey,
          redactSensitiveDataDeep(child, knownSecrets, seen, depth + 1, profile),
        ] as const;
      }),
    ) as T;
  } finally {
    seen.delete(value);
  }
}

function redactHeaderMap(
  value: unknown,
  knownSecrets: readonly SecretForRedaction[],
  seen: WeakSet<object>,
  depth: number,
  profile: RedactionProfile,
): unknown {
  if (!isPlainObject(value)) {
    return redactSensitiveDataDeep(value, knownSecrets, seen, depth, profile);
  }
  if (depth >= MAX_REDACTION_DEPTH) return DEPTH_MARKER;
  if (seen.has(value)) return CYCLE_MARKER;
  seen.add(value);
  try {
    const usedKeys = new Set<string>();
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const safeKey = nextUniqueKey(redactSensitiveKey(key, knownSecrets), usedKeys);
        return [
          safeKey,
          profile === "strict" && isCredentialHeaderName(key)
            ? REDACTED
            : redactSensitiveDataDeep(child, knownSecrets, seen, depth + 1, profile),
        ];
      }),
    );
  } finally {
    seen.delete(value);
  }
}

function prepareSecrets(knownSecrets: readonly SecretForRedaction[]): PreparedSecret[] {
  const unique = new Map<string, string>();
  for (const secret of knownSecrets) {
    if (secret.value.length < MIN_REDACTABLE_VALUE_LENGTH || unique.has(secret.value)) {
      continue;
    }
    unique.set(secret.value, `[redacted:${safeSecretName(secret.name)}]`);
  }
  return [...unique]
    .map(([value, marker]) => ({ marker, value }))
    .sort((a, b) => b.value.length - a.value.length || a.marker.localeCompare(b.marker));
}

function replacePreparedSecrets(text: string, prepared: readonly PreparedSecret[]): string {
  let redacted = text;
  for (const secret of prepared) {
    if (redacted.includes(secret.value)) {
      redacted = redacted.split(secret.value).join(secret.marker);
    }
  }
  return redacted;
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

function safeSecretName(name: string): string {
  const safe = name
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe.slice(0, 64) || "KNOWN_SECRET";
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRedactionMarker(value: string): boolean {
  return /^\[redacted(?::[A-Z0-9_]{1,64})?\]$/.test(value);
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
