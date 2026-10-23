import { EventTypeName, type EventActorKind, type WebhookEventAdapter } from "@opengeni/contracts";
import { verifyHexBodyHmac, verifyStandardWebhook } from "./webhook-signatures";
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebhookBodyError("The body is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebhookBodyError("The body is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function eventType(value: string): string {
  const parsed = EventTypeName.safeParse(value);
  if (!parsed.success)
    throw new WebhookBodyError(`"${oneLine(value, 80)}" is not a usable event type`);
  return parsed.data;
}

function objectAt(value: unknown, path: string): Record<string, unknown> | null {
  const found = readPath(value, path);
  return found !== null && typeof found === "object" && !Array.isArray(found)
    ? (found as Record<string, unknown>)
    : null;
}

const PAST_TENSE: Record<string, string> = {
  create: "created",
  update: "updated",
  remove: "removed",
  delete: "deleted",
  restore: "restored",
  archive: "archived",
  unarchive: "unarchived",
};

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

/** Linear webhooks: `Linear-Signature` over the raw body, `webhookTimestamp` in ms. */
const linearAdapter: WebhookAdapterDefinition = {
  retainedHeaders: ["linear-delivery", "linear-event"],
  verify({ secret, headers, body, nowSeconds }) {
    if (!verifyHexBodyHmac({ secret, signature: headers.get("linear-signature"), body })) {
      return { ok: false, reason: "The Linear-Signature header does not match the signing secret" };
    }
    let payload: Record<string, unknown>;
    try {
      payload = parseJsonObject(body);
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    const sentAt = parseEventTime(payload.webhookTimestamp);
    const now = (nowSeconds ?? Date.now() / 1000) * 1000;
    if (!sentAt || Math.abs(now - sentAt.getTime()) > 60_000) {
      return { ok: false, reason: "The webhookTimestamp is more than a minute from now" };
    }
    const delivery = headers.get("linear-delivery");
    return { ok: true, deliveryKey: delivery ? `linear-delivery:${delivery.slice(0, 200)}` : null };
  },
  read({ body, receivedAt }) {
    const payload = parseJsonObject(body);
    const resource = typeof payload.type === "string" ? payload.type : null;
    const action = typeof payload.action === "string" ? payload.action : null;
    if (!resource || !action) throw new WebhookBodyError('The body has no "type" and "action"');
    const type = eventType(`${resource}.${action}`);
    const data = objectAt(payload, "data") ?? {};
    const identifier = firstText(data, ["identifier", "issue.identifier"]);
    const title =
      firstText(data, ["title", "name", "issue.title", "label.name"]) ??
      (typeof data.body === "string" ? oneLine(data.body, 160) : null);
    const actorType = firstText(payload, ["actor.type"]);
    const actorName = firstText(payload, ["actor.name", "actor.email"]);
    const actorKind: EventActorKind =
      actorType === null ? "unknown" : actorType === "user" ? "person" : "bot";
    return {
      kind: "events",
      events: [
        {
          // `webhookId` names the webhook, not the delivery; deliveries are
          // deduplicated by their Linear-Delivery header instead.
          externalId: null,
          type,
          occurredAt: parseEventTime(payload.createdAt) ?? receivedAt,
          subject: identifier ?? firstText(data, ["id"]),
          summary: [
            `${resource} ${PAST_TENSE[action] ?? action}`,
            [identifier, title].filter(Boolean).join(" "),
          ]
            .filter(Boolean)
            .join(": "),
          url: firstText(payload, ["url"]),
          actor: { kind: actorKind, name: actorName },
          data: {
            ...payload,
            // Linear repeats its own delivery bookkeeping in every body.
            webhookId: undefined,
            webhookTimestamp: undefined,
          },
        },
      ],
    };
  },
};

/** Sentry integration webhooks: `Sentry-Hook-Signature` with the client secret. */
const sentryAdapter: WebhookAdapterDefinition = {
  retainedHeaders: ["sentry-hook-resource", "request-id"],
  verify({ secret, headers, body }) {
    if (!verifyHexBodyHmac({ secret, signature: headers.get("sentry-hook-signature"), body })) {
      return {
        ok: false,
        reason: "The Sentry-Hook-Signature header does not match the client secret",
      };
    }
    const requestId = headers.get("request-id");
    return { ok: true, deliveryKey: requestId ? `request-id:${requestId.slice(0, 200)}` : null };
  },
  read({ headers, body, receivedAt }) {
    const payload = parseJsonObject(body);
    const resource = headers.get("sentry-hook-resource");
    const action = typeof payload.action === "string" ? payload.action : null;
    if (!resource || !action) {
      throw new WebhookBodyError('The delivery has no Sentry-Hook-Resource header or "action"');
    }
    const type = eventType(`${resource}.${action}`);
    const data = objectAt(payload, "data") ?? {};
    const title = firstText(data, [
      "issue.title",
      "error.title",
      "event.title",
      "description_title",
      "metric_alert.title",
      "comment",
    ]);
    const shortId = firstText(data, ["issue.shortId", "issue.short_id"]);
    const actorType = firstText(payload, ["actor.type"]);
    return {
      kind: "events",
      events: [
        {
          externalId: null,
          type,
          occurredAt:
            parseEventTime(
              readPath(data, "issue.lastSeen") ??
                readPath(data, "event.datetime") ??
                readPath(data, "error.datetime"),
            ) ?? receivedAt,
          subject: shortId ?? firstText(data, ["issue.id", "event.issue_id", "error.issue_id"]),
          summary: [
            `${resource.replace(/_/gu, " ")} ${action}`,
            [shortId, title].filter(Boolean).join(" "),
          ]
            .filter(Boolean)
            .join(": "),
          url: firstText(data, [
            "issue.web_url",
            "event.web_url",
            "error.web_url",
            "metric_alert.web_url",
            "web_url",
          ]),
          actor: {
            kind: actorType === null ? "unknown" : actorType === "user" ? "person" : "bot",
            name: firstText(payload, ["actor.name"]),
          },
          data: payload,
        },
      ],
    };
  },
};

const WEBHOOK_ADAPTERS: Record<WebhookEventAdapter, WebhookAdapterDefinition> = {
  standard: standardAdapter,
  linear: linearAdapter,
  sentry: sentryAdapter,
};

export function webhookAdapter(adapter: WebhookEventAdapter): WebhookAdapterDefinition {
  return WEBHOOK_ADAPTERS[adapter];
}

/** The retained headers of a delivery, lower-cased, for replay. */
export function retainedWebhookHeaders(
  adapter: WebhookEventAdapter,
  headers: Headers,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of webhookAdapter(adapter).retainedHeaders) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value.slice(0, 512);
  }
  return kept;
}
