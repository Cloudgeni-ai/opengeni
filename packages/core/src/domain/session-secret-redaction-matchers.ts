import {
  compileSecretValueMasks,
  maskSecretShapesInText,
  maskSecretValuesInText,
  SECRET_VALUE_MASK_MIN_CHARS,
  secretValueForms,
  type SecretShapeMatch,
  type SecretRedactionPattern,
  type SecretReference,
} from "@opengeni/contracts";
import {
  containsSecretRedactionMarker,
  secretRedactionMarker,
  type SecretRedactionMatcher,
} from "@opengeni/db";

/**
 * Matchers for the secret history scrub, built on the masking module's
 * matchers (docs/secrets.md, "Masking"), so the scrub finds exactly what
 * masking would have caught: a known value with its JSON-escaped,
 * percent-encoded and base64 forms, and the narrow secret shapes. Each
 * match becomes `[redacted: <reference or kind>]`; markers an earlier run
 * wrote are left alone (the scrub hides them behind placeholders masking
 * never searches while a matcher runs), so a second run changes nothing.
 */

/**
 * The reference as the marker names it: without its braces, so the marker can
 * never be resolved back into the value if the text is passed on.
 */
export function secretRedactionReferenceLabel(reference: Pick<SecretReference, "raw">): string {
  const inner = reference.raw.replace(/^\{\{secret(?:file)?:/u, "").replace(/\}\}$/u, "");
  return `secret:${inner}`;
}

/**
 * A matcher for one known value, in every form masking recognizes. Null when
 * the value is too short to search for, ignoring surrounding whitespace:
 * masking skips short values too, and a scrub rewrites stored data for good,
 * so a run with a one-character or all-blank "secret" can never rewrite
 * everything. Also null for a value holding marker-shaped text, which the
 * scrub could never find.
 */
export function secretRedactionMatcherForValue(
  value: string,
  label: string,
): SecretRedactionMatcher | null {
  if (value.trim().length < SECRET_VALUE_MASK_MIN_CHARS) return null;
  if (containsSecretRedactionMarker(value)) return null;
  if (secretValueForms(value, { minChars: SECRET_VALUE_MASK_MIN_CHARS }).length === 0) return null;
  const marker = secretRedactionMarker(label);
  const masks = compileSecretValueMasks([{ value, label: marker }]);
  return { marker, redact: (text) => maskSecretValuesInText(text, masks) };
}

const GITHUB_TOKEN = /^(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})$/u;
/**
 * The same token anywhere in a longer match, with the masking detector's
 * boundaries; like the detector, only a token holding a digit counts.
 */
const GITHUB_TOKEN_INSIDE =
  /(?<![A-Za-z0-9_.-])(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})(?![A-Za-z0-9_-])/gu;

/**
 * The host written right after a URL password (`…:password@host`), lower
 * case, without port or path; null when none follows.
 */
function hostAfter(text: string, match: SecretShapeMatch): string | null {
  if (text[match.end] !== "@") return null;
  const host = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_.-]+)/u.exec(
    text.slice(match.end + 1, match.end + 300),
  );
  if (!host) return null;
  return host[1]!.toLowerCase().replace(/\.$/u, "");
}

/**
 * Shape detection scans a bounded prefix of one string. A stored cell can be
 * larger (run state, a model request, a huge tool output), so the patterns
 * scan it in windows well under that bound, cut just after a character no
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
    // Masking reports a token used as a URL password (or inside a longer
    // one) as that longer match; it is still a GitHub token. A whole match is
    // replaced; otherwise only the token inside it.
    const replace = (match: SecretShapeMatch, window: string): string | null => {
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
          maskSecretShapesInText(window, (match) => replace(match, window)),
        ),
    };
  }
  const hosts = pattern.hosts ? new Set(pattern.hosts.map((host) => host.toLowerCase())) : null;
  return {
    marker,
    redact: (text) =>
      maskInPatternWindows(text, (window) =>
        maskSecretShapesInText(window, (match) => {
          if (match.kind !== "url-password") return null;
          if (!hosts) return marker;
          const host = hostAfter(window, match);
          return host && hosts.has(host) ? marker : null;
        }),
      ),
  };
}

/**
 * Matchers for the built-in patterns, using the masking module's shape
 * detectors. `url_password` replaces only the password part of
 * `scheme://user:password@host`, optionally only for the given hosts;
 * `github_token` replaces GitHub tokens wherever they appear.
 */
export function secretRedactionMatchersForPatterns(
  patterns: readonly SecretRedactionPattern[],
): SecretRedactionMatcher[] {
  return patterns.map(patternMatcher);
}
