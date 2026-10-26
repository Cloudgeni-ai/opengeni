import {
  currentWebhookAdapter,
  EventTypeName,
  parseWebhookSignedContent,
  type EventActorKind,
  type WebhookEventAdapter,
  type WebhookFormat,
  type WebhookSignatureFormat,
  type WebhookTextPaths,
  type WebhookValueSource,
} from "@opengeni/contracts";
import {
  verifyBodyHmac,
  verifyEd25519,
  verifyHeaderToken,
  verifyStandardWebhook,
  verifyTimestampedHmac,
  verifyUrlToken,
  webhookSignedBytes,
} from "./webhook-signatures";
import {
  firstText,
  oneLine,
  parseEventTime,
  readPath,
  type NormalizedEventInput,
} from "./normalize";

/**
 * How a webhook endpoint verifies and reads deliveries. Each adapter checks the
 * sender's signature over the exact raw body before anything is parsed, names
 * the sender's delivery id for deduplication, and turns a body into events.
 */
export type WebhookAdapterVerification =
  | { ok: true; deliveryKey: string | null }
  | { ok: false; reason: string };

export type WebhookAdapterReading =
  | { kind: "events"; events: NormalizedEventInput[] }
  | { kind: "ignored"; reason: string };

export type WebhookAdapterDefinition = {
  verify(input: {
    secret: string;
    headers: Headers;
    body: Uint8Array;
    /** The webhook address's query, for a secret sent in it. */
    query?: URLSearchParams;
    nowSeconds?: number;
  }): WebhookAdapterVerification;
  read(input: { headers: Headers; body: Uint8Array; receivedAt: Date }): WebhookAdapterReading;
  /** Non-secret headers `read` uses; they are stored with the body for replay. */
  retainedHeaders: readonly string[];
};

export class WebhookBodyError extends Error {
  readonly name = "WebhookBodyError";
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> {
  const parsed = parseJson(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebhookBodyError("The body is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebhookBodyError("The body is not JSON");
  }
}

function eventType(value: string): string {
  const parsed = EventTypeName.safeParse(value);
  if (!parsed.success)
    throw new WebhookBodyError(`"${oneLine(value, 80)}" is not a usable event type`);
  return parsed.data;
}

/** Standard Webhooks: `{ type, timestamp, data }`, signed with an Opengeni secret. */
const standardAdapter: WebhookAdapterDefinition = {
  retainedHeaders: ["webhook-id"],
  verify({ secret, headers, body, nowSeconds }) {
    const verified = verifyStandardWebhook({
      secret,
      headers,
      body,
      ...(nowSeconds !== undefined ? { nowSeconds } : {}),
    });
    return verified.ok
      ? { ok: true, deliveryKey: `webhook-id:${verified.webhookId}` }
      : { ok: false, reason: verified.reason };
  },
  read({ body, receivedAt }) {
    const payload = parseJsonObject(body);
    if (typeof payload.type !== "string") {
      throw new WebhookBodyError('The body has no "type" string');
    }
    const type = eventType(payload.type);
    const data =
      payload.data !== undefined
        ? payload.data
        : Object.fromEntries(
            Object.entries(payload).filter(([key]) => key !== "type" && key !== "timestamp"),
          );
    const summary =
      firstText(payload, ["summary", "data.summary", "data.title", "data.name"]) ?? type;
    const actorName = firstText(payload, ["actor.name", "actor", "data.actor.name"]);
    return {
      kind: "events",
      events: [
        {
          externalId: firstText(payload, ["id", "eventId"]),
          type,
          occurredAt: parseEventTime(payload.timestamp) ?? receivedAt,
          subject: firstText(payload, ["subject", "data.id"]),
          summary,
          url: firstText(payload, ["url", "data.url"]),
          actor: { kind: actorName ? "person" : "unknown", name: actorName },
          data,
        },
      ],
    };
  },
};

/** One custom delivery may hold at most this many events. */
export const CUSTOM_WEBHOOK_EVENTS_MAX = 100;

/** A text value at a path, or at the first of several paths that holds one. */
function textAt(value: unknown, paths: WebhookTextPaths | undefined): string | null {
  if (paths === undefined) return null;
  return firstText(value, typeof paths === "string" ? [paths] : paths);
}

/** The first of the paths that holds a time. */
function timeAt(value: unknown, paths: WebhookTextPaths | undefined): Date | null {
  for (const path of paths === undefined ? [] : typeof paths === "string" ? [paths] : paths) {
    const time = sendTime(readPath(value, path));
    if (time) return time;
  }
  return null;
}

/** An ISO time, or Unix seconds or milliseconds as a number or a string of digits. */
function sendTime(value: unknown): Date | null {
  if (typeof value === "string" && /^\d{9,13}$/u.test(value.trim())) {
    return parseEventTime(Number(value.trim()));
  }
  return parseEventTime(value);
}

type Verified = { ok: true; deliveryKey: string | null } | { ok: false; reason: string };

/** Check a delivery's signature as the format's scheme says. */
function verifyCustomSignature(
  signature: WebhookSignatureFormat,
  input: {
    secret: string;
    headers: Headers;
    body: Uint8Array;
    query: URLSearchParams;
    nowSeconds?: number | undefined;
  },
): Verified {
  const { secret, headers, body, nowSeconds } = input;
  switch (signature.scheme) {
    case "standard_webhooks": {
      const verified = verifyStandardWebhook({
        secret,
        headers,
        body,
        ...(nowSeconds !== undefined ? { nowSeconds } : {}),
      });
      return verified.ok ? { ok: true, deliveryKey: `webhook-id:${verified.webhookId}` } : verified;
    }
    case "url_token":
      return withoutKey(
        verifyUrlToken({ secret, parameter: signature.parameter, query: input.query }),
      );
    case "token":
      return withoutKey(
        verifyHeaderToken({
          secret,
          header: signature.header,
          value: headers.get(signature.header),
          prefix: signature.prefix,
        }),
      );
    case "timestamped_hmac_sha256":
      return withoutKey(
        verifyTimestampedHmac({
          secret,
          header: signature.header,
          value: headers.get(signature.header),
          body,
          toleranceSeconds: signature.toleranceSeconds,
          ...(nowSeconds !== undefined ? { nowSeconds } : {}),
        }),
      );
    case "hmac_sha256":
    case "ed25519": {
      const layout = signature.signedContent
        ? parseWebhookSignedContent(signature.signedContent)
        : null;
      if (typeof layout === "string") return { ok: false, reason: layout };
      const signed = webhookSignedBytes({ layout, headers, body });
      if (!signed.ok) return signed;
      const header = {
        header: signature.header,
        value: headers.get(signature.header),
        encoding: signature.encoding,
        prefix: signature.prefix,
      };
      return withoutKey(
        signature.scheme === "hmac_sha256"
          ? verifyBodyHmac({ secret, body: signed.bytes, ...header })
          : verifyEd25519({ publicKey: secret, signed: signed.bytes, ...header }),
      );
    }
  }
}

function withoutKey(result: { ok: true } | { ok: false; reason: string }): Verified {
  return result.ok ? { ok: true, deliveryKey: null } : result;
}

/** Refuse a delivery whose send time is missing or too far from now. */
function checkFreshness(
  freshness: WebhookFormat["freshness"],
  headers: Headers,
  body: Uint8Array,
  nowSeconds: number | undefined,
): Verified {
  if (!freshness) return { ok: true, deliveryKey: null };
  const where = "header" in freshness ? `the ${freshness.header} header` : `"${freshness.path}"`;
  const sentAt = sendTime(
    "header" in freshness
      ? headers.get(freshness.header)
      : readPath(parseJsonOrNull(body), freshness.path),
  );
  if (!sentAt) return { ok: false, reason: `The delivery has no send time in ${where}` };
  const now = (nowSeconds ?? Date.now() / 1000) * 1000;
  if (Math.abs(now - sentAt.getTime()) > freshness.toleranceSeconds * 1000) {
    return {
      ok: false,
      reason: `The send time in ${where} is more than ${freshness.toleranceSeconds} seconds from now`,
    };
  }
  return { ok: true, deliveryKey: null };
}

/** The event type's sources: one, or each of the parts it is joined from. */
function typeSources(type: WebhookFormat["type"]) {
  return "parts" in type ? type.parts : [type];
}

/**
 * Any app's webhooks, read as the source's format describes: its signature
 * scheme, where the event type and ids are, and whether one delivery holds a
 * list of events.
 */
function customAdapter(format: WebhookFormat): WebhookAdapterDefinition {
  const headerNames = [...typeSources(format.type), format.deliveryId].flatMap((source) =>
    source && "header" in source ? [source.header.toLowerCase()] : [],
  );
  return {
    retainedHeaders: [...new Set(headerNames)],
    verify({ secret, headers, body, query, nowSeconds }) {
      const verified = verifyCustomSignature(format.signature, {
        secret,
        headers,
        body,
        query: query ?? new URLSearchParams(),
        nowSeconds,
      });
      if (!verified.ok) return verified;
      // Only a signed delivery's send time can be trusted.
      const fresh = checkFreshness(format.freshness, headers, body, nowSeconds);
      if (!fresh.ok) return fresh;
      // The app's own delivery id keeps a retried delivery once; without one,
      // the body's hash does.
      const id = format.deliveryId
        ? "header" in format.deliveryId
          ? headers.get(format.deliveryId.header)?.trim() || null
          : textAt(parseJsonOrNull(body), format.deliveryId.path)
        : null;
      return {
        ok: true,
        deliveryKey: id ? `delivery-id:${id.slice(0, 200)}` : verified.deliveryKey,
      };
    },
    read({ headers, body, receivedAt }) {
      const payload = parseJson(body);
      const batchPath = format.batch?.path;
      const items = format.batch
        ? batchPath === undefined
          ? payload
          : readPath(payload, batchPath)
        : [payload];
      if (!Array.isArray(items)) {
        throw new WebhookBodyError(
          batchPath === undefined
            ? "The body is not a JSON list of events"
            : `The body has no list of events at "${batchPath}"`,
        );
      }
      if (items.length === 0) return { kind: "ignored", reason: "The delivery holds no events" };
      if (items.length > CUSTOM_WEBHOOK_EVENTS_MAX) {
        throw new WebhookBodyError(
          `The delivery holds ${items.length} events; at most ${CUSTOM_WEBHOOK_EVENTS_MAX} are read`,
        );
      }
      return {
        kind: "events",
        events: items.map((item) => customEvent(format, item, headers, receivedAt)),
      };
    },
  };
}

function parseJsonOrNull(body: Uint8Array): unknown {
  try {
    return parseJson(body);
  } catch {
    return null;
  }
}

/**
 * An event's own id: a path, the first of several paths with text, or parts
 * joined with the separator. An event missing a part has no id, so it is
 * never taken for another event that shares the parts it has.
 */
function eventIdAt(rule: WebhookFormat["eventId"], item: unknown, headers: Headers): string | null {
  if (rule === undefined) return null;
  if (typeof rule === "string" || Array.isArray(rule)) return textAt(item, rule);
  const parts: string[] = [];
  for (const part of rule.parts) {
    const text =
      "header" in part ? headers.get(part.header)?.trim() || null : textAt(item, part.path);
    if (!text) return null;
    parts.push(text);
  }
  return parts.join(rule.separator);
}

/** One piece of an event's type, from a header, a path or a fixed value. */
function typePart(
  source: WebhookFormat["type"] | WebhookValueSource,
  item: unknown,
  headers: Headers,
): string {
  const text =
    "value" in source
      ? source.value
      : "header" in source
        ? headers.get(source.header)?.trim() || null
        : "path" in source
          ? textAt(item, source.path)
          : null;
  if (text) return text;
  throw new WebhookBodyError(
    "header" in source
      ? `The delivery has no ${source.header} header for its event type`
      : `An event has no "${"path" in source ? source.path : ""}" for its type`,
  );
}

function customEvent(
  format: WebhookFormat,
  item: unknown,
  headers: Headers,
  receivedAt: Date,
): NormalizedEventInput {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new WebhookBodyError(
      format.batch ? "An event in the list is not a JSON object" : "The body is not a JSON object",
    );
  }
  const type = eventType(
    "parts" in format.type
      ? format.type.parts.map((part) => typePart(part, item, headers)).join(format.type.separator)
      : typePart(format.type, item, headers),
  );
  return {
    externalId: eventIdAt(format.eventId, item, headers)?.slice(0, 200) ?? null,
    type,
    occurredAt: timeAt(item, format.occurredAt) ?? receivedAt,
    subject: textAt(item, format.subject),
    summary: textAt(item, format.summary) ?? type,
    url: textAt(item, format.url),
    actor: { kind: actorKind(format.actorKind, item), name: textAt(item, format.actor) },
    data: item,
  };
}

/** A person when the format's actor kind says so, else a bot; unknown without one. */
function actorKind(rule: WebhookFormat["actorKind"], item: unknown): EventActorKind {
  if (!rule) return "unknown";
  const value = textAt(item, rule.path);
  if (value === null) return "unknown";
  return rule.person.includes(value) ? "person" : "bot";
}

/** A custom source stored without its format: every delivery is refused. */
const unformattedAdapter: WebhookAdapterDefinition = {
  retainedHeaders: [],
  verify: () => ({ ok: false, reason: "This custom webhook has no format yet" }),
  read: () => {
    throw new WebhookBodyError("This custom webhook has no format yet");
  },
};

/**
 * How a webhook source verifies and reads deliveries: Opengeni's own format,
 * or its custom format. A source stored as `linear` or `sentry` reads with
 * that app's preset.
 */
export function webhookAdapterFor(source: {
  adapter: WebhookEventAdapter | null;
  format: WebhookFormat | null;
}): WebhookAdapterDefinition {
  const current = currentWebhookAdapter(source);
  if (current.adapter !== "custom") return standardAdapter;
  return current.format ? customAdapter(current.format) : unformattedAdapter;
}

/** The retained headers of a delivery, lower-cased, for replay. */
export function retainedWebhookHeaders(
  adapter: WebhookAdapterDefinition,
  headers: Headers,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of adapter.retainedHeaders) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value.slice(0, 512);
  }
  return kept;
}
