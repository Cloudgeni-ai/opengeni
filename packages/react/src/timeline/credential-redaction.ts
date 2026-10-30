/**
 * Credentials never show on an activity row.
 *
 * Tool calls carry signed storage links, tokens and keys in their arguments
 * and output. Everything a row shows is passed through `redactSignedUrls`,
 * which hides credential values whatever shape the text takes while leaving
 * ordinary links, queries and prose readable. Display only: nothing here
 * changes what a tool ran or what the model saw.
 *
 * Three kinds of rule run, in this order of trust:
 * - a secret reference (`secret:Item/field` in double braces) names a vault
 *   item and is never touched: references are set aside before any rule
 *   runs and put back afterwards, so a row still shows which item an agent
 *   used;
 * - shape rules hide what is a credential by its form wherever it shows:
 *   signed links, link passwords, webhook paths, known token formats,
 *   private keys, `Authorization` and cookie headers;
 * - name rules hide a value because of the name it is given (`TOKEN=…`,
 *   `--password …`, `"api_key": "…"`). They read a text as a command (what
 *   an agent or person typed, where any value under a credential's name is
 *   hidden) or as printed text (output, file contents, patches, prose, where
 *   code such as `password: string` and prose must stay readable, so only a
 *   quoted literal, a `NAME=value` line, a `name: value` config line or a
 *   value shaped like a credential is hidden).
 */

import type { ToolCallItem } from "./types";

/** How name rules read a text (see the module comment). */
export type CredentialContext = "command" | "text";

/** A secret reference names a vault item; it is not a credential. */
const SECRET_REFERENCE = /\{\{\s*secret:[^{}\n]*\}\}/g;
/** Where a reference was set aside while the rules ran. */
const REFERENCE_MARK = /\uE000(\d+)\uE001/g;

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
  "passw(?:or)?d|passwd|pass|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth|key";
/**
 * `name: value` and `name=value` where the name says it holds a credential:
 * headers (`X-Api-Key: …`, `Authorization: Bearer …`), JSON and YAML fields
 * (`"password": "…"`, `secret: …`), environment assignments (`TOKEN=…`,
 * `GITHUB_TOKEN=…`). The name may be the bare word. A quoted value is taken
 * whole, up to its closing quote. A name may follow an escaped line break
 * (`\nsecret: …` inside JSON text). A comparison or arrow (`token === x`,
 * `token => …`) is not an assignment, and a value stops at a bracket. See
 * `hidesNamed` for which values are hidden.
 */
const NAMED_SECRET = new RegExp(
  String.raw`(?<=^|[^\w\\-]|\\[nrt])((?:[A-Za-z_][\w-]{0,40}?)?(?:${SECRET_NAME_WORDS})[\w-]{0,40})(\\?["']?[ \t]*(?::(?![:=])|=(?![=>~]))[ \t]*)(\\?["']?)((?:Bearer|Basic|token)[ \t]+)?((?<=")[^"\\\n]+|(?<=')[^'\\\n]+|[^\s'"\x60,;&{}[\]()\\]+)`,
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
const BARE_PROSE_NAME = /^(?:secret|token|credentials?)$/i;
/** A password's name: `password`, `passwd`, `DB_PASS`, `MYSQL_PWD` (not `bypass` or `PWD`). */
const PASSWORD_NAME = /passw(?:or)?d|passwd|(?:^|[-_])pass$|[-_]pwd$/i;
/** A name that is itself a credential's name (`X-Api-Key`, `GITHUB_TOKEN`, `client_secret`). */
const SECRET_NAME_END =
  /(?:^|[-_])(?:api[-_]?key|apikey|access[-_]?key|private[-_]?key|secret|token|credentials?)$/i;
const PLAIN_SCALAR = /^(?:\d+|true|false|null|none|yes|no)$/i;
/** A constant no password is (a password may be all digits, a PIN). */
const CONSTANT = /^(?:true|false|null|none|nil|undefined|yes|no)$/i;
/** A type or constant in code (`password: string`), not a setting's value. */
const CODE_WORD =
  /^(?:string|number|boolean|bigint|any|unknown|never|object|undefined|void|str|int|float|bool|bytes|optional|secretstr|required)$/i;
/** A member access in code (`form.password.value`, `process.env.TOKEN`), not a value. */
const CODE_EXPRESSION = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
/** A plain word: in printed text, a word under a credential's name may be prose. */
const PLAIN_WORD = /^[A-Za-z_]+$/;
/** Argument fields that hold a command (read as a command; other text is read as printed text). */
const COMMAND_FIELD = /^(?:cmd|command|commands|script|shell|command_?line|args|argv)$/i;
/** Fields that hold headers or cookies, where a `[name, value]` pair is a header. */
const HEADER_LIST_FIELD = /headers?|cookies?/i;
/** `Bearer …`, `Basic …` and `Authorization: token …` anywhere else. */
const AUTH_SCHEME_VALUE =
  /\b([Bb]earer|Basic|(?<=[Aa]uthorization:\s*)token)(\s+)((?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}|(?<=[Bb]earer\s+)[A-Za-z]{16,}(?![A-Za-z0-9._~+/=-]))/g;
/** An `Authorization` header with a scheme: its value is a credential whatever it looks like. */
const AUTHORIZATION_HEADER =
  /(\b(?:proxy-)?authorization[ \t]*:[ \t]*(?:bearer|basic|token|digest)[ \t]+)([^\s'"`\\]+)/gi;
/** `Cookie: a=…; b=…` and `Set-Cookie: sid=…; Path=/`. */
const COOKIE_HEADER = /\b((?:set-)?cookie[ \t]*:[ \t]*)([^\r\n'"`\\]+)/gi;
/** `.netrc` entries: `machine host login name password value`, on one line or several. */
const NETRC_PASSWORD = /(\bmachine[ \t]+\S+(?:\s+login[ \t]+\S+)?\s+password[ \t]+)(\S+)/g;
/** `auth=("user", "password")`, as Python's requests takes it. */
const AUTH_TUPLE = /(\bauth[ \t]*=[ \t]*\(\s*(["'])[^"'\n]*\2\s*,\s*(["']))([^"'\n]+)(?=\3)/g;
/** A header written as a `[name, value]` pair inside a list in JSON text: `[["X-Api-Key", "…"]]`. */
const HEADER_TUPLE =
  /((?<=[[,][ \t]*)\[[ \t]*(\\?")([^"\\]{1,80})\2[ \t]*,[ \t]*\2)([^"\\]*)(?=\2[ \t]*\])/g;
/** `-p` that is a password: `sshpass -p …` and registry logins (`docker run -p` is a port). */
const LOGIN_PASSWORD_FLAG =
  /(\b(?:sshpass|(?:docker|podman|buildah|skopeo|nerdctl|oras|helm[ \t]+registry)[ \t]+login)\b[^\n|;&]*?[ \t]-p[ \t]*)(["']?)([^\s'"]+)/g;
/** `mysql -pvalue`: the password written against its flag. */
const MYSQL_PASSWORD_FLAG =
  /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]*?[ \t]-p)([^\s'"]+)/g;
/** `scheme://TOKEN@host`: a token given as a link's user name. */
const URL_TOKEN_USER = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@'"`<>]+)(?=@)/gi;
/** Credentials recognisable by their format alone, and private keys. */
const KNOWN_CREDENTIAL = new RegExp(
  [
    String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})`,
    String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`,
    String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
    String.raw`\bnpm_[A-Za-z0-9]{36}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
  ].join("|"),
  "g",
);
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
  return /^[$%{<*[\uE000]/.test(value) || /^\*+$/.test(value);
}

function hidesParam(name: string, value: string): boolean {
  if (isReference(value)) return false;
  return AMBIGUOUS_PARAM.test(name) ? credentialShaped(value) : true;
}

/**
 * Where a `name: value` or `name=value` sits: a whole `NAME=value` line (a
 * `.env` file, `env` output, a shell assignment), a whole `name: value`
 * config line, or neither.
 */
type NamedLine = "env" | "config" | null;

/**
 * Whether a `name: value` or `name=value` value is hidden. Any value that
 * looks like a credential is. Otherwise only a value under a password's name
 * (`password`, `DB_PASS`) or a credential's name (`X-Api-Key`, `GITHUB_TOKEN`,
 * `secret`), and not a constant (a number is a PIN under a password's name,
 * a count under another). Names that merely contain a credential word
 * (`max_tokens`, `author`, `monkey`, a bare `key` or `auth`) never are, so
 * `{"key": "Enter"}` stays readable.
 *
 * In a command such a value is hidden unless a bare `token`, `secret` or
 * `credentials` is followed by a colon and one plain lowercase word (`token:
 * 5`, `secret: sauce` read as prose). In printed text a plain word is hidden
 * only as a quoted literal, on a `NAME=value` line, or on a config line
 * under a name other than those bare words; a value with digits or symbols
 * is hidden anywhere. Code is never hidden: a type (`password: string`), a
 * member access (`form.password.value`), or a value a call or index follows
 * (`password = sha256(…)`).
 */
function hidesNamed(
  name: string,
  value: string,
  separator = "=",
  quote = "",
  context: CredentialContext = "command",
  line: NamedLine = null,
  call = false,
): boolean {
  if (!value || isReference(value)) return false;
  if (credentialShaped(value)) return true;
  const password = PASSWORD_NAME.test(name);
  if (!password && !SECRET_NAME_END.test(name)) return false;
  if ((password ? CONSTANT : PLAIN_SCALAR).test(value)) return false;
  // Code (also code a command writes: a heredoc, `python -c`) stays readable.
  if (!quote && (call || CODE_WORD.test(value) || CODE_EXPRESSION.test(value))) return false;
  if (context === "text") {
    if (quote || line === "env" || !PLAIN_WORD.test(value)) return true;
    return line === "config" && (password || !BARE_PROSE_NAME.test(name));
  }
  const prose =
    BARE_PROSE_NAME.test(name) && !/["'=]/.test(separator) && !quote && /^[a-z]+$/.test(value);
  return !prose;
}

/**
 * Where a NAMED_SECRET match at `offset` sits in `text` (see `NamedLine`):
 * what comes before it on its line, real or escaped (`\n` in JSON text), is
 * only indentation (and `export ` or a list's `- `).
 */
function namedLine(
  text: string,
  offset: number,
  length: number,
  name: string,
  separator: string,
  quote: string,
): NamedLine {
  const before = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
  const escaped = before.lastIndexOf("\\n");
  const lead = escaped < 0 ? before : before.slice(escaped + 2);
  if (
    separator === "=" &&
    /^[ \t]*(?:export[ \t]+)?$/.test(lead) &&
    /^[A-Z][A-Z0-9_]*$/.test(name)
  ) {
    return "env";
  }
  if (quote || !/^:[ \t]+$/.test(separator) || !/^[ \t]*(?:-[ \t]+)?$/.test(lead)) return null;
  const end = offset + length;
  const ends = [text.indexOf("\n", end), text.indexOf("\\n", end)].filter((at) => at >= 0);
  const rest = text.slice(end, ends.length ? Math.min(...ends) : text.length);
  return /^[ \t]*(?:#.*)?\r?$/.test(rest) ? "config" : null;
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
  const plain = text.includes("{{") ? text.replace(SECRET_REFERENCE, " ") : text;
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || !credentialShaped(value)) return;
    values.add(value);
    const decodedValue = decoded(value);
    if (decodedValue !== value && credentialShaped(decodedValue)) values.add(decodedValue);
  };
  for (const match of plain.matchAll(new RegExp(PARAM_SOURCE, "gi"))) {
    if (hidesParam(match[2]!, match[4]!)) add(match[4]);
  }
  for (const match of plain.matchAll(NAMED_SECRET)) add(match[5]);
  for (const match of plain.matchAll(FLAG_SECRET)) add(match[4]);
  for (const match of plain.matchAll(NAME_VALUE_PAIR)) {
    if (hidesField(match[3]!, match[4]!)) add(match[4]);
  }
  for (const match of plain.matchAll(AUTH_SCHEME_VALUE)) add(match[3]);
  for (const match of plain.matchAll(AUTHORIZATION_HEADER)) add(match[2]);
  for (const match of plain.matchAll(KNOWN_CREDENTIAL)) {
    if (!match[0].startsWith("-----")) add(match[0]);
  }
  for (const match of plain.matchAll(USER_PASSWORD_FLAG)) {
    if (hidesUserPassword(match[2]!)) add(match[2]);
  }
  for (const match of plain.matchAll(URL_USER_PASSWORD)) add(match[2]);
  for (const match of plain.matchAll(URL_TOKEN_USER)) add(match[2]);
  for (const match of plain.matchAll(WEBHOOK_PATH)) {
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
 * Hide every credential in `text`, whatever shape it takes, read as a command
 * (the default) or as printed text (see the module comment):
 * - a signed or token-bearing link loses its query or fragment, keeping the
 *   host and path so it is still recognisable;
 * - a signature, token or key parameter anywhere else (`GET /a.json?sig=…`,
 *   `\u0026token=…` in JSON, `#access_token=…`), a secret-named header, field or
 *   variable, a `Bearer` token, `curl -u` and link passwords, and the path of a
 *   webhook link keep their name and lose their value;
 * - a known token format, a private key, an `Authorization` or cookie header's
 *   value, a `.netrc` password and a token used as a link's user name are
 *   hidden; in a command, so are `sshpass -p`, registry login and `mysql -p`
 *   passwords;
 * - any of `values` (see `signedValues`, by default those found in `text`) is
 *   hidden wherever it occurs.
 * Ambiguous names (`code`, `key`, `policy`) are hidden only when their value
 * looks like a credential, so ordinary queries and prose stay readable. A
 * secret reference is never changed.
 */
export function redactSignedUrls(
  text: string,
  values: readonly string[] = signedValues(text),
  context: CredentialContext = "command",
): string {
  if (!text.includes("{{")) return redactText(text, values, context);
  const kept: string[] = [];
  const masked = text.replace(SECRET_REFERENCE, (reference) => {
    kept.push(reference);
    return `\uE000${kept.length - 1}\uE001`;
  });
  if (kept.length === 0) return redactText(text, values, context);
  return redactText(masked, values, context).replace(
    REFERENCE_MARK,
    (mark, index: string) => kept[Number(index)] ?? mark,
  );
}

function redactText(text: string, values: readonly string[], context: CredentialContext): string {
  const command = context === "command";
  let out = text;
  out = out.replace(KNOWN_CREDENTIAL, (match: string) =>
    match.startsWith("-----") || credentialShaped(match) ? SECRET_VALUE_PLACEHOLDER : match,
  );
  if (mayHoldCredential(out)) {
    out = out.replace(WEBHOOK_PATH, (_match, base: string) => `${base}${SECRET_VALUE_PLACEHOLDER}`);
    out = out.replace(GENERIC_HOOK_PATH, (match, base: string, path: string) =>
      hookSecret(path) ? `${base}${SECRET_VALUE_PLACEHOLDER}` : match,
    );
    out = out.replace(URL_USER_PASSWORD, (match, head: string, password: string) =>
      isReference(password) ? match : `${head}${SECRET_VALUE_PLACEHOLDER}`,
    );
    out = out.replace(URL_TOKEN_USER, (match, head: string, user: string) =>
      credentialShaped(user) ? `${head}${SECRET_VALUE_PLACEHOLDER}` : match,
    );
    if (out.includes("://")) out = out.replace(URL_PATTERN, redactLink);
    out = redactParams(out);
    out = out.replace(AUTHORIZATION_HEADER, (match, head: string, value: string) =>
      isReference(value) ? match : `${head}${SECRET_VALUE_PLACEHOLDER}`,
    );
    out = out.replace(COOKIE_HEADER, (_match, head: string, value: string) => {
      const first = /^set-/i.test(head);
      return `${head}${value.replace(
        /(^|;[ \t]*)([^=;\s]+=)([^;]*)/g,
        (pair, lead: string, name: string, cookie: string, at: number) =>
          (first && at > 0) || !cookie.trim() || isReference(cookie.trim())
            ? pair
            : `${lead}${name}${SECRET_VALUE_PLACEHOLDER}`,
      )}`;
    });
    out = out.replace(
      NAMED_SECRET,
      (
        match,
        name: string,
        equals: string,
        quote: string,
        scheme: string | undefined,
        value: string,
        offset: number,
        whole: string,
      ) =>
        hidesNamed(
          name,
          value,
          equals,
          quote,
          context,
          command ? null : namedLine(whole, offset, match.length, name, equals, quote),
          !quote &&
            /^[ \t]*[([]/.test(whole.slice(offset + match.length, offset + match.length + 2)),
        )
          ? `${name}${equals}${quote}${scheme ?? ""}${SECRET_VALUE_PLACEHOLDER}`
          : match,
    );
    out = out.replace(
      NAME_VALUE_PAIR,
      (match, head: string, _quote: string, name: string, value: string) =>
        hidesField(name, value) ? `${head}${hiddenField(value)}` : match,
    );
    out = out.replace(
      HEADER_TUPLE,
      (match, head: string, _quote: string, name: string, value: string) =>
        hidesField(name, value) ? `${head}${hiddenField(value)}` : match,
    );
    out = out.replace(USER_PASSWORD_FLAG, (match, head: string, password: string) =>
      hidesUserPassword(password) && (command || !PLAIN_WORD.test(password))
        ? `${head}${SECRET_VALUE_PLACEHOLDER}`
        : match,
    );
  }
  out = out.replace(NETRC_PASSWORD, (match, head: string, password: string) =>
    isReference(password) ? match : `${head}${SECRET_VALUE_PLACEHOLDER}`,
  );
  out = out.replace(AUTH_TUPLE, (match, head: string, _a: string, _b: string, password: string) =>
    isReference(password) ? match : `${head}${SECRET_VALUE_PLACEHOLDER}`,
  );
  if (command) {
    out = out.replace(LOGIN_PASSWORD_FLAG, (match, head: string, quote: string, password: string) =>
      isReference(password) ? match : `${head}${quote}${SECRET_VALUE_PLACEHOLDER}`,
    );
    out = out.replace(MYSQL_PASSWORD_FLAG, (match, head: string, password: string) =>
      isReference(password) ? match : `${head}${SECRET_VALUE_PLACEHOLDER}`,
    );
  }
  out = out.replace(
    FLAG_SECRET,
    (match, flag: string, separator: string, quote: string, value: string) =>
      hidesNamed(flag.trim(), value, separator, "", context)
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
 * A command field (`cmd`, `command`, `script`, `args`) is read as a command,
 * any other string (output, file contents, a patch) as printed text, and a
 * string holding a JSON object (a call's arguments) field by field.
 */
export function redactDeep<T>(value: T, values: readonly string[]): T {
  const map = (text: string, field: string | undefined, depth: number): string => {
    if (field !== undefined && hidesField(field, text)) return hiddenField(text);
    const json = depth < MAX_DEPTH ? jsonObject(text) : undefined;
    if (json !== undefined) {
      const redacted = mapStrings(json, depth + 1, undefined, map);
      return redacted === json ? text : JSON.stringify(redacted);
    }
    return redactSignedUrls(
      text,
      values,
      field !== undefined && COMMAND_FIELD.test(field) ? "command" : "text",
    );
  };
  return mapStrings(value, 0, undefined, map) as T;
}

/**
 * A tool call's arguments or output as a payload view shows them, with every
 * credential hidden field by field (see `redactDeep`), so code in a patch or
 * a file stays readable while a command's or a field's credential does not.
 */
export function redactPayload<T>(value: T): T {
  return redactDeep(value, signedValuesDeep(value));
}

/** The object or array a string holds as JSON text, if it holds one. */
function jsonObject(text: string): object | undefined {
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Under a headers or cookies field, a `[name, value]` pair is a header, so
 * its value goes by the header's name (`[["X-Api-Key", "…"]]`).
 */
function headerPair(value: readonly unknown[], field: string | undefined): string | undefined {
  return field !== undefined &&
    HEADER_LIST_FIELD.test(field) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    value[0].length <= 80
    ? value[0]
    : undefined;
}

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
    const header = headerPair(value, field);
    value.forEach((entry, index) =>
      walkStrings(entry, depth + 1, header !== undefined && index === 1 ? header : field, visit),
    );
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
  map: (text: string, field: string | undefined, depth: number) => string,
): unknown {
  if (typeof value === "string") return map(value, field, depth);
  if (typeof value === "number") {
    // A number is a credential only under a password-like name (a PIN).
    const mapped = field === undefined ? null : map(String(value), field, depth);
    return mapped !== null && mapped !== String(value) ? mapped : value;
  }
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const header = headerPair(value, field);
    let changed = false;
    const next = value.map((entry, index) => {
      const name = header !== undefined && index === 1 ? header : field;
      const mapped = mapStrings(entry, depth + 1, name, map);
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
