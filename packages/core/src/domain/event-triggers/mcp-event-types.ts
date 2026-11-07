import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { stableJson, type EventTypeDescriptor } from "@opengeni/contracts";
import type {
  EventSourceRecord,
  EventStatusReason,
  McpEventSubscriptionPollReason,
} from "@opengeni/db";
import { inputSchemaArgumentIssues, formatToolGatewayInputIssues } from "@opengeni/tool-gateway";
import type { McpStreamableHttpClient } from "../mcp-streamable-http-client";
import {
  listMcpEventTypes,
  serverOffersMcpEvents,
  type McpEventDeliveryMode,
  type McpEventType,
} from "./mcp-events-protocol";
import { EventSourceBlockedError, eventStatusReason } from "./status-reason";
import { inboundWebhookBaseUrl } from "./webhook-url";

/**
 * The event types an MCP source offers, the delivery mode Opengeni uses for
 * each, and the stream key that names one subscription: an event type plus
 * its arguments. Triggers with the same stream share one subscription.
 */

const TYPE_CACHE_MS = 10 * 60_000;
/**
 * How long a kept session trusts the event types it read. A server that
 * starts offering a type or a delivery mode (webhook) says so only in
 * `events/list`, so a long-lived session reads it again this often.
 */
const SESSION_TYPES_MS = 60 * 60_000;
const typeCache = new Map<string, { expiresAt: number; types: McpEventType[] }>();
/** Bumped when a source's types are forgotten, which outdates every memo of them. */
const typeGenerations = new Map<string, number>();

/**
 * The event types one kept MCP session read: a session reads them once, and
 * again after they are forgotten or an hour has passed. Steps that ask at the
 * same time share one read.
 */
export type McpEventTypesMemo = {
  read: Promise<McpEventType[]> | null;
  generation: number | null;
  readAt?: number;
};

export class McpServerWithoutEventsError extends EventSourceBlockedError {
  constructor(serverName: string) {
    super(eventStatusReason("events_unsupported", `${serverName} doesn't offer events`));
    this.name = "McpServerWithoutEventsError";
  }
}

/**
 * The event types a source's server offers, re-read at most every ten
 * minutes, or once an hour per kept session when the caller gives its `memo`.
 */
export async function mcpSourceEventTypes(
  client: McpStreamableHttpClient,
  source: Pick<EventSourceRecord, "id">,
  serverName: string,
  options: { fresh?: boolean; now?: number; memo?: McpEventTypesMemo } = {},
): Promise<McpEventType[]> {
  const now = options.now ?? Date.now();
  const generation = typeGenerations.get(source.id) ?? 0;
  const memo = options.memo;
  if (
    !options.fresh &&
    memo?.read &&
    memo.generation === generation &&
    now - (memo.readAt ?? now) < SESSION_TYPES_MS
  ) {
    return await memo.read;
  }
  const cached = typeCache.get(source.id);
  if (!options.fresh && !memo && cached && cached.expiresAt > now) return cached.types;
  const read = (async () => {
    if (!(await serverOffersMcpEvents(client, { timeout: 20_000 }))) {
      typeCache.delete(source.id);
      throw new McpServerWithoutEventsError(serverName);
    }
    const types = await listMcpEventTypes(client, { timeout: 20_000 });
    typeCache.set(source.id, { expiresAt: now + TYPE_CACHE_MS, types });
    return types;
  })();
  if (memo) {
    memo.read = read;
    memo.generation = generation;
    memo.readAt = now;
    read.catch(() => {
      if (memo.read === read) memo.read = null;
    });
  }
  return await read;
}

/** Forget a source's event types, after the server said they changed. */
export function forgetMcpSourceEventTypes(sourceId: string): void {
  typeCache.delete(sourceId);
  typeGenerations.set(sourceId, (typeGenerations.get(sourceId) ?? 0) + 1);
}

/** The callback base for webhook delivery: only a public https address can receive it. */
export function mcpWebhookBaseUrl(
  settings: Pick<Settings, "publicBaseUrl" | "webhookBaseUrl" | "environmentsEncryptionKey">,
): string | null {
  const baseUrl = inboundWebhookBaseUrl(settings);
  if (!baseUrl || !settings.environmentsEncryptionKey) return null;
  try {
    return new URL(baseUrl).protocol === "https:" ? baseUrl : null;
  } catch {
    return null;
  }
}

/**
 * How long a subscription that polls because its webhook failed (the server
 * could not reach our address, or would not deliver to it) waits before it
 * tries the webhook again.
 */
export const MCP_WEBHOOK_RETRY_AFTER_FAILURE_MS = 24 * 60 * 60_000;

/**
 * Webhook when the server offers it and this deployment has a public https
 * address (no polling, events arrive at once), else poll. A polling
 * subscription moves to webhook once that is possible, unless it polls
 * because a webhook failed less than {@link MCP_WEBHOOK_RETRY_AFTER_FAILURE_MS}
 * ago. Push needs a held-open connection per subscription, which Opengeni
 * does not keep.
 */
export function mcpDeliveryModeFor(
  type: Pick<McpEventType, "delivery">,
  options: {
    webhookAvailable: boolean;
    current: "poll" | "webhook" | null;
    /** Why a polling subscription polls; null when unknown (an older release moved it). */
    pollReason?: { reason: McpEventSubscriptionPollReason; since: Date } | null;
    now?: Date;
  },
): "poll" | "webhook" | null {
  const offers = (mode: McpEventDeliveryMode) => type.delivery.includes(mode);
  const webhook = offers("webhook") && options.webhookAvailable;
  if (!webhook) return offers("poll") ? "poll" : null;
  const failed = options.pollReason?.reason === "callback_failed" ? options.pollReason.since : null;
  const recentlyFailed =
    failed !== null &&
    (options.now ?? new Date()).getTime() - failed.getTime() < MCP_WEBHOOK_RETRY_AFTER_FAILURE_MS;
  if (options.current === "poll" && recentlyFailed && offers("poll")) return "poll";
  return "webhook";
}

/** Why Opengeni can't receive an event type it is offered; null when it can. */
export function mcpEventTypeUnavailableReason(
  type: Pick<McpEventType, "delivery">,
  webhookAvailable: boolean,
): EventStatusReason | null {
  if (mcpDeliveryModeFor(type, { webhookAvailable, current: null }) !== null) return null;
  if (type.delivery.includes("webhook")) {
    return eventStatusReason(
      "needs_public_address",
      "The server delivers this event only to a public https address, which this Opengeni deployment doesn't have",
    );
  }
  return eventStatusReason(
    "push_only",
    "The server delivers this event only over a held-open connection, which Opengeni doesn't support yet",
  );
}

/** One subscription: an event type and its arguments. */
export function mcpEventStreamKey(eventName: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(stableJson([eventName, args]), "utf8")
    .digest("hex");
}

/** Problems with trigger arguments against the type's input schema, in plain words. */
export function mcpEventArgumentsProblem(
  type: Pick<McpEventType, "inputSchema">,
  args: Record<string, unknown>,
): string | null {
  if (!type.inputSchema) return null;
  const { issues, omittedIssueCount } = inputSchemaArgumentIssues(type.inputSchema, args);
  return issues.length > 0 ? formatToolGatewayInputIssues(issues, omittedIssueCount) : null;
}

function payloadFields(schema: Record<string, unknown> | null): EventTypeDescriptor["fields"] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, unknown>)
    .slice(0, 50)
    .map(([name, property]) => {
      const description = (property as { description?: unknown } | null)?.description;
      return {
        field: `data.${name}`,
        description: typeof description === "string" ? description.slice(0, 300) : "",
      };
    });
}

/** An MCP event type as a trigger editor shows it. */
export function mcpEventTypeDescriptor(
  type: McpEventType,
  webhookAvailable: boolean,
): EventTypeDescriptor {
  const unavailable = mcpEventTypeUnavailableReason(type, webhookAvailable);
  return {
    type: type.name,
    description: type.description ?? "",
    fields: payloadFields(type.payloadSchema),
    argumentsSchema: type.inputSchema,
    available: unavailable === null,
    unavailableReason: unavailable?.text ?? null,
    unavailableReasonCode: unavailable?.code ?? null,
    unavailableReasonDetail: unavailable?.detail ?? null,
  };
}
