import { randomUUID } from "node:crypto";
import { parseSecretReference } from "@opengeni/contracts";
import {
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  LOSSLESS_CONTENT_CODEC_VERSION,
  toPostgresLosslessJson,
  toPostgresLosslessText,
} from "./lossless-json";

/**
 * Text rewriting for the secret history scrub (docs/secrets.md, "Removing
 * secrets from stored history"). Matching itself belongs to the masking
 * matchers; this module only applies their ranges to stored text and JSON.
 */

/**
 * What the scrub needs from a matcher (the masking matchers in
 * `@opengeni/contracts` provide them). `marker` is the exact text written in
 * place of each match, `[redacted: <reference or kind>]`; it never contains a
 * value. `redact` returns the text with every match replaced by `marker` and
 * must leave markers already in the text untouched, so a second run changes
 * nothing.
 */
export type SecretRedactionMatcher = {
  readonly marker: string;
  redact(text: string): string;
};

export type SecretRedactionTextResult = { text: string; matches: number };

/**
 * Marker-shaped text, `[redacted: <label>]`, with the label as
 * `secretRedactionMarker` writes it (at most 300 characters, no brackets).
 * The database's marker shape check is looser; this only decides which
 * markers a run keeps.
 */
const MARKER_SHAPE = /\[redacted: ([^[\]\r\n"\\]{1,300})\]/gu;

/**
 * True when `text` holds marker-shaped text. Such a value is refused: where
 * that part is a kept marker, the value could never be found.
 */
export function containsSecretRedactionMarker(text: string): boolean {
  MARKER_SHAPE.lastIndex = 0;
  return MARKER_SHAPE.test(text);
}

/**
 * Whether a marker's label is one the scrub writes: a pattern kind, the
 * generic fallback, or a vault reference without its braces. Other
 * marker-shaped text was typed by someone and is searched like any text
 * (text typed exactly like a reference marker is kept, like a real one).
 */
function isScrubMarkerLabel(label: string): boolean {
  if (label === "url_password" || label === "github_token" || label === "secret") return true;
  if (!label.startsWith("secret:")) return false;
  try {
    parseSecretReference(`{{${label}}}`);
    return true;
  } catch {
    return false;
  }
}

/** The longest placeholder both masking modules skip: `[masked <1-40 characters>]`. */
const PLACEHOLDER_MAX = 49;

/** `open` with dashes and `]` to make `size` characters (never shorter than `open]`). */
function padPlaceholder(open: string, size: number): string {
  return `${open}${"-".repeat(Math.max(0, size - open.length - 1))}]`;
}

/**
 * A run of `[masked …]` placeholders as long as the marker it stands for
 * (except a marker shorter than one placeholder), so matchers that look at
 * a text's length (a clipped value at the end of a long text) see the
 * stored length.
 */
function placeholderRun(length: number, nonce: string, index: number): string {
  const head = `[masked k ${nonce} ${index}`;
  if (length <= PLACEHOLDER_MAX) return padPlaceholder(head, length);
  const padOpen = `[masked p ${nonce}`;
  const minPad = padOpen.length + 1;
  let rest = length - PLACEHOLDER_MAX;
  let first = PLACEHOLDER_MAX;
  const pieces = Math.ceil(rest / PLACEHOLDER_MAX);
  if (rest < minPad) {
    first = length - minPad;
    rest = minPad;
  }
  let run = padPlaceholder(head, first);
  for (let piece = 0; piece < pieces; piece += 1) {
    const size = Math.floor(rest / (pieces - piece));
    run += padPlaceholder(padOpen, size);
    rest -= size;
  }
  return run;
}

/**
 * Run `redact` on the whole text with every marker an earlier run wrote
 * swapped for placeholders masking never searches (`[masked …]`, as long as
 * the marker), then put the markers back. A later run, with a value that happens to appear in an
 * earlier marker's label (such as a username named in a reference), never
 * rewrites a marker, and every matcher still sees the text around it as it
 * is (a host after `@`, where a long text ends).
 */
function redactAroundMarkers(text: string, redact: (text: string) => string): string {
  if (!text.includes("[redacted: ")) return redact(text);
  let nonce = randomUUID().replaceAll("-", "").slice(0, 8);
  while (text.includes(nonce)) nonce = randomUUID().replaceAll("-", "").slice(0, 8);
  const kept: string[] = [];
  const hidden = text.replace(MARKER_SHAPE, (marker, label: string) => {
    if (!isScrubMarkerLabel(label)) return marker;
    kept.push(marker);
    return placeholderRun(marker.length, nonce, kept.length - 1);
  });
  if (kept.length === 0) return redact(text);
  const placeholder = new RegExp(
    `\\[masked k ${nonce} (\\d+)-*\\](?:\\[masked p ${nonce}-*\\])*`,
    "gu",
  );
  return redact(hidden).replace(placeholder, (_, index: string) => kept[Number(index)]!);
}

/**
 * The marker written in place of a match: a label, never a value. Brackets,
 * quotes, backslashes, control characters and lone surrogates are dropped and
 * the label is cut at 300 code points, so the marker reads the same in plain
 * and JSON text and always passes the cell writer's marker shape check.
 */
export function secretRedactionMarker(label: string): string {
  const safe =
    Array.from(label.replace(/[[\]"\\\p{Cc}\p{Cs}]/gu, ""))
      .slice(0, 300)
      .join("")
      .trim() || "secret";
  return `[redacted: ${safe}]`;
}

function occurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

/**
 * Apply every matcher in turn. Matches are counted by the markers each one
 * adds, so a matcher needs no counting interface of its own.
 */
export function redactSecretText(
  text: string,
  matchers: readonly SecretRedactionMatcher[],
): SecretRedactionTextResult {
  if (text.length === 0 || matchers.length === 0) return { text, matches: 0 };
  let output = text;
  let matches = 0;
  for (const matcher of matchers) {
    const before = output;
    const after = redactAroundMarkers(before, (part) => matcher.redact(part));
    if (after === before) continue;
    const added = occurrences(after, matcher.marker) - occurrences(before, matcher.marker);
    output = after;
    matches += Math.max(1, added);
  }
  return { text: output, matches };
}

/** A stored text column, decoded and re-encoded through its lossless codec version. */
export function redactStoredText(
  stored: string,
  codecVersion: number | null,
  matchers: readonly SecretRedactionMatcher[],
): SecretRedactionTextResult {
  const decoded = fromPostgresLosslessText(stored, codecVersion);
  const result = redactSecretText(decoded, matchers);
  if (result.matches === 0) return { text: stored, matches: 0 };
  return {
    text:
      codecVersion === LOSSLESS_CONTENT_CODEC_VERSION
        ? toPostgresLosslessText(result.text)
        : result.text,
    matches: result.matches,
  };
}

/**
 * Redact every string value of JSON text, leaving keys, numbers, structure
 * and untouched strings byte for byte. Keys are never rewritten: two keys
 * redacted to the same marker would collapse into one. Each string is decoded first,
 * so a match can never cross a JSON boundary and escaped forms are seen as the
 * text they stand for. Values written through the lossless codec (version 1)
 * are decoded and re-encoded around the rewrite.
 */
export function redactJsonText(
  json: string,
  codecVersion: number | null,
  matchers: readonly SecretRedactionMatcher[],
): SecretRedactionTextResult {
  let output = "";
  let cursor = 0;
  let matches = 0;
  let index = 0;
  const length = json.length;
  while (index < length) {
    const code = json.charCodeAt(index);
    if (code !== 0x22) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < length) {
      const inner = json.charCodeAt(index);
      if (inner === 0x5c) {
        index += 2;
        continue;
      }
      if (inner === 0x22) break;
      index += 1;
    }
    if (index >= length) throw new SyntaxError("Unterminated JSON string");
    const end = index + 1;
    index = end;
    let next = end;
    while (next < length && /\s/u.test(json[next]!)) next += 1;
    if (json[next] === ":") continue;
    const token = json.slice(start, end);
    const value = JSON.parse(token) as string;
    const decoded = fromPostgresLosslessJson(value, codecVersion);
    if (typeof decoded !== "string") continue;
    const result = redactSecretText(decoded, matchers);
    if (result.matches === 0) continue;
    const encoded =
      codecVersion === LOSSLESS_CONTENT_CODEC_VERSION
        ? toPostgresLosslessJson(result.text)
        : result.text;
    output += json.slice(cursor, start) + JSON.stringify(encoded);
    cursor = end;
    matches += result.matches;
  }
  if (matches === 0) return { text: json, matches: 0 };
  output += json.slice(cursor);
  return { text: output, matches };
}

/** One top-level member of a JSON object text: its key and its value's span. */
export type JsonObjectMember = { key: string; start: number; end: number };

function skipJsonSpace(json: string, index: number): number {
  let at = index;
  while (at < json.length && /\s/u.test(json[at]!)) at += 1;
  return at;
}

function jsonStringEnd(json: string, start: number): number {
  let index = start + 1;
  while (index < json.length) {
    const code = json.charCodeAt(index);
    if (code === 0x5c) {
      index += 2;
      continue;
    }
    if (code === 0x22) return index + 1;
    index += 1;
  }
  throw new SyntaxError("Unterminated JSON string");
}

function jsonValueEnd(json: string, start: number): number {
  const first = json[start];
  if (first === '"') return jsonStringEnd(json, start);
  if (first === "{" || first === "[") {
    let depth = 0;
    let index = start;
    while (index < json.length) {
      const char = json[index]!;
      if (char === '"') {
        index = jsonStringEnd(json, index);
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    throw new SyntaxError("Unterminated JSON value");
  }
  let index = start;
  while (index < json.length && !/[,}\]\s]/u.test(json[index]!)) index += 1;
  if (index === start) throw new SyntaxError("Expected a JSON value");
  return index;
}

/**
 * The top-level members of JSON object text, without parsing the values (a
 * row's numeric columns keep their exact digits).
 */
export function jsonObjectMembers(json: string): JsonObjectMember[] {
  const members: JsonObjectMember[] = [];
  let index = skipJsonSpace(json, 0);
  if (json[index] !== "{") throw new SyntaxError("Expected a JSON object");
  index = skipJsonSpace(json, index + 1);
  if (json[index] === "}") return members;
  for (;;) {
    if (json[index] !== '"') throw new SyntaxError("Expected a JSON key");
    const keyEnd = jsonStringEnd(json, index);
    const key = JSON.parse(json.slice(index, keyEnd)) as string;
    index = skipJsonSpace(json, keyEnd);
    if (json[index] !== ":") throw new SyntaxError("Expected a colon");
    const start = skipJsonSpace(json, index + 1);
    const end = jsonValueEnd(json, start);
    members.push({ key, start, end });
    index = skipJsonSpace(json, end);
    if (json[index] === ",") {
      index = skipJsonSpace(json, index + 1);
      continue;
    }
    if (json[index] === "}") return members;
    throw new SyntaxError("Expected a comma or closing brace");
  }
}

/** Replace member value spans of JSON object text (spans must not overlap). */
export function replaceJsonMembers(
  json: string,
  replacements: readonly { member: JsonObjectMember; text: string }[],
): string {
  const ordered = [...replacements].sort((a, b) => a.member.start - b.member.start);
  let output = "";
  let cursor = 0;
  for (const { member, text } of ordered) {
    output += json.slice(cursor, member.start) + text;
    cursor = member.end;
  }
  return output + json.slice(cursor);
}

const CODEC_SUFFIX = "_codec_version";

/**
 * Redact a database row written as JSON (`row_to_json`, as in the session
 * archive bundle). A column with a `<column>_codec_version` of 1 is decoded
 * and re-encoded through the lossless codec; `textColumns` names the columns
 * stored as text rather than JSON, which use the text form of the codec.
 */
export function redactJsonRowText(
  json: string,
  textColumns: ReadonlySet<string>,
  matchers: readonly SecretRedactionMatcher[],
): SecretRedactionTextResult {
  if (!json.includes(`${CODEC_SUFFIX}"`)) return redactJsonText(json, null, matchers);
  const members = jsonObjectMembers(json);
  const codecs = new Map<string, number>();
  for (const member of members) {
    if (!member.key.endsWith(CODEC_SUFFIX)) continue;
    const version = Number(json.slice(member.start, member.end));
    if (version === LOSSLESS_CONTENT_CODEC_VERSION) {
      codecs.set(member.key.slice(0, -CODEC_SUFFIX.length), version);
    }
  }
  if (codecs.size === 0) return redactJsonText(json, null, matchers);
  const replacements: { member: JsonObjectMember; text: string }[] = [];
  let matches = 0;
  for (const member of members) {
    const text = json.slice(member.start, member.end);
    const codec = codecs.get(member.key) ?? null;
    let result: SecretRedactionTextResult;
    if (codec !== null && textColumns.has(member.key) && text.startsWith('"')) {
      const stored = redactStoredText(JSON.parse(text) as string, codec, matchers);
      result =
        stored.matches === 0
          ? stored
          : { text: JSON.stringify(stored.text), matches: stored.matches };
    } else {
      result = redactJsonText(text, codec, matchers);
    }
    if (result.matches === 0) continue;
    matches += result.matches;
    replacements.push({ member, text: result.text });
  }
  if (matches === 0) return { text: json, matches: 0 };
  return { text: replaceJsonMembers(json, replacements), matches };
}

/**
 * Redact a JSON value already in memory (a hydrated model-request snapshot).
 * Returns the same value when nothing matched.
 */
export function redactJsonValue<T>(
  value: T,
  matchers: readonly SecretRedactionMatcher[],
): { value: T; matches: number } {
  if (value === null || value === undefined) return { value, matches: 0 };
  const json = JSON.stringify(value);
  if (json === undefined) return { value, matches: 0 };
  const result = redactJsonText(json, null, matchers);
  if (result.matches === 0) return { value, matches: 0 };
  return { value: JSON.parse(result.text) as T, matches: result.matches };
}
