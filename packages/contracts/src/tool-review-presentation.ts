import { decodeHTML, decodeHTMLAttribute } from "entities/decode";
import type {
  ToolActionReview,
  ToolReviewContext,
  ToolReviewDetailsPage,
} from "./tool-action-review";

const protectedName =
  /password|passwd|passphrase|secret|credential|authorization|cookie|(^|[_-])token($|[_-])|api[_-]?key|accessToken|refreshToken|privateKey/i;
const protectedReviewField = (key: string, fields: readonly string[] = []) =>
  protectedName.test(key) || fields.includes(key) || fields.includes("*");

const SECRET_LAST_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "token",
  "otp",
  "totp",
  "dsn",
  "authorization",
]);
// "code" alone is a sign-in code; "errorCode" or "countryCode" are not.
const SECRET_CODE_KINDS = new Set([
  "user",
  "auth",
  "authorization",
  "oauth",
  "verification",
  "setup",
  "recovery",
  "device",
  "otp",
]);
const SECRET_KEY_KINDS = new Set([
  "api",
  "private",
  "access",
  "secret",
  "signing",
  "encryption",
  "master",
  "license",
]);
// Flags and checks about a secret ("hasWebhookSecret", "expectedCredential…")
// say whether one exists, never what it is.
const SECRET_FLAG_FIRST_WORDS = new Set(["has", "is", "awaiting", "can", "needs", "expected"]);
// Facts about a secret ("credentialVersion", "secretName", "apiKeyPrefix")
// describe it without being it.
const SECRET_METADATA_LAST_WORDS = new Set([
  "version",
  "versions",
  "id",
  "ids",
  "count",
  "at",
  "name",
  "names",
  "label",
  "kind",
  "type",
  "status",
  "mode",
  "source",
  "ref",
  "refs",
  "reference",
  "references",
  "configured",
  "present",
  "set",
  "enabled",
  "required",
  "length",
  "prefix",
  "hint",
  "fingerprint",
  "scope",
  "scopes",
  "provider",
  "expiry",
  "expires",
  "suffix",
  "url",
  "uri",
  "epoch",
]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\s-]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

/**
 * Whether a field with this name carries a key, password, token, code or
 * other secret, judged by its last word: "apiKey", "clientSecret", "code",
 * "userCode" and "masterPassword" do; "credentialVersion", "credentialId",
 * "errorCode", "hasWebhookSecret" and "nextPageToken" don't. The app-action catalog
 * generator marks actions by it and an app action's card hides by it.
 */
export function secretFieldName(name: string): boolean {
  const words = nameWords(name);
  const last = words.at(-1);
  const before = words.at(-2);
  if (!last || SECRET_FLAG_FIRST_WORDS.has(words[0]!)) return false;
  if (last === "token" && before === "page") return false;
  if (SECRET_LAST_WORDS.has(last)) return true;
  if (last === "code") return before === undefined || SECRET_CODE_KINDS.has(before);
  if (last === "key" && before !== undefined && SECRET_KEY_KINDS.has(before)) return true;
  // A secret word earlier in the name ("secretValue", "privateKeyPem",
  // "passwordHash"), unless the name only describes the secret.
  return protectedName.test(name) && !SECRET_METADATA_LAST_WORDS.has(last);
}

// Hosts whose webhook URLs carry their secret in the path
// ("https://hooks.slack.com/services/T…/B…/<secret>"), including ones whose
// secret is too short to look random.
const SECRET_PATH_HOSTS =
  /^(hooks\.slack\.com|(\w+\.)?discord(app)?\.com|[\w-]+\.webhook\.office\.com|outlook\.office\.com|chat\.googleapis\.com|hooks\.zapier\.com)$/i;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
// "Server=db;User Id=app;Password=…" and similar key=value connection strings.
const CONNECTION_STRING_SECRET =
  /((?:^|;)\s*(?:password|pwd|user ?password|account ?key|shared ?access ?key|shared ?access ?signature|access ?key|secret|token|sig)\s*=)[^;]*/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// Bare tokens with a well-known shape: OpenAI/Anthropic and Stripe keys,
// GitHub tokens, Slack tokens, AWS access key IDs and JWTs.
const TOKEN_SHAPES =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

/**
 * Whether one URL path segment looks like a random secret rather than a
 * readable name: a long run of letters and digits mixed, or a long opaque
 * token. Slugs ("getting-started") and dates stay readable.
 */
function secretLookingPathSegment(segment: string): boolean {
  if (/^[A-Za-z0-9_-]{32,}$/.test(segment)) return true;
  return segment
    .split(/[-_.~]/)
    .some((chunk) => chunk.length >= 12 && /\d/.test(chunk) && /[A-Za-z]/.test(chunk));
}

/**
 * One URL with its sign-in parts and query removed, and its path too for
 * webhook hosts that keep the secret there:
 * "postgres://app:pw@db:5432/x" → "postgres://db:5432/x",
 * "https://hooks.example.com/in?token=…" → "https://hooks.example.com/in",
 * "https://hooks.slack.com/services/…" → "https://hooks.slack.com/…",
 * and any random-looking path segment hidden:
 * "https://example.com/hooks/a1b2c3d4e5f6g7h8" → "https://example.com/hooks/…".
 */
function withoutUrlSecret(url: string): string {
  const scheme = url.slice(0, url.indexOf("://") + 3);
  const rest = url.slice(scheme.length).split(/[?#]/, 1)[0]!;
  // The last "@" ends the sign-in part even when an unencoded password holds
  // a "/"; a path with an "@" in it only loses its start.
  const address = rest.slice(rest.lastIndexOf("@") + 1);
  const host = address.split("/", 1)[0]!;
  const hostname = host.replace(/:\d+$/, "");
  if (SECRET_PATH_HOSTS.test(hostname) && address.length > host.length + 1) {
    return `${scheme}${host}/…`;
  }
  const path = address
    .slice(host.length)
    .split("/")
    .map((segment) => (secretLookingPathSegment(segment) ? "…" : segment))
    .join("/");
  return `${scheme}${host}${path}`;
}

/**
 * Text with the secrets it may carry removed: the sign-in parts, query and
 * webhook paths of every URL in it, password-like parts of a connection
 * string, bearer or basic credentials, and bare tokens of a well-known shape.
 */
function withoutTextSecrets(text: string): string {
  return text
    .replace(URL_IN_TEXT, withoutUrlSecret)
    .replace(CONNECTION_STRING_SECRET, "$1[Protected value]")
    .replace(AUTHORIZATION_VALUE, "$1 [Protected value]")
    .replace(TOKEN_SHAPES, "[Protected value]");
}
const bound = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;
export function toolReviewFieldLabel(key: string): string {
  const label = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\bids?\b/gi, (word) => (word.length === 3 ? "IDs" : "ID"))
    .replace(
      /\b(api|url|uri|http|https|ip|sql|json|html)(s?)\b/gi,
      (_word, name: string, plural: string) => `${name.toUpperCase()}${plural}`,
    )
    // Sentence case, keeping acronyms: "Working Directory" → "Working directory".
    .replace(
      /(?<=\S\s+)([A-Z])([a-z]+)\b/g,
      (_word, first: string, rest: string) => `${first.toLowerCase()}${rest}`,
    )
    .trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}
export function decodeReviewArguments(value: unknown): Record<string, unknown> | null {
  // Historical SDK entries sometimes wrapped arguments in JSON. Decode only once.
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : null;
}
export function safeReviewValue(
  value: unknown,
  key = "",
  protectedFields: readonly string[] = [],
  depth = 0,
): unknown {
  if (protectedReviewField(key, protectedFields)) return "[Protected value]";
  if (depth > 20) return "[Nested value; open this field for details]";
  if (Array.isArray(value))
    return value.map((entry) => safeReviewValue(entry, "", protectedFields, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        safeReviewValue(entry, name, protectedFields, depth + 1),
      ]),
    );
  return value;
}
function valueText(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === null
      ? "None"
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : (JSON.stringify(value) ?? "Unavailable");
}
const pointer = (name: string) => `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
// Long arbitrary property names remain readable without placing them in every
// preview or URL. An indexed segment opens their saved name and value together.
const fieldPointer = (key: string, index: number, parent = "") =>
  pointer(key).length > 256 || parent.length + pointer(key).length > 1024
    ? `/~2${index}`
    : pointer(key);

export function toolReviewFields(
  argumentsValue: unknown,
  context?: ToolReviewContext,
  toolName?: string,
): { fields: ToolActionReview["fields"]; moreFields: number } {
  // An app action's card says what it does in one plain line (its
  // consequence); its raw arguments (action id, path, body) stay in Details.
  if (toolName === APP_ACTION_REVIEW_TOOL) return { fields: [], moreFields: 0 };
  const args = decodeReviewArguments(argumentsValue);
  if (!args) return { fields: [], moreFields: 0 };
  const entries = Object.entries(args);
  if (context?.email) {
    const email = toolReviewFields(context.email);
    const original = toolReviewFields(args, { ...context, email: undefined });
    const fields = [
      ...email.fields
        .filter(
          (field) =>
            field.path !== "/contentSha256" && field.path !== "/htmlBody" && field.preview !== "",
        )
        .map((field) => ({
          ...field,
          label: field.path === "/textBody" ? "Message" : field.label,
          path: `/$email${field.path}`,
          ...(field.path === "/attachments"
            ? {
                preview: context
                  .email!.attachments.map((attachment) => attachment.name)
                  .join(", ")
                  .slice(0, 240),
              }
            : {}),
        })),
      ...original.fields.filter(
        (field) =>
          ![
            "/raw",
            "/expectedContentSha256",
            "/from",
            "/to",
            "/cc",
            "/bcc",
            "/subject",
            "/body",
            "/textBody",
            "/htmlBody",
            "/attachments",
          ].includes(field.path),
      ),
    ];
    return {
      fields: fields.slice(0, 16),
      moreFields: original.moreFields + Math.max(0, fields.length - 16),
    };
  }
  const api = apiEnvelopeReviewFields(args, context);
  if (api) return api;
  return {
    moreFields: Math.max(0, entries.length - 16),
    fields: entries.slice(0, 16).map(([key, value], index) => {
      const hidden = protectedReviewField(key, context?.protectedFields);
      const safe = hidden ? "[Protected value]" : value;
      const count = !hidden && Array.isArray(value) ? value.length : undefined;
      const compactList =
        !hidden &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 4 &&
        value.every(
          (entry) =>
            typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
        )
          ? value.map(valueText).join(", ")
          : undefined;
      const text =
        compactList !== undefined
          ? compactList
          : count !== undefined
            ? `${count.toLocaleString("en-US")} item${count === 1 ? "" : "s"}`
            : safe && typeof safe === "object"
              ? `${Object.keys(safe).length} field${Object.keys(safe).length === 1 ? "" : "s"}`
              : valueText(safe);
      return {
        path: fieldPointer(key, index),
        label: bound(
          (context?.fieldLabels && Object.hasOwn(context.fieldLabels, key)
            ? context.fieldLabels[key]
            : undefined) ?? toolReviewFieldLabel(key),
          256,
        ),
        preview: bound(text, 240),
        ...(count !== undefined ? { count } : {}),
        truncated:
          !hidden &&
          (text.length > 240 ||
            (compactList === undefined && typeof value === "object" && value !== null)),
        ...(hidden ? { protected: true } : {}),
      };
    }),
  };
}

/** The tool that runs an app action as the person (see @opengeni/contracts/app-actions). */
const APP_ACTION_REVIEW_TOOL = "admin_action_call";

/* ---- API integration requests ------------------------------------------- */

// An API integration tool's arguments are its HTTP request: `path`, `query`,
// `header` and `cookie` parameters plus a `body`. That envelope is transport.
// A person approving "Save a draft email" wants the recipients, subject and
// text, so the card lifts the request's own fields and reads common shapes
// (recipients, rich text, date and time, named places) as one plain value.
// The exact structure stays one click away in Details.
const API_ENVELOPE_KEYS = new Set(["path", "query", "header", "cookie", "body", "contentType"]);
// In the order a person checks them: who, what, when, where, the text, then
// the rest of the addressing.
const API_LEADING_LABELS: Readonly<Record<string, string>> = {
  toRecipients: "To",
  subject: "Subject",
  start: "Starts",
  end: "Ends",
  location: "Location",
  body: "Message",
  comment: "Message",
  ccRecipients: "Cc",
  bccRecipients: "Bcc",
  from: "From",
  replyTo: "Reply to",
  attendees: "Attendees",
};
const API_FIELD_ORDER = Object.keys(API_LEADING_LABELS);
/** Longer than other previews: the text of a message is what a person checks. */
const API_TEXT_PREVIEW = 1000;

type ApiEntry = { key: string; value: unknown; path: string; parameter: boolean };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function apiEnvelopeEntries(args: Record<string, unknown>): ApiEntry[] | null {
  const keys = Object.keys(args);
  if (keys.length === 0 || !keys.every((key) => API_ENVELOPE_KEYS.has(key))) return null;
  if (!keys.some((key) => key === "path" || key === "query" || key === "body")) return null;
  for (const key of ["path", "query", "header", "cookie"])
    if (args[key] !== undefined && !plainObject(args[key])) return null;
  const children = (parent: string, parameter: boolean): ApiEntry[] =>
    plainObject(args[parent])
      ? Object.entries(args[parent]).map(([key, value]) => ({
          key,
          value,
          path: `${pointer(parent)}${pointer(key)}`,
          parameter,
        }))
      : [];
  // A message wrapped in the body ({ message: {...}, comment }) reads as the message itself.
  const body: ApiEntry[] = plainObject(args.body)
    ? children("body", false).flatMap((entry) =>
        entry.key === "message" && plainObject(entry.value)
          ? Object.entries(entry.value).map(([key, value]) => ({
              key,
              value,
              path: `${entry.path}${pointer(key)}`,
              parameter: false,
            }))
          : [entry],
      )
    : args.body === undefined
      ? []
      : [{ key: "content", value: args.body, path: "/body", parameter: false }];
  const entries = [
    ...body,
    ...children("path", true),
    ...children("query", true),
    ...children("header", true),
    ...children("cookie", true),
    ...(args.contentType === undefined
      ? []
      : [{ key: "contentType", value: args.contentType, path: "/contentType", parameter: true }]),
  ];
  return entries.every((entry) => entry.path.length <= 1024) ? entries : null;
}

/** Longest list of link targets a message preview shows before pointing to Details. */
const API_LINKS_PREVIEW = 4000;
// Placeholders for line breaks while text is collected, so that the breaks of
// nested and adjacent blocks merge the way a browser lays them out.
const LINE_BREAK = "\u0000";
const BLOCK_BREAK = "\u0001";
const PARAGRAPH_BREAK = "\u0002";
const BREAK_RUN = /[ \u0000-\u0002]*[\u0000-\u0002][ \u0000-\u0002]*/g;
// Characters that change nothing a person reads.
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

// HTML read the way a browser tokenizes it, closely enough for a review card:
// quoted values may hold ">" or "<!--", an unquoted value may hold a stray
// quote, and "a < b" stays text. Names and unquoted values stop at "<", and
// each name or value is matched whole, so a broken tag fails fast.
const HTML_NAME = `[^\\s"'>/=<]+(?![^\\s"'>/=<])`;
const HTML_VALUE = `(?:"[^"]*"|'[^']*'|[^\\s><]*(?![^\\s><]))`;
const HTML_TAG = new RegExp(
  `<(/?)([a-z][^\\s/>]*)((?:\\s|/|${HTML_NAME}(?:\\s*=\\s*${HTML_VALUE})?)*)>`,
  "iy",
);
// Comments end at "-->", "--!>", or at once for "<!-->" and "<!--->".
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:--!?>|$))/y;
// Doctypes, processing instructions and "</ >" are skipped like comments.
const HTML_BOGUS = /<(?:!|\?|\/(?![a-z]))[^>]*(?:>|$)/iy;
const HTML_ATTRIBUTE = new RegExp(`(${HTML_NAME})(?:\\s*=\\s*(${HTML_VALUE}))?`, "g");
// Their content is never shown; they end at the first literal closing tag.
const HTML_RAW_TEXT = /^(script|style|title)$/;
// Any link target or form destination anywhere in the raw HTML, for the
// fail-safe below.
const HTML_ANY_TARGET =
  /(?:^|[\s"'/<])(?:(?:xlink:)?href|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>][^\s>]*))/gi;
/** Enough HTML for the text a card previews; the full value stays in Details. */
const HTML_READ_LIMIT = 200_000;

/** The value of a tag's own `href` (or SVG `xlink:href`), not `data-href`. */
function hrefOf(attributes: string): string | undefined {
  for (const match of attributes.matchAll(HTML_ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (name !== "href" && name !== "xlink:href") continue;
    const value = match[2] ?? "";
    return /^["']/.test(value) ? value.slice(1, -1) : value;
  }
  return undefined;
}

/** A link target as the browser reads it, or undefined when it goes nowhere.
 * Decoded exactly as an attribute value, so the shown address is the real one. */
function linkTarget(raw: string): string | undefined {
  const target = decodeHTMLAttribute(raw)
    .trim()
    .replace(/^mailto:/i, "");
  return target && !target.startsWith("#") ? target : undefined;
}

/**
 * The text a person reads in an HTML message. A link whose target differs from
 * its text shows both, "our portal (https://pay.example.net)", because where a
 * link goes is what a person checks before sending. That holds for a link that
 * is never closed too: mail clients keep it a link to the end of its text.
 * Text and link targets are decoded exactly once, the way a browser decodes
 * them. The text is cut to a preview, and every link target or form
 * destination the shown preview doesn't show in full is listed first: one
 * after the cut, one in markup the reader misjudges, one past the read limit.
 * However long the message, a person never approves a link they can't see.
 */
function plainText(content: string, contentType: unknown): ApiReading {
  if (typeof contentType !== "string" || contentType.toLowerCase() !== "html")
    return { text: content };
  const html = content.slice(0, HTML_READ_LIMIT);
  const shownTargets = new Set<string>();
  // Text is collected raw and decoded per piece, so nothing decodes twice.
  const pieces: string[] = [];
  let out = "";
  let link: { target: string | undefined; continued: boolean } | undefined;
  const flush = () => {
    pieces.push(decodeHTML(out).replace(/[\u0000-\u0002]/g, ""));
    out = "";
  };
  // Everything collected since a link opened is its text.
  const closeLink = () => {
    if (!link) return;
    const { target, continued } = link;
    link = undefined;
    flush();
    const text = pieces.pop()!;
    const shown = text.trim();
    if (!target) return void pieces.push(text);
    shownTargets.add(target);
    if (shown === target) pieces.push(text);
    else if (shown) {
      // The target follows the words, before any space after them.
      const words = text.trimEnd();
      pieces.push(`${words} (${target})${text.slice(words.length)}`);
    } else pieces.push(continued ? text : `${text}${target} `);
  };
  const block = (separator: string) => {
    // A link still open across a paragraph keeps going in the next one.
    const open = link;
    closeLink();
    flush();
    pieces.push(separator);
    if (open) link = { target: open.target, continued: true };
  };
  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next < 0) break;
    out += html.slice(index, next);
    index = next;
    HTML_COMMENT.lastIndex = HTML_BOGUS.lastIndex = HTML_TAG.lastIndex = next;
    const comment = HTML_COMMENT.exec(html) ?? HTML_BOGUS.exec(html);
    if (comment) {
      index = next + comment[0].length;
      continue;
    }
    const tag = HTML_TAG.exec(html);
    if (!tag) {
      // Not a tag: a "<" in the text.
      out += "<";
      index = next + 1;
      continue;
    }
    index = next + tag[0].length;
    const [, closing, rawName = "", attributes = ""] = tag;
    const name = rawName.toLowerCase();
    if (!closing && HTML_RAW_TEXT.test(name)) {
      const end = new RegExp(`</${name}(?=[\\s/>])[^>]*>?`, "ig");
      end.lastIndex = index;
      const found = end.exec(html);
      index = found ? found.index + found[0].length : html.length;
    } else if (name === "a") {
      closeLink();
      const href = closing ? undefined : hrefOf(attributes);
      if (href !== undefined) {
        flush();
        link = { target: linkTarget(href), continued: false };
      }
    } else if (/^(p|h[1-6]|blockquote)$/.test(name)) block(PARAGRAPH_BREAK);
    else if (!closing && name === "br") block(LINE_BREAK);
    else if (/^(div|li|tr|ul|ol|table|section|article|header|footer)$/.test(name))
      block(BLOCK_BREAK);
  }
  out += html.slice(index);
  closeLink();
  flush();
  const text = pieces
    .join("")
    .replace(INVISIBLE, "")
    // Source line breaks and runs of spaces read as one space, as in a browser.
    .replace(/\s+/g, " ")
    // A paragraph leaves a blank line, a block or a line break one line;
    // several line breaks in a row keep their count, up to a blank line.
    .replace(BREAK_RUN, (run) => {
      const lines = run.includes(PARAGRAPH_BREAK)
        ? 2
        : Math.max(run.includes(BLOCK_BREAK) ? 1 : 0, run.split(LINE_BREAK).length - 1);
      return "\n".repeat(Math.min(2, lines));
    })
    .trim();
  const preview = bound(text, API_TEXT_PREVIEW);
  // Every target in the whole message, in order, including any the reader missed.
  const targets = new Set<string>();
  for (const match of content.matchAll(HTML_ANY_TARGET)) {
    const target = linkTarget(match[1] ?? match[2] ?? match[3] ?? "");
    if (target) targets.add(target);
  }
  for (const target of shownTargets) targets.add(target);
  const unseen = [...targets].filter((target) => !showsTarget(preview, target));
  let listed = "";
  let count = 0;
  for (const target of unseen) {
    const next = `${listed}${count ? ", " : ""}${bound(target, API_TEXT_PREVIEW)}`;
    if (count && next.length > API_LINKS_PREVIEW) break;
    listed = next;
    count += 1;
  }
  const more = unseen.length - count;
  const links = count
    ? `Links: ${listed}${more ? `, and ${more.toLocaleString("en-US")} more. Details lists every link.` : ""}\n\n`
    : "";
  return {
    text: `${links}${preview}`,
    fitted: true,
    truncated: preview !== text || more > 0,
    targets: [...targets],
  };
}

/** Whether a preview shows a whole link target, not just the start of a longer address. */
function showsTarget(preview: string, target: string): boolean {
  for (let at = preview.indexOf(target); at >= 0; at = preview.indexOf(target, at + 1)) {
    const before = preview[at - 1] ?? " ";
    const end = at + target.length;
    const after = preview[end] ?? " ";
    // "visit https://example.com." ends a sentence, not the address.
    const sentenceEnd = after === "." && /\s/.test(preview[end + 1] ?? " ");
    if (/[\s(]/.test(before) && (/[\s),]/.test(after) || sentenceEnd)) return true;
  }
  return false;
}

/** "Anna Berg <anna@example.com>" for a recipient-like value, else undefined. */
function recipientText(value: unknown): string | undefined {
  if (typeof value === "string") return value.includes("@") ? value : undefined;
  if (!plainObject(value)) return undefined;
  const inner = plainObject(value.emailAddress) ? value.emailAddress : value;
  const address = [inner.address, inner.email].find(
    (entry): entry is string => typeof entry === "string" && entry.includes("@"),
  );
  if (!address) return undefined;
  const name = [inner.name, inner.displayName].find(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );
  const text = name && name !== address ? `${name} <${address}>` : address;
  // A meeting attendee says when coming is optional.
  return typeof value.type === "string" && value.type.toLowerCase() === "optional"
    ? `${text} (optional)`
    : text;
}

/** "2026-10-28 10:00 (Europe/Oslo)": seconds only when they matter. */
function dateTimeText(dateTime: string, timeZone: unknown): string {
  const parsed =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      dateTime.trim(),
    );
  const text = parsed
    ? `${parsed[1]} ${parsed[2]}:${parsed[3]}${parsed[4] && parsed[4] !== "00" ? `:${parsed[4]}` : ""}${
        parsed[5] ? (parsed[5].toUpperCase() === "Z" ? " UTC" : ` ${parsed[5]}`) : ""
      }`
    : dateTime;
  const zone = typeof timeZone === "string" ? timeZone.trim() : "";
  // "23:30 UTC" already says its zone.
  return zone && !(text.endsWith(" UTC") && /^(utc|z|etc\/utc)$/i.test(zone))
    ? `${text} (${zone})`
    : text;
}

/** One plain reading of a structured value, or undefined to fall back to its size. */
function apiValueText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const recipients = value.map(recipientText);
    if (recipients.every((entry) => entry !== undefined)) return recipients.join(", ");
    // Attachments and other named items read as their names.
    const names = value.map((item) =>
      plainObject(item) && typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : undefined,
    );
    return names.every((entry) => entry !== undefined) ? names.join(", ") : undefined;
  }
  if (!plainObject(value)) return undefined;
  const recipient = recipientText(value);
  if (recipient) return recipient;
  const keys = Object.keys(value);
  if (
    typeof value.dateTime === "string" &&
    keys.every((key) => ["dateTime", "timeZone"].includes(key))
  )
    return dateTimeText(value.dateTime, value.timeZone);
  if (typeof value.displayName === "string" && value.displayName.trim()) return value.displayName;
  return undefined;
}

/**
 * A plain reading of a value. A message's text comes already fitted to its
 * preview (`fitted`), because its link list must survive the cut.
 */
type ApiReading = {
  text: string;
  fitted?: boolean;
  truncated?: boolean;
  /** Every link target in an HTML message, in order. */
  targets?: string[];
};

/** A message body: its text and how it is written ({ content, contentType }). */
function messageContent(value: unknown): { content: string; contentType: unknown } | undefined {
  return plainObject(value) &&
    typeof value.content === "string" &&
    Object.keys(value).every((key) => ["content", "contentType"].includes(key))
    ? { content: value.content, contentType: value.contentType }
    : undefined;
}

function apiValueReading(value: unknown): ApiReading | undefined {
  const message = messageContent(value);
  if (message) return plainText(message.content, message.contentType);
  const text = apiValueText(value);
  return text === undefined ? undefined : { text };
}

function apiEnvelopeReviewFields(
  args: Record<string, unknown>,
  context: ToolReviewContext | undefined,
): { fields: ToolActionReview["fields"]; moreFields: number } | null {
  // Only an API integration's arguments are an HTTP request; another tool's
  // `body` or `query` argument means what that tool says it means.
  if (context?.kind !== "api" || context.protectedFields?.includes("*")) return null;
  const entries = apiEnvelopeEntries(args);
  if (!entries) return null;
  const rank = (entry: ApiEntry) => {
    const index = API_FIELD_ORDER.indexOf(entry.key);
    return entry.parameter
      ? API_FIELD_ORDER.length + 1
      : index < 0
        ? API_FIELD_ORDER.length
        : index;
  };
  // An empty list or object says nothing at a glance; Details still lists it.
  const empty = (value: unknown) =>
    (Array.isArray(value) && value.length === 0) ||
    (plainObject(value) && Object.keys(value).length === 0);
  const ordered = entries
    .filter((entry) => !empty(entry.value))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
  const used = new Set<string>();
  const fields = ordered.map((entry): ToolActionReview["fields"][number] => {
    const segments = entry.path.slice(1).split("/");
    const hidden = segments.some((segment) =>
      protectedReviewField(
        segment.replaceAll("~1", "/").replaceAll("~0", "~"),
        context?.protectedFields,
      ),
    );
    const leading =
      Object.hasOwn(API_LEADING_LABELS, entry.key) && !entry.parameter
        ? API_LEADING_LABELS[entry.key]
        : undefined;
    const label = leading && !used.has(leading) ? leading : toolReviewFieldLabel(entry.key);
    used.add(label);
    if (hidden)
      return {
        path: entry.path,
        label,
        preview: "[Protected value]",
        truncated: false,
        protected: true,
      };
    const { value } = entry;
    const structured = value !== null && typeof value === "object";
    const reading = structured ? apiValueReading(value) : undefined;
    const read = reading?.text;
    const count = Array.isArray(value) ? value.length : undefined;
    const compactList =
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 4 &&
      value.every((item) => ["string", "number", "boolean"].includes(typeof item))
        ? value.map(valueText).join(", ")
        : undefined;
    const text =
      read ??
      compactList ??
      (count !== undefined
        ? `${count.toLocaleString("en-US")} item${count === 1 ? "" : "s"}`
        : structured
          ? `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`
          : valueText(value));
    const limit = read !== undefined || typeof value === "string" ? API_TEXT_PREVIEW : 240;
    return {
      path: entry.path,
      label: bound(label, 256),
      preview: reading?.fitted ? text : bound(text, limit),
      ...(count !== undefined ? { count } : {}),
      // A plain reading is the value a person checks, shown as text; its exact
      // structure stays in Details. A bare size ("3 fields") opens it here.
      truncated: reading?.fitted
        ? reading.truncated === true
        : text.length > limit || (structured && read === undefined && compactList === undefined),
    };
  });
  return { fields: fields.slice(0, 16), moreFields: Math.max(0, fields.length - 16) };
}
// Bookkeeping and opaque identifiers say nothing a person can check.
const APP_ACTION_UNREADABLE_KEY =
  /^(id|operationId|idempotencyKey|expiresAt|expectedVersion|expectedRevision|expectedEtag)$|Ids?$/;

/** Request fields whose values are codes: the card says them in words. */
const APP_ACTION_CODED_FIELDS: Readonly<
  Record<string, { label: string; values: Readonly<Record<string, string>> }>
> = {
  fundingSource: {
    label: "Paid with",
    values: {
      opengeni_credits: "Opengeni credits",
      workspace_gateway: "The workspace's Vercel AI Gateway",
      supergrok_subscription: "A connected SuperGrok account",
    },
  },
};

/**
 * One short readable line of an app action's key values, for example
 * "Email: anna@example.com · Role: admin", taken from its body and query.
 * Values are shown as labelled data, never as the question itself. Secrets
 * (by field name), and the secrets text can carry (URL sign-in parts, queries
 * and webhook paths, connection string passwords, bearer credentials), are
 * never shown.
 */
export function appActionReviewSummary(argumentsValue: unknown): string | undefined {
  const args = decodeReviewArguments(argumentsValue);
  if (!args) return undefined;
  const parts: string[] = [];
  const visit = (key: string, value: unknown, depth: number) => {
    if (parts.length >= 4 || APP_ACTION_UNREADABLE_KEY.test(key)) return;
    if (secretFieldName(key)) {
      parts.push(`${toolReviewFieldLabel(key)}: [Protected value]`);
      return;
    }
    const coded = Object.hasOwn(APP_ACTION_CODED_FIELDS, key)
      ? APP_ACTION_CODED_FIELDS[key]!
      : undefined;
    if (coded && typeof value === "string" && Object.hasOwn(coded.values, value)) {
      parts.push(`${coded.label}: ${coded.values[value]}`);
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (depth < 2)
        for (const [name, entry] of Object.entries(value)) visit(name, entry, depth + 1);
      return;
    }
    const scalar = (entry: unknown) =>
      entry === null || ["string", "number", "boolean"].includes(typeof entry);
    const shown = (entry: unknown) =>
      valueText(typeof entry === "string" ? withoutTextSecrets(entry.trim()) : entry);
    const text = Array.isArray(value)
      ? value.length > 0 && value.length <= 4 && value.every(scalar)
        ? value.map(shown).join(", ")
        : ""
      : scalar(value)
        ? shown(value)
        : "";
    const line = text.replace(/\s+/g, " ").trim();
    if (line) parts.push(`${toolReviewFieldLabel(key)}: ${bound(line, 80)}`);
  };
  for (const source of [args.body, args.query]) {
    if (source && typeof source === "object" && !Array.isArray(source))
      for (const [name, entry] of Object.entries(source)) visit(name, entry, 0);
  }
  return parts.length > 0 ? bound(parts.join(" · "), 240) : undefined;
}

/** Deterministic consequences from the reviewed bytes. Unknown fields remain visible. */
export function toolReviewAction(
  toolName: string,
  argumentsValue: unknown,
  context?: ToolReviewContext,
): Pick<
  ToolActionReview,
  "title" | "approveLabel" | "effects" | "consequence" | "selectionCount" | "selectionKind"
> {
  const fallback = {
    title:
      context?.title ??
      bound(
        toolReviewFieldLabel(
          toolName.replace(/^mcp_[^_]+__/, "").replace(/^batch[_-](?=[a-z])/i, ""),
        ),
        256,
      ),
    // An app action's card asks the person a plain question ("Invite … to
    // your organization?"), so its button answers it.
    approveLabel: toolName === APP_ACTION_REVIEW_TOOL ? "Allow" : "Approve action",
    effects: [] as string[],
  };
  if (toolName === APP_ACTION_REVIEW_TOOL) {
    const consequence = appActionReviewSummary(argumentsValue);
    return consequence ? { ...fallback, consequence } : fallback;
  }
  if (context?.kind !== "gmail") return fallback;
  const args = decodeReviewArguments(argumentsValue);
  if (!args) return fallback;
  const thread = toolName.endsWith("_thread");
  const selectionKind = thread ? ("threads" as const) : ("messages" as const);
  const ids =
    thread && typeof args.threadId === "string"
      ? [args.threadId]
      : Array.isArray(args.messageIds)
        ? args.messageIds
        : typeof args.messageId === "string"
          ? [args.messageId]
          : null;
  const selectionCount = ids?.every((id) => typeof id === "string") ? new Set(ids).size : undefined;
  const noun =
    selectionCount === undefined
      ? thread
        ? "conversations"
        : "messages"
      : `${selectionCount.toLocaleString("en-US")} ${thread ? "conversation" : "message"}${selectionCount === 1 ? "" : "s"}`;
  const addValues = toolName.startsWith("label_") ? args.labelIds : args.addLabelIds;
  const adds = Array.isArray(addValues)
    ? addValues.filter((v): v is string => typeof v === "string")
    : [];
  const removeValues = toolName.startsWith("unlabel_") ? args.labelIds : args.removeLabelIds;
  const removes = Array.isArray(removeValues)
    ? removeValues.filter((v): v is string => typeof v === "string")
    : [];
  const labelEffect = (label: string, adding: boolean): string => {
    const known: Record<string, [string, string]> = {
      TRASH: ["Move to Trash", "Remove from Trash"],
      INBOX: ["Move to Inbox", "Remove from Inbox"],
      UNREAD: ["Mark as unread", "Mark as read"],
      STARRED: ["Add star", "Remove star"],
      SPAM: ["Mark as spam", "Remove from Spam"],
      IMPORTANT: ["Mark as important", "Remove importance"],
    };
    return (
      (Object.hasOwn(known, label) ? known[label]?.[adding ? 0 : 1] : undefined) ??
      `${adding ? "Add" : "Remove"} label ${bound(label, 120)}`
    );
  };
  const effects = [
    ...adds.map((id) => labelEffect(id, true)),
    ...removes.map((id) => labelEffect(id, false)),
  ];
  if (
    [
      "batch_modify_messages",
      "modify_message",
      "modify_thread",
      "label_message",
      "label_thread",
      "unlabel_message",
      "unlabel_thread",
    ].includes(toolName)
  ) {
    const trash = adds.includes("TRASH");
    return {
      title: trash ? `Move ${noun} to Trash` : `Update ${noun}`,
      approveLabel: trash ? "Move to Trash" : "Apply changes",
      effects,
      ...(selectionCount === undefined ? {} : { selectionCount, selectionKind }),
      ...(trash
        ? { consequence: "Messages stay recoverable in Trash until Gmail deletes them." }
        : thread
          ? { consequence: "Applies to every message in the conversation." }
          : {}),
    };
  }
  if (["trash_message", "restore_message", "trash_thread", "restore_thread"].includes(toolName))
    return {
      title: toolName.startsWith("trash_") ? `Move ${noun} to Trash` : `Remove ${noun} from Trash`,
      approveLabel: toolName.startsWith("trash_") ? "Move to Trash" : "Remove from Trash",
      effects,
      ...(selectionCount === undefined ? {} : { selectionCount, selectionKind }),
    };
  const named: Record<string, [string, string]> = {
    send_message: ["Send email", "Send email"],
    send_draft: ["Send draft", "Send draft"],
    create_draft: ["Create email draft", "Create draft"],
    update_draft: ["Update email draft", "Update draft"],
    delete_draft: ["Delete email draft", "Delete draft"],
    create_label: ["Create label", "Create label"],
    update_label: ["Update label", "Update label"],
    delete_label: ["Delete label", "Delete label"],
  };
  const action = Object.hasOwn(named, toolName) ? named[toolName] : undefined;
  return action ? { title: action[0], approveLabel: action[1], effects } : fallback;
}

/** A bounded slice of the immutable saved arguments; never evaluates a fresh provider query. */
export function toolReviewDetails(
  argumentsValue: unknown,
  context: ToolReviewContext | undefined,
  path: string,
  offset: number,
  limit = 25,
): Omit<ToolReviewDetailsPage, "id" | "actionDigest" | "version"> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Invalid review page");
  const args = decodeReviewArguments(argumentsValue);
  let value: unknown = context?.email ? { ...args, $email: context.email } : args;
  if (path !== "") {
    if (!path.startsWith("/")) throw new Error("Invalid review field");
    for (const escaped of path.slice(1).split("/")) {
      if (/^~2\d+$/.test(escaped)) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Review field not found");
        const selected = Object.entries(value)[Number(escaped.slice(2))];
        if (!selected) throw new Error("Review field not found");
        value = {
          fieldName: selected[0],
          value: protectedReviewField(selected[0], context?.protectedFields)
            ? "[Protected value]"
            : selected[1],
        };
        continue;
      }
      const key = escaped.replaceAll("~1", "/").replaceAll("~0", "~");
      if (protectedReviewField(key, context?.protectedFields)) {
        value = "[Protected value]";
        break;
      }
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
        throw new Error("Review field not found");
      value = (value as Record<string, unknown>)[key];
    }
  }
  type DetailItem = ToolReviewDetailsPage["items"][number];
  const preview = (
    entry: unknown,
    key: string,
    childPath: string,
  ): Pick<DetailItem, "value" | "truncated" | "path"> => {
    const hidden = protectedReviewField(key, context?.protectedFields);
    if (!hidden && entry !== null && typeof entry === "object") {
      const count = Array.isArray(entry) ? entry.length : Object.keys(entry).length;
      return {
        value: `${count.toLocaleString("en-US")} ${Array.isArray(entry) ? (count === 1 ? "item" : "items") : count === 1 ? "field" : "fields"}`,
        path: childPath,
        truncated: true,
      };
    }
    const text = valueText(safeReviewValue(entry, key, context?.protectedFields));
    return {
      value: bound(text, 4000),
      ...(hidden ? {} : { path: childPath }),
      truncated: !hidden && text.length > 4000,
    };
  };
  // Selected messages read as subject and sender rather than bare provider ids.
  const labels =
    (path === "/messageIds" || path === "/messageId") && context?.selectionLabels?.length
      ? new Map(context.selectionLabels.map((label) => [label.id, label]))
      : undefined;
  const labelled = (entry: unknown): Pick<DetailItem, "value" | "detail"> | undefined => {
    const label = typeof entry === "string" ? labels?.get(entry) : undefined;
    return label && typeof entry === "string"
      ? {
          value: label.title,
          detail: label.subtitle ? `${label.subtitle} · ${entry}` : entry,
        }
      : undefined;
  };
  let total: number;
  let items: DetailItem[];
  if (Array.isArray(value)) {
    total = value.length;
    items = value.slice(offset, offset + limit).map((entry, index) => ({
      label: `${offset + index + 1}`,
      ...preview(entry, "", `${path}/${offset + index}`),
      ...labelled(entry),
    }));
  } else if (offset === 0 && labelled(value)) {
    total = 1;
    items = [{ label: "Message", ...labelled(value)! }];
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    // A message's Details lead with every link target it holds, so the card's
    // "Details lists every link" is true however many there are.
    const message = messageContent(value);
    const links = message ? (plainText(message.content, message.contentType).targets ?? []) : [];
    total = links.length + entries.length;
    const linkItems = links.slice(offset, offset + limit).map((target, index) => ({
      label: `Link ${offset + index + 1}`,
      value: bound(target, 4000),
    }));
    const start = Math.max(0, offset - links.length);
    const fieldItems = entries
      .slice(start, start + limit - linkItems.length)
      .map(([key, entry], position) => ({
        label: bound(
          (context?.fieldLabels && Object.hasOwn(context.fieldLabels, key)
            ? context.fieldLabels[key]
            : undefined) ?? toolReviewFieldLabel(key),
          256,
        ),
        ...preview(entry, key, `${path}${fieldPointer(key, start + position, path)}`),
      }));
    items = [...linkItems, ...fieldItems];
  } else {
    const text = valueText(value);
    total = Math.max(1, Math.ceil(text.length / 4000));
    items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({
      label: `Part ${offset + index + 1}`,
      value: text.slice((offset + index) * 4000, (offset + index + 1) * 4000),
    }));
  }
  return { path, items, total, nextOffset: offset + limit < total ? offset + limit : null };
}
