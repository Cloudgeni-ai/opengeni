/**
 * Shape-based secret detection: a short list of high-precision patterns for
 * secrets that were never in a vault, such as a database URL with its
 * password, a private key block or a token with a well-known prefix
 * (docs/secrets.md, Masking).
 *
 * Only the secret part of a match is reported and replaced: in
 * `postgres://user:pa55word@host:5432/db` that is `pa55word`, so the rest of
 * the URL stays readable. There is deliberately no generic "long random
 * string" rule: identifiers, digests, UUIDs and base64 data are left alone.
 *
 * Pure and isomorphic: no I/O, no clock, no randomness. The agent runtime
 * uses it on tool output (capturing each value into the task vault and
 * writing its reference instead); the history scrub uses the same detectors.
 */
import { mapSecretMaskableStrings } from "./secret-mask-strings";

export type SecretShapeKind =
  | "url-password"
  | "connection-string-password"
  | "azure-account-key"
  | "azure-shared-access-key"
  | "azure-sas-signature"
  | "private-key"
  | "github-token"
  | "anthropic-key"
  | "openai-key"
  | "slack-token"
  | "stripe-key"
  | "npm-token"
  | "gitlab-token"
  | "google-api-key"
  | "opengeni-token"
  | "1password-token"
  | "jwt";

export type SecretShapeKindInfo = {
  /** Plain words for `[masked <label>]`; lower case. */
  label: string;
  /** The vault item type and field a captured value is saved as. */
  itemType: "login" | "api_key" | "note";
  field: "password" | "value" | "note";
};

export const SECRET_SHAPE_KINDS: Readonly<Record<SecretShapeKind, SecretShapeKindInfo>> = {
  "url-password": { label: "url password", itemType: "login", field: "password" },
  "connection-string-password": {
    label: "connection string password",
    itemType: "login",
    field: "password",
  },
  "azure-account-key": { label: "azure account key", itemType: "api_key", field: "value" },
  "azure-shared-access-key": {
    label: "azure shared access key",
    itemType: "api_key",
    field: "value",
  },
  "azure-sas-signature": { label: "azure sas signature", itemType: "api_key", field: "value" },
  "private-key": { label: "private key", itemType: "note", field: "note" },
  "github-token": { label: "github token", itemType: "api_key", field: "value" },
  "anthropic-key": { label: "anthropic key", itemType: "api_key", field: "value" },
  "openai-key": { label: "openai key", itemType: "api_key", field: "value" },
  "slack-token": { label: "slack token", itemType: "api_key", field: "value" },
  "stripe-key": { label: "stripe key", itemType: "api_key", field: "value" },
  "npm-token": { label: "npm token", itemType: "api_key", field: "value" },
  "gitlab-token": { label: "gitlab token", itemType: "api_key", field: "value" },
  "google-api-key": { label: "google api key", itemType: "api_key", field: "value" },
  "opengeni-token": { label: "opengeni token", itemType: "api_key", field: "value" },
  "1password-token": { label: "1password token", itemType: "api_key", field: "value" },
  jwt: { label: "jwt", itemType: "api_key", field: "value" },
};

export type SecretShapeMatch = {
  kind: SecretShapeKind;
  /** Offsets of the secret part in the scanned text. */
  start: number;
  end: number;
  /** The secret part exactly as written. Never log it. */
  value: string;
  /** For URL passwords: the user name written before it, if any. */
  username?: string;
};

/** The fixed marker written where a detected value could not be captured. */
export function secretShapeMaskLabel(kind: SecretShapeKind): string {
  return `[masked ${SECRET_SHAPE_KINDS[kind]?.label ?? "secret"}]`;
}

/** Texts longer than this are scanned only in their first part. */
export const SECRET_SHAPE_SCAN_MAX_CHARS = 4_000_000;

type Detector = {
  kind: SecretShapeKind;
  pattern: RegExp;
  /**
   * The secret part of a match. Every pattern is written so the secret ends
   * the match (trailing context is a lookahead).
   */
  secret: (match: RegExpExecArray) => string | undefined;
  /** Extra checks on the whole text around the match. */
  accept?: (text: string, match: RegExpExecArray, value: string) => boolean;
  /** Token formats must contain a digit (random tokens always do; words don't). */
  needsDigit?: boolean;
};

const QUOTES_AND_SPACE = "\\s\"'`<>";

// Placeholders and examples that look like a secret's position but are not one.
const PLACEHOLDER =
  /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(.*\)|<[^>]*>|\{[^}]*\}|\[[^\]]*\]|%[sv]|\*+|x+|\.{3}|\u2026|password|passwd|pass|pwd|secret|changeme|redacted|hidden|masked|example|null|none|undefined)$/i;

function isPlaceholder(value: string): boolean {
  return (
    PLACEHOLDER.test(value) ||
    PLACEHOLDER_PHRASE.test(value) ||
    value.includes("\u007B\u007Bsecret") ||
    value.includes("$(")
  );
}

// Documentation-style stand-ins such as `your_account_key_here` or `my-password`.
const PLACEHOLDER_PHRASE =
  /^(?:your|my|the|some|example|sample|dummy)?[_-]?(?:storage[_-]?)?(?:account[_-]?key|access[_-]?key|api[_-]?key|key|password|passwd|secret|token|signature|sig)(?:[_-]?(?:here|goes[_-]?here|value))?$|[_-](?:goes[_-])?here$/i;

function lastGroup(match: RegExpExecArray): string | undefined {
  for (let index = match.length - 1; index >= 1; index -= 1) {
    if (match[index] !== undefined) return match[index];
  }
  return undefined;
}

/** Characters searched on each side of a `password=` for its connection string. */
const CONNECTION_STRING_WINDOW = 400;

/** A `key=value` pair (no spaces around `=`) that only a connection string has. */
const CONNECTION_KEY =
  /(?:^|[\s;"'?&])(?:host|hostaddr|server|address|addr|data source|dbname|database|initial catalog|user|uid|user id|username|port|sslmode)=[^\s;=]/i;

/**
 * A `password=` is part of a connection string when it is a URL query
 * parameter, or the same line (within a bounded window) has a host, database,
 * user, port or SSL key written the same way: `Server=db;User Id=app;Password=…`
 * or `host=db user=app password=…`. Source code such as
 * `const password = config.password;` is not.
 */
function inConnectionString(text: string, match: RegExpExecArray, value: string): boolean {
  if (value.length < 4 || value.startsWith("=")) return false;
  const lead = match[0][0];
  if (lead === "?" || lead === "&") return true;
  const from = Math.max(0, match.index - CONNECTION_STRING_WINDOW);
  const to = Math.min(text.length, match.index + match[0].length + CONNECTION_STRING_WINDOW);
  let window = text.slice(from, to);
  const offset = match.index - from;
  const lineStart = window.lastIndexOf("\n", offset) + 1;
  const lineEnd = window.indexOf("\n", offset);
  window = window.slice(lineStart, lineEnd < 0 ? window.length : lineEnd);
  return CONNECTION_KEY.test(window);
}

function tokenDetector(kind: SecretShapeKind, source: string, flags = "g"): Detector {
  return {
    kind,
    pattern: new RegExp(`(?<![A-Za-z0-9_.-])(${source})(?![A-Za-z0-9_-])`, flags),
    secret: (match) => match[1],
    needsDigit: true,
  };
}

// Order matters where two detectors report the same span: the first wins.
const DETECTORS: readonly Detector[] = [
  {
    kind: "url-password",
    // scheme://user:password@host — any scheme; the user may be empty
    // (redis://:password@host). The password may contain an unencoded `@`;
    // the last `@` before the host ends it.
    pattern: new RegExp(
      // `:\/\/` too: a URL inside JSON-escaped text.
      `\\b[A-Za-z][A-Za-z0-9+.-]{1,30}:(?:\\\\?\\/){2}([^${QUOTES_AND_SPACE}:@\\/?#\\\\]{0,256}):([^${QUOTES_AND_SPACE}\\/?#\\\\]{1,512})(?=@[A-Za-z0-9\\[_])`,
      "g",
    ),
    secret: (match) => match[2],
    accept: (_text, _match, value) => !/^\d{1,5}$/.test(value),
  },
  {
    kind: "connection-string-password",
    // Written tight (`Password=…`), plain, braced or quoted.
    pattern:
      /(?:^|[;?&\s"'({])(?:password|pwd)=(?:\{([^}\r\n]{1,256})(?=\})|'([^'\r\n]{1,256})(?=')|"([^"\r\n]{1,256})(?=")|([^;&\s"'<>{}()=][^;&\s"'<>]{0,255}))/gim,
    secret: lastGroup,
    accept: inConnectionString,
  },
  {
    kind: "azure-account-key",
    // AccountKey=, also StorageAccountKey= and similar.
    pattern: /(?<![A-Za-z0-9])(?:[A-Za-z]{0,30})AccountKey\s*=\s*([^;\s"'<>]{16,})/gi,
    secret: (match) => match[1],
  },
  {
    kind: "azure-shared-access-key",
    pattern: /\bSharedAccessKey\s*=\s*([^;\s"'<>]{16,})/gi,
    secret: (match) => match[1],
  },
  {
    kind: "azure-sas-signature",
    pattern: /[?&]sig=([^&\s"'<>#]{16,})/gi,
    secret: (match) => match[1],
  },
  tokenDetector("github-token", "gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255}"),
  tokenDetector("anthropic-key", "sk-ant-[A-Za-z0-9_-]{20,255}"),
  // Project, service account and admin keys are long; legacy keys have no hyphen.
  tokenDetector(
    "openai-key",
    "sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,255}|sk-[A-Za-z0-9]{32,255}",
  ),
  tokenDetector("slack-token", "xox[abposre]-[A-Za-z0-9-]{10,255}"),
  tokenDetector("stripe-key", "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}"),
  tokenDetector("npm-token", "npm_[A-Za-z0-9]{30,255}"),
  tokenDetector("gitlab-token", "glpat-[A-Za-z0-9_-]{20,255}"),
  tokenDetector("google-api-key", "AIza[A-Za-z0-9_-]{35}"),
  // API and personal keys are long random runs; the others are signed
  // `<payload>.<signature>` envelopes (with an optional version digit).
  tokenDetector(
    "opengeni-token",
    "og[kp]_[A-Za-z0-9]{32,256}|og[ders]\\d?_[A-Za-z0-9_-]{16,2048}\\.[A-Za-z0-9_-]{16,512}",
  ),
  tokenDetector("1password-token", "ops_[A-Za-z0-9_.-]{40,4096}"),
  {
    kind: "jwt",
    pattern:
      /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/g,
    secret: (match) => match[1],
  },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ ){0,3})PRIVATE KEY( BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END ((?:[A-Z0-9]+ ){0,3})PRIVATE KEY( BLOCK)?-----/g;
const PRIVATE_KEY_MAX_CHARS = 32_768;
/** What a key body may contain when its END line is missing (clipped output). */
const PRIVATE_KEY_BODY = /^[A-Za-z0-9+/=\s\\:,-]*/;
/** Base64 characters a real key body has at least (placeholders such as `...` have none). */
const PRIVATE_KEY_MIN_BODY_CHARS = 64;

function keyBodyChars(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to && count < PRIVATE_KEY_MIN_BODY_CHARS; index += 1) {
    if (/[A-Za-z0-9+/]/.test(text[index]!)) count += 1;
  }
  return count;
}

/** Length of the line break (real or JSON-escaped) that ends just before `at`, or 0. */
function lineBreakBefore(text: string, at: number): number {
  if (text[at - 1] === "\n") return text[at - 2] === "\r" ? 2 : 1;
  if (text[at - 1] === "n" && text[at - 2] === "\\") {
    return text[at - 3] === "r" && text[at - 4] === "\\" ? 4 : 2;
  }
  return 0;
}

/**
 * Where the base64 lines that end just before `at` start (whole lines only,
 * the first one may be cut off), never before `floor`.
 */
function keyBodyStart(text: string, at: number, floor: number): number {
  let start = at;
  let position = at;
  for (;;) {
    const lineBreak = lineBreakBefore(text, position);
    if (lineBreak === 0) break;
    const lineEnd = position - lineBreak;
    let lineStart = lineEnd;
    while (
      lineStart > floor &&
      /[A-Za-z0-9+/=]/.test(text[lineStart - 1]!) &&
      lineBreakBefore(text, lineStart) === 0
    ) {
      lineStart -= 1;
    }
    if (lineStart === lineEnd) break;
    start = lineStart;
    position = lineStart;
    if (lineStart <= floor) break;
  }
  return start;
}

function privateKeyMatches(text: string, out: SecretShapeMatch[]): void {
  const found: Array<[number, number]> = [];
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (let begin = PRIVATE_KEY_BEGIN.exec(text); begin; begin = PRIVATE_KEY_BEGIN.exec(text)) {
    const start = begin.index;
    const endMarker = `-----END ${begin[1] ?? ""}PRIVATE KEY${begin[2] ?? ""}-----`;
    const bodyStart = start + begin[0].length;
    const endAt = text.indexOf(endMarker, bodyStart);
    let end: number;
    if (endAt >= 0 && endAt - start <= PRIVATE_KEY_MAX_CHARS) {
      end = endAt + endMarker.length;
    } else {
      const body = PRIVATE_KEY_BODY.exec(text.slice(bodyStart, start + PRIVATE_KEY_MAX_CHARS));
      end = bodyStart + (body?.[0].length ?? 0);
      // Trailing blank space is not part of a clipped key.
      while (end > bodyStart && /\s/.test(text[end - 1]!)) end -= 1;
    }
    if (keyBodyChars(text, bodyStart, end) < PRIVATE_KEY_MIN_BODY_CHARS) continue;
    out.push({ kind: "private-key", start, end, value: text.slice(start, end) });
    found.push([start, end]);
    PRIVATE_KEY_BEGIN.lastIndex = end;
  }
  // The rest of a key whose BEGIN line is not in this text, for example a
  // later chunk of streamed command output: the body back to where it starts.
  PRIVATE_KEY_END.lastIndex = 0;
  for (let endLine = PRIVATE_KEY_END.exec(text); endLine; endLine = PRIVATE_KEY_END.exec(text)) {
    const at = endLine.index;
    if (found.some(([from, to]) => at >= from && at < to)) continue;
    const start = keyBodyStart(text, at, Math.max(0, at - PRIVATE_KEY_MAX_CHARS));
    if (keyBodyChars(text, start, at) < PRIVATE_KEY_MIN_BODY_CHARS) continue;
    const end = at + endLine[0].length;
    out.push({ kind: "private-key", start, end, value: text.slice(start, end) });
  }
}

/** Labels and references already in a text are never reported. */
const PROTECTED =
  /\{\{secret(?:file)?:[^{}\r\n]{1,300}\}\}|\[opengeni credential: [A-Za-z0-9 ._-]{1,60}\]|\[masked [a-z0-9 _-]{1,40}\]/g;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Every secret-shaped part of `text`, in order and without overlaps (at one
 * position the earliest start wins, then the longest). Never throws.
 */
export function detectSecretShapes(text: string): SecretShapeMatch[] {
  if (typeof text !== "string" || text.length < 8) return [];
  try {
    const scanned =
      text.length > SECRET_SHAPE_SCAN_MAX_CHARS ? text.slice(0, SECRET_SHAPE_SCAN_MAX_CHARS) : text;
    const found: SecretShapeMatch[] = [];
    privateKeyMatches(scanned, found);
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0;
      for (const match of scanned.matchAll(detector.pattern)) {
        const value = detector.secret(match);
        if (!value) continue;
        const end = match.index + match[0].length;
        const start = end - value.length;
        if (scanned.slice(start, end) !== value) continue;
        if (isPlaceholder(value)) continue;
        if (detector.needsDigit && !/\d/.test(value)) continue;
        if (detector.accept && !detector.accept(scanned, match, value)) continue;
        const entry: SecretShapeMatch = { kind: detector.kind, start, end, value };
        if (detector.kind === "url-password" && match[1]) entry.username = safeDecode(match[1]);
        found.push(entry);
      }
    }
    if (found.length === 0) return [];
    const protectedRanges: Array<[number, number]> = [];
    PROTECTED.lastIndex = 0;
    for (const match of scanned.matchAll(PROTECTED)) {
      protectedRanges.push([match.index, match.index + match[0].length]);
    }
    const ordered = found
      .map((entry, order) => ({ entry, order }))
      .sort(
        (left, right) =>
          left.entry.start - right.entry.start ||
          right.entry.end - left.entry.end ||
          left.order - right.order,
      )
      .map(({ entry }) => entry);
    const kept: SecretShapeMatch[] = [];
    let reached = 0;
    for (const entry of ordered) {
      if (entry.start < reached) continue;
      if (protectedRanges.some(([from, to]) => entry.start < to && from < entry.end)) continue;
      kept.push(entry);
      reached = entry.end;
    }
    return kept;
  } catch {
    return [];
  }
}

/**
 * What replaces one detected part: a label, `undefined` (or an empty string)
 * for the `[masked <kind>]` marker, or `null` to keep it as written. `text` is
 * the string the match's offsets refer to.
 */
export type SecretShapeReplacement = (
  match: SecretShapeMatch,
  text: string,
) => string | null | undefined;

/**
 * `text` with each detected secret part replaced by `replacement(match)`, by
 * `[masked <kind>]` when it returns undefined or an empty string, or kept as
 * written when it returns `null`. Idempotent: markers and references are
 * never detected again. Never throws.
 */
export function maskSecretShapesInText(text: string, replacement?: SecretShapeReplacement): string {
  const matches = detectSecretShapes(text);
  if (matches.length === 0) return text;
  let out = "";
  let copied = 0;
  for (const match of matches) {
    let label: string | null | undefined;
    try {
      label = replacement?.(match, text);
    } catch {
      label = undefined;
    }
    const replaced =
      label === null
        ? text.slice(match.start, match.end)
        : label || secretShapeMaskLabel(match.kind);
    out += text.slice(copied, match.start) + replaced;
    copied = match.end;
  }
  return out + text.slice(copied);
}

/** Deep copy of `value` with secret shapes masked in every string (see `maskSecretShapesInText`). */
export function maskSecretShapes<T>(
  value: T,
  replacement?: SecretShapeReplacement,
  skipKey?: (key: string) => boolean,
): T {
  return mapSecretMaskableStrings(
    value,
    (text) => maskSecretShapesInText(text, replacement),
    skipKey,
  );
}

/**
 * The distinct secret values (first occurrence of each) in every string of
 * `value`, at most `limit`. Never throws.
 */
export function collectSecretShapes(
  value: unknown,
  limit = 64,
  options: {
    skipKey?: (key: string) => boolean;
    /** Return false to leave a match out (it is neither collected nor masked by the caller). */
    keep?: (match: SecretShapeMatch, text: string) => boolean;
  } = {},
): SecretShapeMatch[] {
  const seen = new Map<string, SecretShapeMatch>();
  try {
    mapSecretMaskableStrings(
      value,
      (text) => {
        if (seen.size >= limit) return text;
        for (const match of detectSecretShapes(text)) {
          if (seen.size >= limit) break;
          if (seen.has(match.value)) continue;
          if (options.keep && !options.keep(match, text)) continue;
          seen.set(match.value, match);
        }
        return text;
      },
      options.skipKey,
    );
  } catch {
    // Whatever was collected is still returned.
  }
  return [...seen.values()];
}
