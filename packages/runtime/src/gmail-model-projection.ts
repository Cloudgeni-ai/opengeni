import type { AttemptToolResult as AttemptToolResultValue } from "@opengeni/contracts";
import { modelToolTextBudgetBytes } from "./tool-result-spill";

type JsonRecord = Record<string, unknown>;

/**
 * Per-message body bounds of a multi-message result. Bodies share whatever the
 * model's tool-output text budget leaves after the cards' other fields, filled
 * evenly (short bodies give their unused share to long ones): a short thread
 * gets up to `MAX` characters per message, a full 50-message page about 400
 * to 500 at the default budget. `MIN` is a floor kept even when that overruns
 * the budget, so a very large page degrades to the generic truncation rather
 * than to empty cards.
 */
export const GMAIL_MODEL_BODY_MAX_CHARS = 4_000;
export const GMAIL_MODEL_BODY_MIN_CHARS = 200;

const MULTI_MESSAGE_TOOLS = new Set([
  "search_messages",
  "search_threads",
  "get_thread",
  "list_drafts",
]);

/**
 * The model-visible copy of a Gmail bridge result.
 *
 * Codemode and the spill file keep the exact result (see
 * `projectAttemptToolResultForCaller`); this projection runs only for a model
 * caller executing a new call, never when replaying stored results.
 *
 * Multi-message reads (`search_messages`, `search_threads`, `get_thread`,
 * `list_drafts`) become triage cards: ids, sender, a Reply-To that differs
 * from the sender, recipients, date, subject,
 * labels, attachment names and the start of the body. The raw root header
 * array, MIME part list, HTML body, attachment tokens, size and history fields
 * are dropped. The body is the plain-text part, or text extracted from the
 * HTML part when there is none (`bodyFromHtml: true`), with whitespace and
 * invisible padding collapsed. Bodies are cut so the whole card list fits
 * `budget.maxTextBytes` (the model's tool-output text budget, so the generic
 * middle truncation never drops whole messages); `contentTruncated` is true
 * when a body was cut here or by the bridge. Gmail's snippet is kept only
 * when there is no plain-text body (it is the start of that same body).
 * `readWith: "get_message"` names the complete single-message read.
 *
 * `get_message` stays complete (root headers, MIME parts, the full bounded
 * plain-text body), except that the HTML body is dropped when a plain-text
 * body exists (`htmlBodyOmitted: true`). A message with only HTML keeps it
 * while the result fits the budget; a larger one carries the HTML's readable
 * text instead (`bodyFromHtml: true`, `htmlBodyOmitted: true`).
 *
 * Error results, results without the expected structured shape, and every
 * other tool are returned unchanged.
 */
export function projectGmailToolResultForModel(
  toolName: string,
  result: AttemptToolResultValue,
  budget: { readonly maxTextBytes: number } = { maxTextBytes: modelToolTextBudgetBytes() },
): AttemptToolResultValue {
  if (result.isError === true || !isRecord(result.structuredContent)) return result;
  if (result.content.length !== 1 || result.content[0]?.type !== "text") return result;
  const value = result.structuredContent;
  const projected = MULTI_MESSAGE_TOOLS.has(toolName)
    ? compactMultiMessageResult(toolName, value, budget.maxTextBytes)
    : toolName === "get_message"
      ? compactSingleMessage(value, budget.maxTextBytes)
      : null;
  if (!projected) return result;
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify(projected) }],
    // Built only from values of the parsed structured result, so still JSON.
    structuredContent: projected as NonNullable<AttemptToolResultValue["structuredContent"]>,
  };
}

/** One card plus the full normalized body it may carry (null: no body fields). */
type DraftCard = {
  card: JsonRecord;
  body: string | null;
  bridgeTruncated: boolean;
};

function compactMultiMessageResult(
  toolName: string,
  value: JsonRecord,
  maxTextBytes: number,
): JsonRecord | null {
  const listKey =
    toolName === "search_threads" ? "threads" : toolName === "list_drafts" ? "drafts" : "messages";
  const list = value[listKey];
  if (!Array.isArray(list) || !list.every(isRecord)) return null;
  const drafts: DraftCard[] = [];
  const draft = (message: JsonRecord): JsonRecord => {
    const next = draftCard(message);
    drafts.push(next);
    return next.card;
  };
  const projectedList =
    toolName === "search_threads"
      ? list.map((thread) =>
          Array.isArray(thread.messages)
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  isRecord(message) ? draft(message) : message,
                ),
              }
            : thread,
        )
      : list.map(draft);
  const withBodies = drafts.filter((entry) => entry.body !== null);
  const projected: JsonRecord = {
    ...value,
    [listKey]: projectedList,
    ...(withBodies.length > 0 ? { readWith: "get_message" } : {}),
  };
  if (withBodies.length > 0) allocateBodies(projected, withBodies, maxTextBytes);
  return projected;
}

/**
 * Give every body an even share of the bytes the rest of the result leaves,
 * measured as escaped JSON so multi-byte and escaped text is counted as the
 * model will see it. A body shorter than the share keeps all of itself and
 * its unused bytes go to the longer bodies ("water filling").
 */
function allocateBodies(projected: JsonRecord, drafts: DraftCard[], maxTextBytes: number): void {
  const bodies = drafts.map((entry) => capText(entry.body ?? "", GMAIL_MODEL_BODY_MAX_CHARS));
  const ratios = bodies.map((body) =>
    body.length === 0 ? 1 : (jsonBytes(body) - 2) / body.length,
  );
  const wants = bodies.map((body) => jsonBytes(body) - 2);
  const apply = (caps: number[]): number => {
    drafts.forEach((entry, index) => setBody(entry, capText(bodies[index]!, caps[index]!)));
    return jsonBytes(projected);
  };
  if (apply(bodies.map((body) => body.length)) <= maxTextBytes) return;
  const skeletonBytes = apply(bodies.map(() => 0));
  let available = maxTextBytes - skeletonBytes;
  // Measured placement can still overshoot by rounding and trimming; shrink
  // the shared level by the overshoot and retry a few times.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const level = waterLevel(wants, Math.max(0, available));
    const caps = wants.map((want, index) =>
      Math.max(GMAIL_MODEL_BODY_MIN_CHARS, Math.floor(Math.min(want, level) / ratios[index]!)),
    );
    const total = apply(caps);
    if (total <= maxTextBytes) return;
    available -= total - maxTextBytes;
  }
}

/** The largest per-body byte level whose filled total fits `available`. */
function waterLevel(wants: number[], available: number): number {
  const sorted = [...wants].sort((a, b) => a - b);
  let remaining = available;
  for (let index = 0; index < sorted.length; index += 1) {
    const share = remaining / (sorted.length - index);
    if (sorted[index]! >= share) return share;
    remaining -= sorted[index]!;
  }
  return Number.POSITIVE_INFINITY;
}

function setBody(entry: DraftCard, capped: string): void {
  const body = entry.body ?? "";
  entry.card.plaintextBody = capped || null;
  entry.card.contentTruncated = capped.length < body.length || entry.bridgeTruncated;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function draftCard(message: JsonRecord): DraftCard {
  const out: JsonRecord = {};
  const isDraft = typeof message.draftId === "string";
  if (!isDraft || message.id !== message.draftId) copyDefined(out, message, "id");
  copyDefined(out, message, "draftId");
  copyDefined(out, message, "messageId");
  copyDefined(out, message, "threadId");
  copyDefined(out, message, "sender");
  const replyTo = distinctReplyTo(message);
  if (replyTo) out.replyTo = replyTo;
  for (const key of ["toRecipients", "ccRecipients", "bccRecipients"]) {
    const recipients = message[key];
    if (Array.isArray(recipients) && recipients.length > 0) out[key] = recipients;
  }
  const dateTime =
    typeof message.dateTime === "string" ? message.dateTime : internalDateTime(message);
  if (dateTime) out.dateTime = dateTime;
  else if (typeof message.date === "string") out.date = message.date;
  copyDefined(out, message, "subject");
  if (Array.isArray(message.labelIds) && message.labelIds.length > 0)
    out.labelIds = message.labelIds;
  if (Array.isArray(message.attachments)) {
    const names = message.attachments.flatMap((attachment) =>
      isRecord(attachment) && typeof attachment.filename === "string" && attachment.filename.trim()
        ? [attachment.filename]
        : [],
    );
    if (names.length > 0) out.attachments = names;
  }
  const hasBodyFields = "plaintextBody" in message || "htmlBody" in message;
  const plain =
    typeof message.plaintextBody === "string" ? normalizeText(message.plaintextBody) : "";
  if (!plain) copyDefined(out, message, "snippet");
  if (!hasBodyFields) return { card: out, body: null, bridgeTruncated: false };
  const fromHtml =
    !plain && typeof message.htmlBody === "string" ? htmlToText(message.htmlBody) : "";
  const body = plain || fromHtml;
  // Placeholders keep the key order stable; allocateBodies fills them.
  out.plaintextBody = body || null;
  if (fromHtml) out.bodyFromHtml = true;
  out.contentTruncated = message.contentTruncated === true;
  if (Array.isArray(message.decodingErrors) && message.decodingErrors.length > 0) {
    out.decodingErrors = message.decodingErrors;
  }
  return { card: out, body, bridgeTruncated: message.contentTruncated === true };
}

function compactSingleMessage(value: JsonRecord, maxTextBytes: number): JsonRecord | null {
  if (typeof value.htmlBody !== "string") return null;
  const { htmlBody, ...kept } = value;
  if (typeof value.plaintextBody === "string" && value.plaintextBody.length > 0) {
    return { ...kept, htmlBodyOmitted: true };
  }
  // HTML-only mail: keep the markup (links included) while it fits the model's
  // budget; otherwise its readable text, so the generic truncation does not
  // cut raw markup out of the middle.
  if (jsonBytes(value) <= maxTextBytes) return null;
  const text = htmlToText(htmlBody);
  if (!text) return null;
  return { ...kept, plaintextBody: text, bodyFromHtml: true, htmlBodyOmitted: true };
}

/**
 * The root Reply-To header when it names an address the sender does not, so a
 * reply drafted from a card goes where the sender asked. Read from the raw
 * root header array, which the card itself drops.
 */
function distinctReplyTo(message: JsonRecord): string | null {
  if (!Array.isArray(message.headers)) return null;
  const header = message.headers.find(
    (entry): entry is JsonRecord =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      entry.name.toLowerCase() === "reply-to" &&
      typeof entry.value === "string",
  );
  const value = typeof header?.value === "string" ? header.value.trim() : "";
  if (!value) return null;
  const senderAddresses = new Set(
    emailAddresses(typeof message.sender === "string" ? message.sender : ""),
  );
  const replyAddresses = emailAddresses(value);
  if (
    replyAddresses.length > 0 &&
    replyAddresses.every((address) => senderAddresses.has(address))
  ) {
    return null;
  }
  return value;
}

function emailAddresses(value: string): string[] {
  return (value.match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/gu) ?? []).map((address) =>
    address.toLowerCase(),
  );
}

function copyDefined(out: JsonRecord, source: JsonRecord, key: string): void {
  const value = source[key];
  if (value !== undefined && value !== null && value !== "") out[key] = value;
}

function internalDateTime(message: JsonRecord): string | null {
  if (typeof message.internalDate !== "string" || !/^\d{1,15}$/u.test(message.internalDate)) {
    return null;
  }
  const date = new Date(Number(message.internalDate));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * Collapse what carries no meaning for a reader: CRLF, invisible preheader
 * padding (zero-width characters, soft hyphens, combining grapheme joiners),
 * runs of spaces and tabs, trailing spaces and runs of blank lines.
 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(
      /\u034f|[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2060-\u2064\ufeff]/gu,
      "",
    )
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

const SKIPPED_HTML_ELEMENTS = new Set(["head", "script", "style", "template", "title", "noscript"]);
const BLOCK_END_TAG =
  /<\/(?:p|div|tr|table|ul|ol|h[1-6]|blockquote|section|article|header|footer|center)\s*>|<br\b[^<>]*>|<hr\b[^<>]*>/giu;

/**
 * Readable text of an HTML body for the compact view. Every pattern excludes
 * `<` inside a tag, so a scan never runs past the next tag and the whole
 * conversion stays linear in the (already bounded) input.
 */
export function htmlToText(html: string): string {
  let kept = "";
  let skipping: string | null = null;
  let position = 0;
  const tags = /<!--|-->|<(\/?)([a-z][a-z0-9]*)\b[^<>]*>/giu;
  let inComment = false;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    const [token] = match;
    if (inComment) {
      if (token === "-->") {
        inComment = false;
        position = match.index + token.length;
      }
      continue;
    }
    if (token === "<!--") {
      if (!skipping) kept += html.slice(position, match.index);
      inComment = true;
      continue;
    }
    if (token === "-->") continue;
    const name = match[2]!.toLowerCase();
    const closing = match[1] === "/";
    if (skipping) {
      if (closing && name === skipping) {
        skipping = null;
        position = match.index + token.length;
      }
      continue;
    }
    if (!closing && SKIPPED_HTML_ELEMENTS.has(name)) {
      kept += html.slice(position, match.index);
      skipping = name;
    }
  }
  if (!skipping && !inComment) kept += html.slice(position);
  const text = kept
    .replace(BLOCK_END_TAG, "\n")
    .replace(/<li\b[^<>]*>/giu, "\n- ")
    .replace(/<\/t[dh]\s*>/giu, " ")
    .replace(/<\/?[a-z!][^<>]*>/giu, "");
  return normalizeText(decodeHtmlEntities(text));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  bull: "\u2022",
  middot: "\u00b7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  euro: "\u20ac",
  pound: "\u00a3",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/giu, (entity, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
