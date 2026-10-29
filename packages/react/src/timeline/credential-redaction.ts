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

/** Words that, in a name, say it holds a credential. */
const SECRET_NAME_WORDS =
  "passw(?:or)?d|passwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth|key";
/**
 * `name: value` and `name=value` where the name says it holds a credential:
 * headers (`X-Api-Key: …`, `Authorization: Bearer …`), JSON and YAML fields
 * (`"password": "…"`, `secret: …`), environment assignments (`TOKEN=…`,
 * `GITHUB_TOKEN=…`). The name may be the bare word. A quoted value is taken
 * whole, up to its closing quote. A name may follow an escaped line break
 * (`\nsecret: …` inside JSON text). See `hidesNamed` for which values are hidden.
 */
const NAMED_SECRET = new RegExp(
  String.raw`(?<=^|[^\w\\-]|\\[nrt])((?:[A-Za-z_][\w-]{0,40}?)?(?:${SECRET_NAME_WORDS})[\w-]{0,40})(\\?["']?[ \t]*[:=][ \t]*)(\\?["']?)((?:Bearer|Basic|token)[ \t]+)?((?<=")[^"\\\n]+|(?<=')[^'\\\n]+|[^\s'"\x60,;&}\]\\]+)`,
  "gi",
);
/** `--password …`, `--token=…`, `--api-key …`: a flag whose name ends in a credential's name. */
const FLAG_SECRET =
  /((?:^|[\s'"]|\\[nrt])--?(?:[A-Za-z][\w-]{0,40}?[-_])?(?:passw(?:or)?d|passwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credentials?))(=|[ \t]+)(["']?)([A-Za-z0-9_.~+/][^\s'"`\\]*)/gi;
/** `{"name": "X-Api-Key", "value": "…"}` written out as JSON text (headers, cookies). */
const NAME_VALUE_PAIR =
  /((\\?")(?:name|key|header)\2[ \t]*:[ \t]*\2([^"\\]{1,80})\2[ \t]*,[ \t]*\2value\2[ \t]*:[ \t]*\2)([^"\\]*)(?=\2)/gi;
/** A field name that says its value is a credential (see `hidesField`). */
const SECRET_FIELD_NAME = new RegExp(
  `^(?:[A-Za-z_-][\\w-]{0,40}?)?(?:${SECRET_NAME_WORDS})[\\w-]{0,40}$`,
  "i",
);
/** Header fields whose whole value is a credential. */
const WHOLE_SECRET_FIELD = /^(?:proxy-)?authorization$|^(?:set-)?cookie$/i;
/** A bare credential word as a name, where `token: 5` or `secret: sauce` may be prose. */
const BARE_SECRET_NAME =
  /^(?:secret|token|credentials?|api[-_]?key|apikey|access[-_]?key|private[-_]?key)$/i;
const PASSWORD_NAME = /passw(?:or)?d|passwd/i;
/** A name that is itself a credential's name (`X-Api-Key`, `GITHUB_TOKEN`, `client_secret`). */
const SECRET_NAME_END =
  /(?:^|[-_])(?:api[-_]?key|apikey|access[-_]?key|private[-_]?key|secret|token|credentials?)$/i;
const PLAIN_SCALAR = /^(?:\d+|true|false|null|none|yes|no)$/i;
/** `Bearer …`, `Basic …` and `Authorization: token …` anywhere else. */
const AUTH_SCHEME_VALUE =
  /\b([Bb]earer|Basic|(?<=[Aa]uthorization:\s*)token)(\s+)((?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}|(?<=[Bb]earer\s+)[A-Za-z]{16,}(?![A-Za-z0-9._~+/=-]))/g;
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

/**
 * Whether a `name: value` or `name=value` value is hidden. A password-named
 * value always is, and any value that looks like a credential. A value named
 * as a secret, token or key (`X-Api-Key`, `GITHUB_TOKEN`, `secret`) is too,
 * unless it is a number or a constant, or the bare word is followed by a
 * colon and one plain lowercase word (`token: 5`, `secret: sauce` read as
 * prose). Other names that merely contain a credential word (`max_tokens`,
 * `author`, `monkey`, a bare `key` or `auth`) are hidden only when the value
 * looks like a credential, so `{"key": "Enter"}` stays readable.
 */
function hidesNamed(name: string, value: string, separator = "=", quote = ""): boolean {
  if (!value || isReference(value)) return false;
  if (PASSWORD_NAME.test(name) || credentialShaped(value)) return true;
  if (!SECRET_NAME_END.test(name) || PLAIN_SCALAR.test(value)) return false;
  const prose =
    BARE_SECRET_NAME.test(name) && !/["'=]/.test(separator) && !quote && /^[a-z]+$/.test(value);
  return !prose;
}

/**
 * Whether an object field's value is hidden, by the field's name: `{password:
 * …}`, `{api_key: …}`, `{"X-Api-Key": …}`, an `Authorization` or cookie
 * header, and the value of a `{name: "X-Api-Key", value: …}` pair. A field is
 * structured, so a bare `token` or `secret` field hides any word.
 */
function hidesField(name: string, value: string): boolean {
  if (WHOLE_SECRET_FIELD.test(name)) return value.trim() !== "" && !isReference(value.trim());
  return SECRET_FIELD_NAME.test(name) && hidesNamed(name, value);
}

/** A hidden field's value as shown: an `Authorization` header keeps its scheme. */
function hiddenField(value: string): string {
  const scheme = /^\s*(Bearer|Basic|token|Digest)\s+/i.exec(value)?.[0] ?? "";
  return `${scheme}${SECRET_VALUE_PLACEHOLDER}`;
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
  for (const match of text.matchAll(FLAG_SECRET)) add(match[4]);
  for (const match of text.matchAll(NAME_VALUE_PAIR)) {
    if (hidesField(match[3]!, match[4]!)) add(match[4]);
  }
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
        hidesNamed(name, value, equals, quote)
          ? `${name}${equals}${quote}${scheme ?? ""}${SECRET_VALUE_PLACEHOLDER}`
          : match,
    );
    out = out.replace(
      NAME_VALUE_PAIR,
      (match, head: string, _quote: string, name: string, value: string) =>
        hidesField(name, value) ? `${head}${hiddenField(value)}` : match,
    );
    out = out.replace(USER_PASSWORD_FLAG, (match, head: string, password: string) =>
      hidesUserPassword(password) ? `${head}${SECRET_VALUE_PLACEHOLDER}` : match,
    );
  }
  out = out.replace(
    FLAG_SECRET,
    (match, flag: string, separator: string, quote: string, value: string) =>
      hidesNamed(flag.trim(), value)
        ? `${flag}${separator}${quote}${SECRET_VALUE_PLACEHOLDER}`
        : match,
  );
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

/**
 * Every credential-shaped value in a nested value's strings, including the
 * values of secret-named fields (`{access_token: …}`, `{"X-Api-Key": …}`).
 */
export function signedValuesDeep(value: unknown): string[] {
  const values = new Set<string>();
  walkStrings(value, 0, undefined, (text, field) => {
    if (field !== undefined && credentialShaped(text) && hidesField(field, text)) {
      values.add(text);
    }
    for (const found of signedValues(text)) values.add(found);
  });
  return [...values];
}

/**
 * A copy of a nested value with every string redacted and every secret-named
 * field's value hidden (see `hidesField`); other leaves are kept as they are.
 * Field names are kept, so `{password: "…"}` shows as `{password: "[hidden]"}`.
 */
export function redactDeep<T>(value: T, values: readonly string[]): T {
  return mapStrings(value, 0, undefined, (text, field) =>
    field !== undefined && hidesField(field, text)
      ? hiddenField(text)
      : redactSignedUrls(text, values),
  ) as T;
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

/**
 * The name a field's value goes by: its own key, or for the `value` of a
 * `{name: "X-Api-Key", value: …}` pair (headers, cookies, form fields), that
 * name. Array entries go by their array's name.
 */
function fieldNames(value: Record<string, unknown>): (key: string) => string {
  const pairName = ["name", "key", "header"]
    .map((key) => value[key])
    .find((name): name is string => typeof name === "string");
  return (key) => (key === "value" && pairName !== undefined ? pairName : key);
}

type FieldVisitor = (text: string, field: string | undefined) => void;

function walkStrings(
  value: unknown,
  depth: number,
  field: string | undefined,
  visit: FieldVisitor,
): void {
  if (typeof value === "string") return visit(value, field);
  if (typeof value === "number") return visit(String(value), field);
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) walkStrings(entry, depth + 1, field, visit);
  } else if (isPlainObject(value)) {
    const nameOf = fieldNames(value as Record<string, unknown>);
    for (const [key, entry] of Object.entries(value)) {
      walkStrings(entry, depth + 1, nameOf(key), visit);
    }
  }
}

function mapStrings(
  value: unknown,
  depth: number,
  field: string | undefined,
  map: (text: string, field: string | undefined) => string,
): unknown {
  if (typeof value === "string") return map(value, field);
  if (typeof value === "number") {
    // A number is a credential only under a password-like name (a PIN).
    const mapped = field === undefined ? null : map(String(value), field);
    return mapped !== null && mapped !== String(value) ? mapped : value;
  }
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const mapped = mapStrings(entry, depth + 1, field, map);
      if (mapped !== entry) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;
  const nameOf = fieldNames(value as Record<string, unknown>);
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const mapped = mapStrings(entry, depth + 1, nameOf(key), map);
    if (mapped !== entry) changed = true;
    next[key] = mapped;
  }
  return changed ? next : value;
}
