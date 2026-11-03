import type { SecretRedactionPattern, SecretReference } from "@opengeni/contracts";
import {
  containsSecretRedactionMarker,
  secretRedactionMarker,
  type SecretRedactionMatcher,
} from "@opengeni/db";

/**
 * Matchers for the operator's secret history scrub (docs/secrets.md,
 * "Removing secrets from stored history"). This is the only place Opengeni
 * searches stored text for secrets, and only when an operator runs a scrub
 * for named values or patterns: a known value in its common encoded forms,
 * a URL password, a GitHub token. Each match becomes
 * `[redacted: <reference or kind>]`; markers an earlier run wrote are left
 * alone (the scrub hides them behind `[masked …]` placeholders, which every
 * matcher here skips), so a second run changes nothing.
 */

/** Values shorter than this are never searched for: a scrub rewrites stored
 * data for good, so a short "secret" must not rewrite ordinary words. */
export const SECRET_REDACTION_MIN_CHARS = 8;

/** The scrub's placeholders for kept markers, never searched inside. */
const KEPT_PLACEHOLDER = /\[masked [a-z0-9 _-]{1,40}\]/gu;

function keptRanges(text: string): Array<[number, number]> {
  if (!text.includes("[masked ")) return [];
  return [...text.matchAll(KEPT_PLACEHOLDER)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
}

function overlapsKept(start: number, end: number, kept: ReadonlyArray<[number, number]>): boolean {
  return kept.some(([from, to]) => start < to && from < end);
}

/** Standalone base64 (padded and unpadded, standard and URL-safe) and the
 * part of the encoding that depends only on the value at each of the three
 * byte alignments it can have inside a longer run (`user:token` in Basic
 * auth). */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0) return [];
  const forms: string[] = [];
  const whole = bytes.toString("base64");
  forms.push(whole, whole.replace(/=+$/u, ""));
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    if (end > start) forms.push(encoded.slice(start, end));
  }
  return forms.flatMap((form) => [form, form.replaceAll("+", "-").replaceAll("/", "_")]);
}

const PEM_BOUNDARY = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/u;
/** A line of key material (a PEM body line): hex, or base64 characters with
 * an upper-case letter, a lower-case letter and a digit. */
const KEY_MATERIAL_LINE =
  /^(?:[0-9A-Fa-f]+|(?=[^\n]*[A-Z])(?=[^\n]*[a-z])(?=[^\n]*[0-9])[A-Za-z0-9+/_-]+={0,2})$/u;

/**
 * Every form of one value searched for, longest first: as written, trimmed,
 * each key-material line of a multi-line value, JSON-escaped once and twice,
 * percent-encoded (as `encodeURIComponent` and as a submitted form writes
 * it) and base64.
 */
export function secretRedactionValueForms(value: string): string[] {
  const forms = new Set<string>();
  const add = (form: string | null | undefined) => {
    if (form && form.trim().length >= SECRET_REDACTION_MIN_CHARS) forms.add(form);
  };
  add(value);
  add(value.trim());
  const lines = value.split(/\r?\n|\r/u);
  if (lines.length > 1) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!PEM_BOUNDARY.test(trimmed) && trimmed.length >= 16 && KEY_MATERIAL_LINE.test(trimmed))
        add(trimmed);
    }
  }
  const escaped = JSON.stringify(value).slice(1, -1);
  add(escaped);
  add(JSON.stringify(escaped).slice(1, -1));
  try {
    const uri = encodeURIComponent(value);
    add(uri);
    add(uri.replaceAll("%20", "+"));
    add(uri.replace(/%[0-9A-F]{2}/gu, (match) => match.toLowerCase()));
    add(new URLSearchParams({ v: value }).toString().slice(2));
  } catch {
    // A lone surrogate has no URI form; the raw value is still searched.
  }
  for (const form of base64Forms(value)) add(form);
  return [...forms].sort((left, right) => right.length - left.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The reference as the marker names it: without its braces, so the marker can
 * never be resolved back into the value if the text is passed on.
 */
export function secretRedactionReferenceLabel(reference: Pick<SecretReference, "raw">): string {
  const inner = reference.raw.replace(/^\{\{secret(?:file)?:/u, "").replace(/\}\}$/u, "");
  return `secret:${inner}`;
}

/**
 * A matcher for one known value, in every form `secretRedactionValueForms`
 * lists. Null when the value is too short to search for, ignoring
 * surrounding whitespace: a scrub rewrites stored data for good,
 * so a run with a one-character or all-blank "secret" can never rewrite
 * everything. Also null for a value holding marker-shaped text, which the
 * scrub could never find.
 */
export function secretRedactionMatcherForValue(
  value: string,
  label: string,
): SecretRedactionMatcher | null {
  if (value.trim().length < SECRET_REDACTION_MIN_CHARS) return null;
  if (containsSecretRedactionMarker(value)) return null;
  const forms = secretRedactionValueForms(value);
  if (forms.length === 0) return null;
  const marker = secretRedactionMarker(label);
  const pattern = new RegExp(forms.map(escapeRegExp).join("|"), "gu");
  return {
    marker,
    redact: (text) => {
      const kept = keptRanges(text);
      return text.replace(pattern, (match, at: number) =>
        overlapsKept(at, at + match.length, kept) ? match : marker,
      );
    },
  };
}

/** One URL password or GitHub token found in a text; `value` is
 * `text.slice(start, end)`. */
type PatternMatch = {
  kind: "url-password" | "github-token";
  start: number;
  end: number;
  value: string;
};

const QUOTES_AND_SPACE = "\\s\"'`<>";
/**
 * `scheme://user:password@host` with any scheme; the user may be empty
 * (`redis://:password@host`), and the last `@` before the host ends the
 * password. `:\/\/` too: a URL inside JSON-escaped text.
 */
const URL_PASSWORD = new RegExp(
  `\\b[A-Za-z][A-Za-z0-9+.-]{1,30}:(?:\\\\?\\/){2}[^${QUOTES_AND_SPACE}:@\\/?#\\\\]{0,256}:([^${QUOTES_AND_SPACE}\\/?#\\\\]{1,512})(?=@[A-Za-z0-9\\[_])`,
  "gu",
);
const GITHUB_TOKEN_SHAPE =
  /(?<![A-Za-z0-9_.-])(gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})(?![A-Za-z0-9_-])/gu;
/** Stand-ins in a password's place that are not one: variables, templates,
 * references, angle-bracket examples, stars. */
const PLACEHOLDER = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\{[^}]*\}|\*+|x+|\.{3}|\u2026)$/iu;

/**
 * Every URL password and GitHub token in `text`, in order and without
 * overlaps (the earliest start wins, then the longest). A match never ends
 * inside an escape sequence: replacing the backslash of an escaped quote in
 * JSON-escaped text would break the JSON around it.
 */
function patternMatches(text: string): PatternMatch[] {
  const found: PatternMatch[] = [];
  for (const [kind, pattern] of [
    ["url-password", URL_PASSWORD],
    ["github-token", GITHUB_TOKEN_SHAPE],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      let value = match[1]!;
      let end = match.index + match[0].length;
      const trailing = /\\+$/u.exec(value)?.[0].length ?? 0;
      if (trailing > 0) {
        value = value.slice(0, -trailing);
        end -= trailing;
      }
      if (!value || PLACEHOLDER.test(value) || value.includes("{{secret") || value.includes("$("))
        continue;
      if (kind === "url-password" && /^\d{1,5}$/u.test(value)) continue;
      if (kind === "github-token" && !/\d/u.test(value)) continue;
      found.push({ kind, start: end - value.length, end, value });
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const kept: PatternMatch[] = [];
  let reached = 0;
  for (const entry of found) {
    if (entry.start < reached) continue;
    kept.push(entry);
    reached = entry.end;
  }
  return kept;
}

/** `text` with each pattern match replaced by `replace(match)`, or kept when
 * it returns null. Kept-marker placeholders are never touched. */
function replacePatternMatches(
  text: string,
  replace: (match: PatternMatch) => string | null,
): string {
  const kept = keptRanges(text);
  let out = "";
  let copied = 0;
  for (const match of patternMatches(text)) {
    if (overlapsKept(match.start, match.end, kept)) continue;
    const replaced = replace(match);
    if (replaced === null) continue;
    out += text.slice(copied, match.start) + replaced;
    copied = match.end;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const GITHUB_TOKEN = /^(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})$/u;
/**
 * The same token anywhere in a longer match, with the detector's boundaries;
 * like the detector, only a token holding a digit counts.
 */
const GITHUB_TOKEN_INSIDE =
  /(?<![A-Za-z0-9_.-])(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})(?![A-Za-z0-9_-])/gu;

/**
 * The host written right after a URL password (`…:password@host`), lower
 * case, without port or path; null when none follows.
 */
function hostAfter(text: string, match: PatternMatch): string | null {
  if (text[match.end] !== "@") return null;
  const host = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_.-]+)/u.exec(
    text.slice(match.end + 1, match.end + 300),
  );
  if (!host) return null;
  return host[1]!.toLowerCase().replace(/\.$/u, "");
}

/**
 * A stored cell can be very large (run state, a model request, a huge tool
 * output), so the patterns scan it in bounded windows, cut just after a character no
 * URL password or token contains (whitespace, or a quote that is not escaped),
 * so no match straddles two windows. A window with no such character in its
 * last 64,000 characters (a long base64-like run) is cut where it ends, the
 * only place a match could still be split.
 */
const PATTERN_WINDOW_CHARS = 1_000_000;
const PATTERN_CUT_SEARCH_CHARS = 64_000;
const PATTERN_CUT_AFTER = /[\s"]/u;

export function maskInPatternWindows(
  text: string,
  mask: (window: string) => string,
  windowChars = PATTERN_WINDOW_CHARS,
): string {
  if (text.length <= windowChars) return mask(text);
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + windowChars);
    if (end < text.length) {
      const floor = Math.max(start + 1, end - Math.min(PATTERN_CUT_SEARCH_CHARS, windowChars >> 1));
      let cut = end;
      while (cut > floor && !(PATTERN_CUT_AFTER.test(text[cut - 1]!) && text[cut - 2] !== "\\")) {
        cut -= 1;
      }
      if (cut > floor) end = cut;
    }
    parts.push(mask(text.slice(start, end)));
    start = end;
  }
  return parts.join("");
}

function patternMatcher(pattern: SecretRedactionPattern): SecretRedactionMatcher {
  const marker = secretRedactionMarker(pattern.kind);
  if (pattern.kind === "github_token") {
    // A token used as a URL password (or inside a longer one) is found as
    // that longer match; it is still a GitHub token. A whole match is
    // replaced; otherwise only the token inside it.
    const replace = (match: PatternMatch, window: string): string | null => {
      if (match.kind === "github-token") return marker;
      if (GITHUB_TOKEN.test(match.value)) return /\d/u.test(match.value) ? marker : null;
      const span = window.slice(match.start, match.end);
      const inner = span.replace(GITHUB_TOKEN_INSIDE, (token) =>
        /\d/u.test(token) ? marker : token,
      );
      return inner === span ? null : inner;
    };
    return {
      marker,
      redact: (text) =>
        maskInPatternWindows(text, (window) =>
          replacePatternMatches(window, (match) => replace(match, window)),
        ),
    };
  }
  const hosts = pattern.hosts ? new Set(pattern.hosts.map((host) => host.toLowerCase())) : null;
  return {
    marker,
    redact: (text) =>
      maskInPatternWindows(text, (window) =>
        replacePatternMatches(window, (match) => {
          if (match.kind !== "url-password") return null;
          if (!hosts) return marker;
          const host = hostAfter(window, match);
          return host && hosts.has(host) ? marker : null;
        }),
      ),
  };
}

/**
 * Matchers for the built-in patterns. `url_password` replaces only the password part of
 * `scheme://user:password@host`, optionally only for the given hosts;
 * `github_token` replaces GitHub tokens wherever they appear.
 */
export function secretRedactionMatchersForPatterns(
  patterns: readonly SecretRedactionPattern[],
): SecretRedactionMatcher[] {
  return patterns.map(patternMatcher);
}
