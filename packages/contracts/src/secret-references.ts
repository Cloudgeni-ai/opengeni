/**
 * The one secret reference grammar (design §10B.2, normative).
 *
 * ```
 * reference = "{{" kind ":" body "}}"        ; no whitespace after "{{" or before "}}"
 * kind      = "secret" | "secretfile"
 * body      = id-form | path-form
 * id-form   = "id:" uuid [ "/" segment ] [ "/otp" ] [ "#previous" ]
 * path-form = segment *2( "/" segment ) [ "/otp" ] [ "#previous" ]
 * segment   = 1*120( any char except "/" "{" "}" "#" "\" and control chars ),
 *             no leading/trailing whitespace
 * escape    = "\" reference                  ; the reference text, literally
 * ```
 *
 * Text that starts with `{{secret:` or `{{secretfile:` and does not parse is
 * an `invalid` token: callers fail it with `invalid_reference` and never pass
 * it through. References are at most 300 characters long.
 *
 * Pure and isomorphic: no I/O, no runtime imports from `./index`.
 */
import { isValidSecretName, VAULT_LIMITS } from "./vaults";

export type SecretReferenceKind = "secret" | "secretfile";
export type SecretReferenceTarget =
  | { form: "id"; itemId: string; field: string | null }
  | { form: "path"; segments: [string] | [string, string] | [string, string, string] };
export interface SecretReference {
  kind: SecretReferenceKind;
  raw: string;
  /** Offsets in the source text; `end` is exclusive. */
  start: number;
  end: number;
  target: SecretReferenceTarget;
  otp: boolean;
  previous: boolean;
}
export type SecretTextToken =
  /** Escapes already unescaped. */
  | { type: "text"; value: string }
  | { type: "reference"; reference: SecretReference }
  | { type: "invalid"; raw: string; start: number; end: number; reason: string };

/** Fast-path needle; also matches `{{secretfile:`. */
export const SECRET_REFERENCE_MARKER = "{{secret";

export class SecretReferenceSyntaxError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? `invalid secret reference: ${reason}`);
    this.name = "SecretReferenceSyntaxError";
    this.reason = reason;
  }
}

const PREFIXES: ReadonlyArray<{ prefix: string; kind: SecretReferenceKind }> = [
  // Longest first: "{{secretfile:" must win over "{{secret".
  { prefix: "{{secretfile:", kind: "secretfile" },
  { prefix: "{{secret:", kind: "secret" },
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIOUS_SUFFIX = "#previous";
const ID_PREFIX = "id:";

export function containsSecretReference(text: string): boolean {
  return text.includes(SECRET_REFERENCE_MARKER);
}

function prefixAt(
  text: string,
  index: number,
): { prefix: string; kind: SecretReferenceKind } | null {
  for (const candidate of PREFIXES) {
    if (text.startsWith(candidate.prefix, index)) return candidate;
  }
  return null;
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Parse the body (between `kind:` and `}}`). Throws SecretReferenceSyntaxError. */
function parseBody(body: string): {
  target: SecretReferenceTarget;
  otp: boolean;
  previous: boolean;
} {
  if (body.length === 0)
    throw new SecretReferenceSyntaxError("empty_body", "secret reference is empty");
  let rest = body;
  let previous = false;
  if (rest.endsWith(PREVIOUS_SUFFIX)) {
    previous = true;
    rest = rest.slice(0, -PREVIOUS_SUFFIX.length);
  }
  if (rest.includes("#")) {
    throw new SecretReferenceSyntaxError(
      "unsupported_version_suffix",
      "only #previous is supported, and it must be last",
    );
  }
  const parts = rest.split("/");
  let otp = false;
  if (parts.length >= 2 && parts[parts.length - 1]!.toLowerCase() === "otp") {
    otp = true;
    parts.pop();
  }
  if (parts[0]!.toLowerCase().startsWith(ID_PREFIX)) {
    const itemId = parts[0]!.slice(ID_PREFIX.length);
    if (!UUID_PATTERN.test(itemId)) {
      throw new SecretReferenceSyntaxError("invalid_id", "id: must be followed by an item UUID");
    }
    if (parts.length > 2) {
      throw new SecretReferenceSyntaxError("too_many_segments", "id form takes at most one field");
    }
    const field = parts[1] ?? null;
    if (field !== null) assertSegment(field);
    return { target: { form: "id", itemId: itemId.toLowerCase(), field }, otp, previous };
  }
  if (parts.length > 3) {
    throw new SecretReferenceSyntaxError(
      "too_many_segments",
      "a reference has at most Vault/Item/field",
    );
  }
  for (const segment of parts) assertSegment(segment);
  return {
    target: {
      form: "path",
      segments: parts as [string] | [string, string] | [string, string, string],
    },
    otp,
    previous,
  };
}

function assertSegment(segment: string): void {
  if (segment.length === 0) {
    throw new SecretReferenceSyntaxError("empty_segment", "a reference has an empty name");
  }
  if (!isValidSecretName(segment)) {
    throw new SecretReferenceSyntaxError(
      "invalid_segment",
      `"${segment.slice(0, 40)}" is not a valid vault, item or field name`,
    );
  }
}

/**
 * Scan one candidate starting at `index` (where a prefix matched). Returns the
 * candidate's end (exclusive) and either the parsed reference or a reason.
 */
function scanCandidate(
  text: string,
  index: number,
  prefix: { prefix: string; kind: SecretReferenceKind },
):
  | { ok: true; end: number; reference: SecretReference }
  | { ok: false; end: number; reason: string } {
  const bodyStart = index + prefix.prefix.length;
  const limit = Math.min(text.length, index + VAULT_LIMITS.referenceMaxChars);
  let cursor = bodyStart;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    const character = text[cursor]!;
    if (character === "}" && text[cursor + 1] === "}") {
      const end = cursor + 2;
      if (end - index > VAULT_LIMITS.referenceMaxChars) {
        return { ok: false, end, reason: "too_long" };
      }
      const raw = text.slice(index, end);
      try {
        const parsed = parseBody(text.slice(bodyStart, cursor));
        return {
          ok: true,
          end,
          reference: { kind: prefix.kind, raw, start: index, end, ...parsed },
        };
      } catch (error) {
        return {
          ok: false,
          end,
          reason: error instanceof SecretReferenceSyntaxError ? error.reason : "invalid",
        };
      }
    }
    if (character === "{" || character === "}" || isControl(code) || cursor >= limit) {
      // Unterminated: the invalid token stops before the offending character.
      const end = Math.max(cursor, bodyStart);
      return { ok: false, end, reason: cursor >= limit ? "too_long" : "unterminated" };
    }
    cursor += 1;
  }
  return { ok: false, end: text.length, reason: "unterminated" };
}

/**
 * Split text into literal text, references and invalid candidates. Adjacent
 * text is merged; an escaped reference (`\{{secret:…}}`) becomes literal
 * text without the backslash. Never throws.
 */
export function tokenizeSecretText(text: string): SecretTextToken[] {
  if (!containsSecretReference(text)) return text.length > 0 ? [{ type: "text", value: text }] : [];
  const tokens: SecretTextToken[] = [];
  let buffer = "";
  let cursor = 0;
  const flush = () => {
    if (buffer.length > 0) tokens.push({ type: "text", value: buffer });
    buffer = "";
  };
  while (cursor < text.length) {
    const next = text.indexOf(SECRET_REFERENCE_MARKER, cursor);
    if (next < 0) {
      buffer += text.slice(cursor);
      break;
    }
    const prefix = prefixAt(text, next);
    if (prefix === null) {
      // "{{secret" not followed by ":" or "file:" is ordinary text.
      buffer += text.slice(cursor, next + SECRET_REFERENCE_MARKER.length);
      cursor = next + SECRET_REFERENCE_MARKER.length;
      continue;
    }
    // A backslash immediately before the candidate (and not already consumed)
    // escapes it: the candidate is emitted literally, without the backslash.
    const escaped = next - 1 >= cursor && text[next - 1] === "\\";
    const scanned = scanCandidate(text, next, prefix);
    if (escaped) {
      buffer += text.slice(cursor, next - 1) + text.slice(next, scanned.end);
      cursor = scanned.end;
      continue;
    }
    buffer += text.slice(cursor, next);
    flush();
    if (scanned.ok) {
      tokens.push({ type: "reference", reference: scanned.reference });
    } else {
      tokens.push({
        type: "invalid",
        raw: text.slice(next, scanned.end),
        start: next,
        end: scanned.end,
        reason: scanned.reason,
      });
    }
    cursor = scanned.end;
  }
  flush();
  return tokens;
}

/** Valid references only, in text order. */
export function findSecretReferences(text: string): SecretReference[] {
  if (!containsSecretReference(text)) return [];
  return tokenizeSecretText(text).flatMap((token) =>
    token.type === "reference" ? [token.reference] : [],
  );
}

/** Invalid candidates only, in text order. */
export function findInvalidSecretReferences(
  text: string,
): Array<Extract<SecretTextToken, { type: "invalid" }>> {
  if (!containsSecretReference(text)) return [];
  return tokenizeSecretText(text).filter(
    (token): token is Extract<SecretTextToken, { type: "invalid" }> => token.type === "invalid",
  );
}

/** Parse exactly one reference (`{{…}}`). Throws SecretReferenceSyntaxError. */
export function parseSecretReference(raw: string): SecretReference {
  const prefix = prefixAt(raw, 0);
  if (prefix === null) {
    throw new SecretReferenceSyntaxError(
      "missing_prefix",
      "a secret reference starts with {{secret: or {{secretfile:",
    );
  }
  const scanned = scanCandidate(raw, 0, prefix);
  if (!scanned.ok) throw new SecretReferenceSyntaxError(scanned.reason);
  if (scanned.end !== raw.length) {
    throw new SecretReferenceSyntaxError("trailing_text", "unexpected text after the reference");
  }
  return scanned.reference;
}

export type FormatSecretReferenceInput =
  | {
      kind?: SecretReferenceKind;
      vault?: string;
      item: string;
      field?: string;
      otp?: boolean;
      previous?: boolean;
    }
  | {
      kind?: SecretReferenceKind;
      itemId: string;
      field?: string;
      otp?: boolean;
      previous?: boolean;
    };

/** Build a reference. Throws SecretReferenceSyntaxError when a name cannot be referenced. */
export function formatSecretReference(input: FormatSecretReferenceInput): string {
  const kind = input.kind ?? "secret";
  const parts: string[] = [];
  if ("itemId" in input) {
    if (!UUID_PATTERN.test(input.itemId)) throw new SecretReferenceSyntaxError("invalid_id");
    parts.push(`${ID_PREFIX}${input.itemId.toLowerCase()}`);
  } else {
    if (input.vault !== undefined) parts.push(input.vault);
    parts.push(input.item);
  }
  if (input.field !== undefined) parts.push(input.field);
  for (const part of "itemId" in input ? parts.slice(1) : parts) assertSegment(part);
  const body = `${parts.join("/")}${input.otp ? "/otp" : ""}${input.previous ? PREVIOUS_SUFFIX : ""}`;
  const raw = `{{${kind}:${body}}}`;
  if (raw.length > VAULT_LIMITS.referenceMaxChars) throw new SecretReferenceSyntaxError("too_long");
  return raw;
}

/** NFC + trim + lowercase. For UI and dedupe only; SQL `vault_name_key` is authoritative. */
export function secretNameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/** Canonical dedupe key within one call (same target and modifiers → same key). */
export function referenceKey(ref: SecretReference): string {
  const target =
    ref.target.form === "id"
      ? `id:${ref.target.itemId.toLowerCase()}/${ref.target.field === null ? "" : secretNameKey(ref.target.field)}`
      : `path:${ref.target.segments.map(secretNameKey).join("/")}`;
  return `${ref.kind}|${target}|${ref.otp ? "otp" : ""}|${ref.previous ? "previous" : ""}`;
}

/** Remove escapes (`\{{secret:…}}` → `{{secret:…}}`); references stay as written. */
export function unescapeSecretText(text: string): string {
  if (!containsSecretReference(text)) return text;
  return tokenizeSecretText(text)
    .map((token) =>
      token.type === "text"
        ? token.value
        : token.type === "reference"
          ? token.reference.raw
          : token.raw,
    )
    .join("");
}

function walkStrings(value: unknown, visit: (text: string) => void, seen: Set<object>): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walkStrings(entry, visit, seen);
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>))
    walkStrings(entry, visit, seen);
}

/** Every valid reference in every string value of a JSON-like structure. */
export function collectReferencesDeep(value: unknown): SecretReference[] {
  const out: SecretReference[] = [];
  walkStrings(value, (text) => out.push(...findSecretReferences(text)), new Set());
  return out;
}

/** Every invalid candidate in every string value of a JSON-like structure. */
export function collectInvalidReferencesDeep(
  value: unknown,
): Array<Extract<SecretTextToken, { type: "invalid" }>> {
  const out: Array<Extract<SecretTextToken, { type: "invalid" }>> = [];
  walkStrings(value, (text) => out.push(...findInvalidSecretReferences(text)), new Set());
  return out;
}

/**
 * Deep copy with each reference replaced by `replace(ref)` and escapes
 * removed. Strings without the marker are copied unchanged; invalid
 * candidates are kept verbatim (callers reject them before replacing).
 * Object keys are not rewritten.
 */
export function replaceReferencesDeep<T>(value: T, replace: (ref: SecretReference) => string): T {
  const replaceText = (text: string): string => {
    if (!containsSecretReference(text)) return text;
    return tokenizeSecretText(text)
      .map((token) =>
        token.type === "text"
          ? token.value
          : token.type === "reference"
            ? replace(token.reference)
            : token.raw,
      )
      .join("");
  };
  const copy = (input: unknown): unknown => {
    if (typeof input === "string") return replaceText(input);
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(copy);
    if (input instanceof Uint8Array || input instanceof Date) return input;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      out[key] = copy(entry);
    }
    return out;
  };
  return copy(value) as T;
}
