import { createHash, randomUUID } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type {
  ParsedCreateEventSourceRequest,
  CreateEventSourceResponse,
  EventDelivery,
  EventDeliveryStatus,
  EventSource,
  EventTypeDescriptor,
  ParsedSendTestEventRequest,
  SendTestEventResponse,
  UpdateEventSourceRequest,
} from "@opengeni/contracts";
import {
  createEventSource,
  decryptEnvironmentValue,
  deleteEventSource,
  encryptEnvironmentValue,
  eventSourceVisibleTo,
  getEventDeliveryForReplay,
  getEventSource,
  getInboundEvents,
  getScheduledTask,
  listMcpEventStreamKeys,
  listRecentEventTypes,
  recordEventDelivery,
  resolveEventIngressRoute,
  updateEventSource,
  type Database,
  type EventSourceRecord,
  type StoredEventInput,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { scheduledTaskAccess, type ScheduledTaskViewer } from "../scheduled-task-audience";
import { webhookEventTypeCatalog } from "./event-type-catalog";
import { eventMatchesTrigger } from "./matching";
import { boundEvent, type NormalizedEventInput } from "./normalize";
import {
  retainedWebhookHeaders,
  webhookAdapter,
  WebhookBodyError,
  type WebhookAdapterReading,
} from "./webhook-adapters";
import {
  withMcpEventSourceClient,
  McpEventSourceUnavailableError,
  mcpServerDisplayName,
  type McpEventsFetch,
} from "./mcp-event-source-client";
import { mcpDeliveryEvents, receiveMcpEventWebhook } from "./mcp-event-subscriptions";
import {
  forgetMcpSourceEventTypes,
  mcpEventTypeDescriptor,
  mcpSourceEventTypes,
  mcpWebhookBaseUrl,
  McpServerWithoutEventsError,
} from "./mcp-event-types";
import { serverOffersMcpEvents } from "./mcp-events-protocol";
import { generateStandardWebhookSecret } from "./webhook-signatures";
import { eventSourceWebhookUrl } from "./webhook-url";

/**
 * Event sources and the webhook intake. A webhook source is a URL a person
 * pastes into another app; every delivery to it is verified against the
 * source's secret, stored, deduplicated and normalized into events, and the
 * events queue on the automations whose triggers match.
 */

export function eventTriggersEnabled(settings: Pick<Settings, "eventTriggersEnabled">): boolean {
  return settings.eventTriggersEnabled === true;
}

/** Event source routes answer as if they did not exist while the feature is off. */
export function requireEventTriggersEnabled(
  settings: Pick<Settings, "eventTriggersEnabled">,
): void {
  if (!eventTriggersEnabled(settings)) {
    throw new HTTPException(404, {
      message: "Event triggers are not enabled on this deployment",
    });
  }
}

/** Who is asking: a person (subjectId) or a workspace-level caller such as an API key (null). */
export type EventSourceViewer = Pick<ScheduledTaskViewer, "subjectId" | "admin">;

/**
 * `manage`: change, rotate, test, replay and delete. `use`: see it, read its
 * events and deliveries, and point triggers at it. A private source is
 * invisible to everyone but its owner. A shared or workspace source is managed
 * by its owner, by admins, and by workspace-level callers.
 */
export function eventSourceAccess(
  viewer: EventSourceViewer,
  source: Pick<EventSourceRecord, "visibility" | "ownerSubjectId">,
): "manage" | "use" | "none" {
  if (!eventSourceVisibleTo(source, viewer.subjectId)) return "none";
  if (source.ownerSubjectId !== null && source.ownerSubjectId === viewer.subjectId) return "manage";
  return viewer.admin || viewer.subjectId === null ? "manage" : "use";
}

export async function requireEventSource(
  db: Database,
  viewer: EventSourceViewer,
  workspaceId: string,
  sourceId: string,
  need: "use" | "manage",
): Promise<EventSourceRecord> {
  const source = await getEventSource(db, workspaceId, sourceId);
  const access = source ? eventSourceAccess(viewer, source) : "none";
  if (!source || access === "none") {
    throw new HTTPException(404, { message: "event source not found" });
  }
  if (need === "manage" && access !== "manage") {
    throw new HTTPException(403, {
      message: "Only the source's owner or a workspace admin can change it",
    });
  }
  return source;
}

export function eventSourceForClient(source: EventSourceRecord, baseUrl: string): EventSource {
  return {
    id: source.id,
    workspaceId: source.workspaceId,
    kind: source.kind,
    adapter: source.adapter,
    name: source.name,
    ownerSubjectId: source.ownerSubjectId,
    visibility: source.visibility,
    status: source.status,
    statusReason: source.statusReason,
    webhookUrl:
      source.kind === "webhook" && source.routeId
        ? eventSourceWebhookUrl(baseUrl, source.routeId)
        : null,
    mcp:
      source.kind === "mcp" && source.mcpServerId
        ? { serverId: source.mcpServerId, connectionId: source.connectionId }
        : null,
    lastDeliveryAt: source.lastDeliveryAt?.toISOString() ?? null,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function requireEncryptionKey(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new HTTPException(503, {
      message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for webhook event sources",
    });
  }
  return key;
}

export async function createEventSourceForViewer(
  input: {
    db: Database;
    settings: Settings;
    accountId: string;
    workspaceId: string;
    /** The caller's grant subject, recorded as the creator. */
    createdBySubjectId: string;
    viewer: EventSourceViewer;
    request: ParsedCreateEventSourceRequest;
    baseUrl: string;
  } & McpEventSourceNetwork,
): Promise<CreateEventSourceResponse> {
  const request = input.request;
  if (request.kind === "mcp") return await createMcpEventSource(input, request);
  if (request.kind !== "webhook") {
    throw new HTTPException(422, {
      message: `${request.kind} event sources are not available on this deployment yet`,
    });
  }
  const key = requireEncryptionKey(input.settings);
  const generated = request.adapter === "standard" ? generateStandardWebhookSecret() : null;
  const secret = generated ?? request.signingSecret;
  if (!secret) {
    throw new HTTPException(422, {
      message: "Paste the signing secret the sending app shows",
    });
  }
  // A workspace-level caller owns nothing, so its sources are the workspace's.
  const owner = input.viewer.subjectId;
  const { source } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "webhook",
    adapter: request.adapter,
    name: request.name,
    ownerSubjectId: owner,
    visibility: owner === null ? "workspace" : request.visibility,
    secretEncrypted: encryptEnvironmentValue(key, secret),
  });
  return {
    source: eventSourceForClient(source, input.baseUrl),
    ...(generated ? { signingSecret: generated } : {}),
  };
}

/** Network access for MCP sources; tests replace the transport. */
export type McpEventSourceNetwork = { fetch?: McpEventsFetch };

/**
 * Turn a failure to reach an MCP source's server into the answer a person
 * sees: what to fix, or that the server could not be reached right now.
 */
export function mcpSourceHttpError(error: unknown, serverName: string): HTTPException {
  if (error instanceof HTTPException) return error;
  if (
    error instanceof McpEventSourceUnavailableError ||
    error instanceof McpServerWithoutEventsError
  ) {
    return new HTTPException(422, { message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HTTPException(503, {
    message: `Couldn't reach ${serverName} to read its events (${message.slice(0, 200)}). Try again shortly.`,
  });
}

/**
 * An MCP source listens to one connector with its creator's own sign-in, so
 * it is always private to that person. The server must offer events.
 */
async function createMcpEventSource(
  input: Parameters<typeof createEventSourceForViewer>[0] & McpEventSourceNetwork,
  request: Extract<ParsedCreateEventSourceRequest, { kind: "mcp" }>,
): Promise<CreateEventSourceResponse> {
  const owner = input.viewer.subjectId;
  if (!owner) {
    throw new HTTPException(422, {
      message: "An MCP event source listens with a person's own sign-in. Create it as that person.",
    });
  }
  const target = {
    kind: "mcp" as const,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ownerSubjectId: owner,
    mcpServerId: request.serverId,
    connectionId: request.connectionId ?? null,
  };
  let connection: { name: string; connectionId: string | null };
  try {
    connection = await withMcpEventSourceClient(
      { db: input.db, settings: input.settings, ...(input.fetch ? { fetch: input.fetch } : {}) },
      target,
      async (client, { server, connectionId }) => {
        const name = mcpServerDisplayName(server);
        if (!serverOffersMcpEvents(client)) throw new McpServerWithoutEventsError(name);
        return { name, connectionId };
      },
    );
  } catch (error) {
    throw mcpSourceHttpError(error, request.serverId);
  }
  const { source } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "mcp",
    name: request.name ?? connection.name,
    ownerSubjectId: owner,
    visibility: "private",
    mcpServerId: request.serverId,
    connectionId: connection.connectionId,
  });
  forgetMcpSourceEventTypes(source.id);
  return { source: eventSourceForClient(source, input.baseUrl) };
}

export async function updateEventSourceForViewer(input: {
  db: Database;
  settings: Settings;
  source: EventSourceRecord;
  request: UpdateEventSourceRequest;
  baseUrl: string;
}): Promise<EventSource> {
  const { source, request } = input;
  if (request.visibility !== undefined && source.ownerSubjectId === null) {
    throw new HTTPException(422, {
      message: "This source belongs to the workspace, so everyone in it can already use it",
    });
  }
  if (request.visibility === "workspace" && source.kind === "mcp") {
    throw new HTTPException(422, {
      message: "An MCP source listens with your own sign-in, so it stays private to you",
    });
  }
  if (
    request.signingSecret !== undefined &&
    (source.kind !== "webhook" || source.adapter === "standard")
  ) {
    throw new HTTPException(422, {
      message:
        source.adapter === "standard"
          ? "Opengeni makes this source's secret. Rotate it instead."
          : "This source has no signing secret to replace",
    });
  }
  const updated = await updateEventSource(input.db, source.workspaceId, source.id, {
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(request.visibility !== undefined ? { visibility: request.visibility } : {}),
    ...(request.status !== undefined
      ? {
          status: request.status,
          statusReason: request.status === "disabled" ? "Turned off" : null,
        }
      : {}),
    ...(request.signingSecret !== undefined
      ? {
          secretEncrypted: encryptEnvironmentValue(
            requireEncryptionKey(input.settings),
            request.signingSecret,
          ),
        }
      : {}),
  });
  if (!updated) throw new HTTPException(404, { message: "event source not found" });
  return eventSourceForClient(updated, input.baseUrl);
}

/** A new secret for a standard webhook source. The old one stops working at once. */
export async function rotateEventSourceSecret(input: {
  db: Database;
  settings: Settings;
  source: EventSourceRecord;
}): Promise<{ signingSecret: string }> {
  if (input.source.kind !== "webhook" || input.source.adapter !== "standard") {
    throw new HTTPException(422, {
      message: "Only standard webhook sources have a secret Opengeni makes",
    });
  }
  const signingSecret = generateStandardWebhookSecret();
  const updated = await updateEventSource(input.db, input.source.workspaceId, input.source.id, {
    secretEncrypted: encryptEnvironmentValue(requireEncryptionKey(input.settings), signingSecret),
  });
  if (!updated) throw new HTTPException(404, { message: "event source not found" });
  return { signingSecret };
}

export async function deleteEventSourceForViewer(input: {
  db: Database;
  source: EventSourceRecord;
}): Promise<void> {
  const result = await deleteEventSource(input.db, input.source.workspaceId, input.source.id);
  if (result.kind === "in_use") {
    const count = result.taskIds.length;
    throw new HTTPException(409, {
      message: `${count === 1 ? "An automation still uses" : `${count}${count >= 20 ? "+" : ""} automations still use`} this source. Remove its triggers first.`,
    });
  }
}

function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function storedEvents(
  reading: Extract<WebhookAdapterReading, { kind: "events" }>,
  receivedAt: Date,
  options: { refire: boolean },
): StoredEventInput[] {
  return reading.events.map((event) => {
    const bounded = boundEvent(event, receivedAt);
    // A replay re-fires its events on purpose, so they skip event deduplication.
    return options.refire ? { ...bounded, externalId: null } : bounded;
  });
}

type DeliveryOutcome = {
  status: EventDeliveryStatus;
  reason: string | null;
  events: StoredEventInput[];
};

function readDelivery(
  source: EventSourceRecord,
  headers: Headers,
  body: Uint8Array,
  receivedAt: Date,
  options: { refire: boolean },
): DeliveryOutcome {
  if (source.status !== "active") {
    return {
      status: "ignored",
      reason:
        source.status === "disabled"
          ? "The source is turned off"
          : (source.statusReason ?? "The source is blocked"),
      events: [],
    };
  }
  let reading: WebhookAdapterReading;
  try {
    reading = webhookAdapter(source.adapter ?? "standard").read({
      headers,
      body,
      receivedAt,
    });
  } catch (error) {
    if (error instanceof WebhookBodyError)
      return { status: "failed", reason: error.message, events: [] };
    throw error;
  }
  if (reading.kind === "ignored") return { status: "ignored", reason: reading.reason, events: [] };
  return {
    status: "accepted",
    reason: null,
    events: storedEvents(reading, receivedAt, options),
  };
}

/**
 * `gone` and `challenge` answer MCP servers: a delivery for a subscription
 * that ended (410, do not retry) and a webhook verification handshake.
 */
export type WebhookIntakeResult =
  | { outcome: "not_found" }
  | { outcome: "gone" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "challenge"; challenge: string }
  | { outcome: "stored"; delivery: EventDelivery; duplicate: boolean };

/**
 * One delivery to a webhook URL. Nothing is parsed before the signature is
 * checked over the exact raw body. The sender gets a success status only once
 * the delivery is stored, so a crash before that is retried by the sender.
 */
export async function receiveEventWebhook(input: {
  db: Database;
  settings: Settings;
  routeId: string;
  headers: Headers;
  body: Uint8Array;
  receivedAt?: Date;
}): Promise<WebhookIntakeResult> {
  if (!eventTriggersEnabled(input.settings)) return { outcome: "not_found" };
  const route = await resolveEventIngressRoute(input.db, input.routeId);
  if (route?.kind === "mcp") {
    return await receiveMcpEventWebhook({
      deps: { db: input.db, settings: input.settings },
      route: { routeId: input.routeId, workspaceId: route.workspaceId },
      headers: input.headers,
      body: input.body,
      receivedAt: input.receivedAt ?? new Date(),
    });
  }
  if (!route && input.headers.has("x-mcp-subscription-id")) return { outcome: "gone" };
  if (!route || route.kind !== "webhook") return { outcome: "not_found" };
  const source = await getEventSource(input.db, route.workspaceId, route.sourceId);
  if (!source || source.kind !== "webhook" || !source.adapter || !source.secretEncrypted) {
    return { outcome: "not_found" };
  }
  const receivedAt = input.receivedAt ?? new Date();
  const bodySha256 = sha256Hex(input.body);
  const secret = decryptEnvironmentValue(
    requireEncryptionKey(input.settings),
    source.secretEncrypted,
  );
  const verification = webhookAdapter(source.adapter).verify({
    secret,
    headers: input.headers,
    body: input.body,
    nowSeconds: receivedAt.getTime() / 1000,
  });
  const base = {
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    sourceId: source.id,
    bodyBytes: input.body.byteLength,
    bodySha256,
    match: eventMatchesTrigger,
  };
  if (!verification.ok) {
    // Logged without its body: an unverified body is never kept or read.
    await recordEventDelivery(input.db, {
      ...base,
      status: "rejected",
      reason: verification.reason,
      dedupeKey: `rejected:${randomUUID()}`,
      body: null,
      headers: {},
      events: [],
    });
    return { outcome: "rejected", reason: verification.reason };
  }
  const outcome = readDelivery(source, input.headers, input.body, receivedAt, {
    refire: false,
  });
  const recorded = await recordEventDelivery(input.db, {
    ...base,
    ...outcome,
    dedupeKey: verification.deliveryKey ?? `sha256:${bodySha256}`,
    body: input.body,
    headers: retainedWebhookHeaders(source.adapter, input.headers),
  });
  return {
    outcome: "stored",
    delivery: recorded.delivery,
    duplicate: recorded.duplicate,
  };
}

/** Run a stored delivery through intake again; its events fire again even if seen before. */
export async function replayEventDelivery(input: {
  db: Database;
  source: EventSourceRecord;
  deliveryId: string;
}): Promise<EventDelivery> {
  const { source } = input;
  const stored = await getEventDeliveryForReplay(
    input.db,
    source.workspaceId,
    source.id,
    input.deliveryId,
  );
  if (!stored) throw new HTTPException(404, { message: "event delivery not found" });
  if (!stored.body || (source.kind !== "webhook" && source.kind !== "mcp")) {
    throw new HTTPException(409, {
      message:
        stored.delivery.status === "rejected"
          ? "A rejected delivery was never verified, so it cannot be replayed"
          : "This delivery's body is no longer kept, so it cannot be replayed",
    });
  }
  if (source.status !== "active") {
    throw new HTTPException(409, {
      message: "Turn the source on before replaying a delivery",
    });
  }
  const receivedAt = new Date();
  let outcome: DeliveryOutcome;
  if (source.kind === "mcp") {
    const events = mcpDeliveryEvents(stored.body, stored.streamKey, receivedAt);
    if (events.length === 0) {
      throw new HTTPException(409, { message: "This delivery carried no events to replay" });
    }
    outcome = { status: "accepted", reason: null, events };
  } else {
    outcome = readDelivery(source, new Headers(stored.headers), stored.body, receivedAt, {
      refire: true,
    });
  }
  const recorded = await recordEventDelivery(input.db, {
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    sourceId: source.id,
    streamKey: stored.streamKey,
    ...outcome,
    dedupeKey: `replay:${randomUUID()}`,
    body: stored.body,
    bodyBytes: stored.body.byteLength,
    bodySha256: sha256Hex(stored.body),
    headers: stored.headers,
    replayOfDeliveryId: stored.delivery.id,
    match: eventMatchesTrigger,
  });
  return recorded.delivery;
}

/**
 * Send a made-up event through a source as if it had arrived, so a person can
 * watch their automation run without touching the other app.
 */
export async function sendTestEvent(input: {
  db: Database;
  viewer: ScheduledTaskViewer;
  source: EventSourceRecord;
  request: ParsedSendTestEventRequest;
}): Promise<SendTestEventResponse> {
  const { source } = input;
  if (source.status !== "active") {
    throw new HTTPException(409, {
      message: "Turn the source on before sending a test event",
    });
  }
  const receivedAt = new Date();
  const event: NormalizedEventInput = {
    externalId: null,
    type: input.request.type,
    occurredAt: receivedAt,
    subject: null,
    summary: `Test event (${input.request.type})`,
    url: null,
    actor: { kind: "person", name: null },
    data: input.request.data,
  };
  const body = JSON.stringify({
    type: input.request.type,
    data: input.request.data,
  });
  // An MCP event belongs to one subscription stream: send it on each stream
  // an automation listens to for this type, so each of them can fire.
  const streamKeys =
    source.kind === "mcp"
      ? await listMcpEventStreamKeys(input.db, source.workspaceId, source.id, input.request.type)
      : [""];
  if (streamKeys.length === 0) {
    throw new HTTPException(422, {
      message: `No automation listens for "${input.request.type}" on this source yet`,
    });
  }
  const bounded = boundEvent(event, receivedAt);
  const recorded = await recordEventDelivery(input.db, {
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    sourceId: source.id,
    status: "accepted",
    reason: "Test event sent from Opengeni",
    dedupeKey: `test:${randomUUID()}`,
    body: null,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    bodySha256: sha256Hex(body),
    headers: {},
    events: streamKeys.map((streamKey) => ({ ...bounded, streamKey })),
    match: eventMatchesTrigger,
  });
  const [stored] = await getInboundEvents(input.db, source.workspaceId, recorded.eventIds);
  if (!stored) throw new Error("test event was not stored");
  const visible: string[] = [];
  for (const taskId of recorded.matchedTaskIds) {
    const task = await getScheduledTask(input.db, source.workspaceId, taskId);
    if (task && scheduledTaskAccess(input.viewer, task) === "full") visible.push(taskId);
  }
  return { event: stored, matchedAutomationIds: visible };
}

/** The event types a trigger on this source can name. */
export async function listEventSourceTypes(
  input: {
    db: Database;
    settings: Settings;
    source: EventSourceRecord;
  } & McpEventSourceNetwork,
): Promise<EventTypeDescriptor[]> {
  if (input.source.kind === "mcp") {
    const webhookAvailable = mcpWebhookBaseUrl(input.settings) !== null;
    try {
      return await withMcpEventSourceClient(
        { db: input.db, settings: input.settings, ...(input.fetch ? { fetch: input.fetch } : {}) },
        input.source,
        async (client, { server }) =>
          (
            await mcpSourceEventTypes(client, input.source, mcpServerDisplayName(server), {
              fresh: true,
            })
          ).map((type) => mcpEventTypeDescriptor(type, webhookAvailable)),
      );
    } catch (error) {
      throw mcpSourceHttpError(error, input.source.name);
    }
  }
  const recent = await listRecentEventTypes(input.db, input.source.workspaceId, input.source.id);
  if (input.source.kind === "webhook") {
    return webhookEventTypeCatalog(input.source.adapter ?? "standard", recent);
  }
  return recent.map((entry) => ({
    type: entry.type,
    description: `Received ${entry.count} time${entry.count === 1 ? "" : "s"} recently`,
    fields: [],
    argumentsSchema: null,
    available: true,
    unavailableReason: null,
  }));
}
