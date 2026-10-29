/**
 * Credentials never show on an activity row.
 *
 * Tool calls carry signed storage links, tokens and keys in their arguments
 * and output. Everything a row shows is passed through `redactSignedUrls`,
 * which hides credential values whatever shape the text takes while leaving
 * ordinary links, queries and prose readable. Display only: nothing here
 * changes what a tool ran or what the model saw.
 */

import type { ToolCallItem } from "./types";

/** Parameter names whose value is always a credential. */
const CREDENTIAL_PARAM_NAMES =
  "sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|googleaccessid|key-pair-id|access_token|id_token|refresh_token|auth_token|client_secret|api_key|apikey|password|secret|token";
/** Parameter names that are a credential only when their value looks like one (`?code=python` is not). */
const AMBIGUOUS_PARAM_NAMES = "code|key|policy|auth";
const AMBIGUOUS_PARAM = new RegExp(`^(?:${AMBIGUOUS_PARAM_NAMES})$`, "i");
/**
 * What can stand before a parameter: `?`, `&`, `#`, `;`, and the same
 * separators escaped in JSON (`\u0026`), HTML (`&amp;`) or a link nested in
 * another link (`%26`, `%3F`, `%23`).
 */
const PARAM_SEPARATOR = String.raw`(?:[?&#;]|\\+u0026|&amp;|%26|%3[Ff]|%23)`;
const PARAM_EQUALS = String.raw`(?:=|%3[Dd])`;
/** A parameter value: runs until the next separator, quote, space or bracket. */
const PARAM_VALUE = String.raw`(?:\\\/|(?!%26)[^&\s'"\x60<>#\\,;()[\]{}|])+`;
const PARAM_SOURCE = `(${PARAM_SEPARATOR})(${CREDENTIAL_PARAM_NAMES}|${AMBIGUOUS_PARAM_NAMES})(${PARAM_EQUALS})(${PARAM_VALUE})`;

/**
 * `name: value` and `name=value` where the name says it holds a credential:
 * headers (`X-Api-Key: …`, `Authorization: Bearer …`), JSON and YAML fields,
 * environment assignments (`GITHUB_TOKEN=…`). Password-named values are always
 * hidden; others only when the value looks like a credential, so
 * `max_tokens: 100` and `author: Sam` stay readable.
 */
const NAMED_SECRET =
  /(?<![\w-])([A-Za-z_][\w-]{0,40}?(?:passw(?:or)?d|passwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth|key)[\w-]{0,40})(["']?[ \t]*[:=][ \t]*)(["']?)((?:Bearer|Basic|token)[ \t]+)?([^\s'"`,;&}\]]+)/gi;
const PASSWORD_NAME = /passw(?:or)?d|passwd/i;
/** A name that is itself a credential's name (`X-Api-Key`, `GITHUB_TOKEN`, `client_secret`). */
const SECRET_NAME_END =
  /(?:^|[-_])(?:api[-_]?key|apikey|access[-_]?key|private[-_]?key|secret|token|credentials?)$/i;
const PLAIN_SCALAR = /^(?:\d+|true|false|null|none|yes|no)$/i;
/** `Bearer …`, `Basic …` and `Authorization: token …` anywhere else. */
const AUTH_SCHEME_VALUE =
  /\b([Bb]earer|Basic|(?<=[Aa]uthorization:\s*)token)(\s+)((?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,})/g;
/** `curl -u user:password` and `--user user:password`. */
const USER_PASSWORD_FLAG = /((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:'"]+:)([^\s'"]+)/g;
/** `scheme://user:password@host`. */
const URL_USER_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`<>]+:)([^\s/@'"`<>]+)(?=@)/gi;
/** Webhook links whose path is itself the credential. */
const WEBHOOK_PATH =
  /(\bhttps?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:(?:ptb\.|canary\.)?discord(?:app)?\.com)\/api\/webhooks|[\w.-]*webhook\.office\.com\/webhookb2|outlook\.office\.com\/webhook|hooks\.zapier\.com\/hooks\/catch|api\.telegram\.org)\/)([^\s'"`<>()?#]+)/gi;
/** Any other `/webhooks/…` or `/hooks/…` path, when what follows looks like a credential. */
const GENERIC_HOOK_PATH =
  /(\bhttps?:\/\/[^\s'"`<>()/]+(?:\/[^\s'"`<>()/?#]+)*?\/(?:webhooks?|hooks)\/)([^\s'"`<>()?#]+)/gi;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi;

/** Replaces the query of a signed or token-bearing link, so the credential is never shown. */
export const SIGNED_LINK_QUERY_PLACEHOLDER = "?[signature hidden]";
const SIGNED_LINK_FRAGMENT_PLACEHOLDER = "#[signature hidden]";
/** Replaces a credential value found outside a whole link. */
const SECRET_VALUE_PLACEHOLDER = "[hidden]";

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Whether a value looks like a credential rather than a word: long, with no
 * spaces, and mixing letters with digits (or long and mixing cases). Only such
 * values are hidden wherever else they occur, so `?token=settings` never
 * erases the word "settings" from a row.
 */
export function credentialShaped(value: string): boolean {
  const text = decoded(value);
  if (text.length < 12 || /\s/.test(text) || text.startsWith("[")) return false;
  if (/\d/.test(text) && /[A-Za-z]/.test(text)) return true;
  return text.length >= 24 && /[a-z]/.test(text) && /[A-Z]/.test(text);
}

/** A variable, template or secret reference stands for a value; it is not one. */
function isReference(value: string): boolean {
  return /^[$%{<*[]/.test(value) || /^\*+$/.test(value);
}

function hidesParam(name: string, value: string): boolean {
  if (isReference(value)) return false;
  return AMBIGUOUS_PARAM.test(name) ? credentialShaped(value) : true;
}

function hidesNamed(name: string, value: string): boolean {
  if (!value || isReference(value)) return false;
  if (PASSWORD_NAME.test(name) || credentialShaped(value)) return true;
  return SECRET_NAME_END.test(name) && !PLAIN_SCALAR.test(value);
}

/** `-u 1000:1000` (a user and group id) is not a password. */
function hidesUserPassword(password: string): boolean {
  return !isReference(password) && !/^\d+$/.test(password);
}

function hookSecret(path: string): boolean {
  return path.split("/").some((segment) => credentialShaped(segment));
}

/**
 * The credential-shaped values in `text` (signature, token and key parameter
 * values, secret-named fields, passwords in links, webhook paths), raw and
 * URL-decoded, so the same value can be hidden wherever else it shows up, such
 * as in a command's output.
 */
export function signedValues(text: string): string[] {
  if (isInlineData(text)) return [];
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || !credentialShaped(value)) return;
    values.add(value);
    const plain = decoded(value);
    if (plain !== value && credentialShaped(plain)) values.add(plain);
  };
  for (const match of text.matchAll(new RegExp(PARAM_SOURCE, "gi"))) {
    if (hidesParam(match[2]!, match[4]!)) add(match[4]);
  }
  for (const match of text.matchAll(NAMED_SECRET)) add(match[5]);
  for (const match of text.matchAll(AUTH_SCHEME_VALUE)) add(match[3]);
  for (const match of text.matchAll(USER_PASSWORD_FLAG)) {
    if (hidesUserPassword(match[2]!)) add(match[2]);
  }
  for (const match of text.matchAll(URL_USER_PASSWORD)) add(match[2]);
  for (const match of text.matchAll(WEBHOOK_PATH)) {
    for (const segment of match[2]!.split("/")) add(segment);
  }
  return [...values];
}

/** Inline media (a data URL or a large unbroken base64 body) holds no readable credential. */
function isInlineData(text: string): boolean {
  if (text.startsWith("data:")) return true;
  return text.length > 65_536 && /^[A-Za-z0-9+/=\s]+$/.test(text.slice(0, 4096));
}

function mayHoldCredential(text: string): boolean {
  return /[=:%]/.test(text) && !isInlineData(text);
}

function redactParams(text: string): string {
  return text.replace(
    new RegExp(PARAM_SOURCE, "gi"),
    (match, separator: string, name: string, equals: string, value: string) =>
      hidesParam(name, value) ? `${separator}${name}${equals}${SECRET_VALUE_PLACEHOLDER}` : match,
  );
}

function redactLink(url: string): string {
  const cut = url.search(/[?#]/);
  if (cut < 0) return url;
  // A trailing backslash belongs to an escaped quote in JSON text, not the link.
  const trailing = /\\+$/.exec(url)?.[0] ?? "";
  const tail = url.slice(cut, url.length - trailing.length);
  if (redactParams(tail) === tail) return url;
  const placeholder =
    url[cut] === "?" ? SIGNED_LINK_QUERY_PLACEHOLDER : SIGNED_LINK_FRAGMENT_PLACEHOLDER;
  return `${url.slice(0, cut)}${placeholder}${trailing}`;
}

/**
 * Hide every credential in `text`, whatever shape it takes:
 * - a signed or token-bearing link loses its query or fragment, keeping the
 *   host and path so it is still recognisable;
 * - a signature, token or key parameter anywhere else (`GET /a.json?sig=…`,
 *   `\u0026token=…` in JSON, `#access_token=…`), a secret-named header, field or
 *   variable, a `Bearer` token, `curl -u` and link passwords, and the path of a
 *   webhook link keep their name and lose their value;
 * - any of `values` (see `signedValues`, by default those found in `text`) is
 *   hidden wherever it occurs.
 * Ambiguous names (`code`, `key`, `policy`) are hidden only when their value
 * looks like a credential, so ordinary queries and prose stay readable.
 */
export function redactSignedUrls(
  text: string,
  values: readonly string[] = signedValues(text),
): string {
  let out = text;
  if (mayHoldCredential(out)) {
    out = out.replace(WEBHOOK_PATH, (_match, base: string) => `${base}${SECRET_VALUE_PLACEHOLDER}`);
    out = out.replace(GENERIC_HOOK_PATH, (match, base: string, path: string) =>
      hookSecret(path) ? `${base}${SECRET_VALUE_PLACEHOLDER}` : match,
    );
    out = out.replace(URL_USER_PASSWORD, (match, head: string, password: string) =>
      isReference(password) ? match : `${head}${SECRET_VALUE_PLACEHOLDER}`,
    );
    if (out.includes("://")) out = out.replace(URL_PATTERN, redactLink);
    out = redactParams(out);
    out = out.replace(
      NAMED_SECRET,
      (
        match,
        name: string,
        equals: string,
        quote: string,
        scheme: string | undefined,
        value: string,
      ) =>
        hidesNamed(name, value)
          ? `${name}${equals}${quote}${scheme ?? ""}${SECRET_VALUE_PLACEHOLDER}`
          : match,
    );
    out = out.replace(USER_PASSWORD_FLAG, (match, head: string, password: string) =>
      hidesUserPassword(password) ? `${head}${SECRET_VALUE_PLACEHOLDER}` : match,
    );
  }
  out = out.replace(
    AUTH_SCHEME_VALUE,
    (_match, scheme: string, space: string) => `${scheme}${space}${SECRET_VALUE_PLACEHOLDER}`,
  );
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (credentialShaped(value) && out.includes(value)) {
      out = out.split(value).join(SECRET_VALUE_PLACEHOLDER);
    }
  }
  return out;
}

/** Every credential-shaped value in a nested value's strings. */
export function signedValuesDeep(value: unknown): string[] {
  const values = new Set<string>();
  walkStrings(value, 0, (text) => {
    for (const found of signedValues(text)) values.add(found);
  });
  return [...values];
}

/** A copy of a nested value with every string redacted; other leaves are kept as they are. */
export function redactDeep<T>(value: T, values: readonly string[]): T {
  return mapStrings(value, 0, (text) => redactSignedUrls(text, values)) as T;
}

const MAX_DEPTH = 16;

const redactedCalls = new WeakMap<ToolCallItem, ToolCallItem>();

/**
 * A tool call as every renderer sees it: its arguments, output, provider item
 * and display metadata with every credential hidden, including any credential
 * value found in one of them and repeated in another. The timeline hands only
 * this copy to tool renderers, so no current or future renderer can show an
 * unredacted signature, token or key. Returns the same item when there is
 * nothing to hide; results are cached per item.
 */
export function redactToolCall(item: ToolCallItem): ToolCallItem {
  const cached = redactedCalls.get(item);
  if (cached) return cached;
  const values = signedValuesDeep([item.arguments, item.output, item.raw, item.display]);
  const args = redactDeep(item.arguments, values);
  const output = redactDeep(item.output, values);
  const raw = redactDeep(item.raw, values);
  const display = item.display ? redactDeep(item.display, values) : item.display;
  const changed =
    args !== item.arguments ||
    output !== item.output ||
    raw !== item.raw ||
    display !== item.display;
  const redacted: ToolCallItem = changed
    ? { ...item, arguments: args, output, raw, ...(display ? { display } : {}) }
    : item;
  redactedCalls.set(item, redacted);
  return redacted;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function walkStrings(value: unknown, depth: number, visit: (text: string) => void): void {
  if (typeof value === "string") return visit(value);
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) walkStrings(entry, depth + 1, visit);
  } else if (isPlainObject(value)) {
    for (const entry of Object.values(value)) walkStrings(entry, depth + 1, visit);
  }
}

function mapStrings(value: unknown, depth: number, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const mapped = mapStrings(entry, depth + 1, map);
      if (mapped !== entry) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const mapped = mapStrings(entry, depth + 1, map);
    if (mapped !== entry) changed = true;
    next[key] = mapped;
  }
  return changed ? next : value;
}
