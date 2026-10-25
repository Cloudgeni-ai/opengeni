import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { stableJson, type EventTypeDescriptor } from "@opengeni/contracts";
import type { EventSourceRecord } from "@opengeni/db";
import { inputSchemaArgumentIssues, formatToolGatewayInputIssues } from "@opengeni/tool-gateway";
import type { McpStreamableHttpClient } from "../mcp-streamable-http-client";
import {
  listMcpEventTypes,
  serverOffersMcpEvents,
  type McpEventDeliveryMode,
  type McpEventType,
} from "./mcp-events-protocol";
import { inboundWebhookBaseUrl } from "./webhook-url";

/**
 * The event types an MCP source offers, the delivery mode Opengeni uses for
 * each, and the stream key that names one subscription: an event type plus
 * its arguments. Triggers with the same stream share one subscription.
 */

const TYPE_CACHE_MS = 10 * 60_000;
const typeCache = new Map<string, { expiresAt: number; types: McpEventType[] }>();

export class McpServerWithoutEventsError extends Error {
  constructor(serverName: string) {
    super(`${serverName} doesn't offer events`);
    this.name = "McpServerWithoutEventsError";
  }
}

/** The event types a source's server offers, re-read at most every ten minutes. */
export async function mcpSourceEventTypes(
  client: McpStreamableHttpClient,
  source: Pick<EventSourceRecord, "id">,
  serverName: string,
  options: { fresh?: boolean; now?: number } = {},
): Promise<McpEventType[]> {
  const now = options.now ?? Date.now();
  const cached = typeCache.get(source.id);
  if (!options.fresh && cached && cached.expiresAt > now) return cached.types;
  if (!(await serverOffersMcpEvents(client, { timeout: 20_000 }))) {
    typeCache.delete(source.id);
    throw new McpServerWithoutEventsError(serverName);
  }
  const types = await listMcpEventTypes(client, { timeout: 20_000 });
  typeCache.set(source.id, { expiresAt: now + TYPE_CACHE_MS, types });
  return types;
}

/** Forget a source's event types, after the server said they changed. */
export function forgetMcpSourceEventTypes(sourceId: string): void {
  typeCache.delete(sourceId);
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
 * Webhook when the server offers it and this deployment has a public https
 * address (no polling, events arrive at once), else poll. A subscription
 * stays on poll once it is there, for example after the server could not
 * reach our webhook address. Push needs a held-open connection per
 * subscription, which Opengeni does not keep.
 */
export function mcpDeliveryModeFor(
  type: Pick<McpEventType, "delivery">,
  options: { webhookAvailable: boolean; current: "poll" | "webhook" | null },
): "poll" | "webhook" | null {
  const offers = (mode: McpEventDeliveryMode) => type.delivery.includes(mode);
  const webhook = offers("webhook") && options.webhookAvailable;
  if (options.current === "poll" && offers("poll")) return "poll";
  if (webhook) return "webhook";
  return offers("poll") ? "poll" : null;
}

export function mcpEventTypeUnavailableReason(
  type: Pick<McpEventType, "delivery">,
  webhookAvailable: boolean,
): string | null {
  if (mcpDeliveryModeFor(type, { webhookAvailable, current: null }) !== null) return null;
  if (type.delivery.includes("webhook")) {
    return "The server delivers this event only to a public https address, which this Opengeni deployment doesn't have";
  }
  return "The server delivers this event only over a held-open connection, which Opengeni doesn't support yet";
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
  const unavailableReason = mcpEventTypeUnavailableReason(type, webhookAvailable);
  return {
    type: type.name,
    description: type.description ?? "",
    fields: payloadFields(type.payloadSchema),
    argumentsSchema: type.inputSchema,
    available: unavailableReason === null,
    unavailableReason,
  };
}
