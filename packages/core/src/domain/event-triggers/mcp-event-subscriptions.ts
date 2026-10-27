import { createHash, randomUUID } from "node:crypto";
import { environmentsEncryptionKeyBytes, type McpServerConfig } from "@opengeni/config";
import type { EventDelivery } from "@opengeni/contracts";
import {
  claimMcpEventSubscription,
  decryptEnvironmentValue,
  deleteMcpEventSubscription,
  dropMcpEventSubscriptionWebhook,
  encryptEnvironmentValue,
  ensureMcpEventSubscriptionWebhook,
  finishMcpEventSubscriptionStep,
  getEventSource,
  getMcpEventSubscriptionByRoute,
  listDueMcpEventSubscriptions,
  recordEventDelivery,
  recordMcpEventDelivery,
  recordMcpEventGap,
  setEventStreamTriggerStatus,
  setMcpEventSubscriptionServerId,
  wakeMcpEventSubscription,
  type EventSourceRecord,
  type EventStatusReason,
  type McpEventSubscriptionRecord,
  type StoredEventInput,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { McpStreamableHttpClient } from "../mcp-streamable-http-client";
import {
  mcpServerDisplayName,
  withMcpEventSourceClient,
  type McpEventSourceClientDeps,
} from "./mcp-event-source-client";
import {
  forgetMcpSourceEventTypes,
  mcpDeliveryModeFor,
  mcpSourceEventTypes,
  mcpEventTypeUnavailableReason,
  mcpWebhookBaseUrl,
} from "./mcp-event-types";
import { EventSourceBlockedError, eventStatusReason } from "./status-reason";
import {
  classifyMcpEventsError,
  classifyMcpEventsProtocolError,
  pollMcpEvents,
  readMcpWebhookBody,
  subscribeMcpEvents,
  unsubscribeMcpEvents,
  type McpEventOccurrence,
  type McpEventsFailure,
} from "./mcp-events-protocol";
import { eventMatchesTrigger } from "./matching";
import { boundEvent, firstText, parseEventTime, type NormalizedEventInput } from "./normalize";
import { postTriggerNotices } from "./trigger-notices";
import { generateStandardWebhookSecret, verifyStandardWebhook } from "./webhook-signatures";
import { eventSourceWebhookUrl } from "./webhook-url";
import { errorMessage } from "@opengeni/contracts/values";

/**
 * Keeps every MCP event subscription that an automation wants alive. One pump
 * step handles one subscription: it polls the server, or creates and refreshes
 * a webhook subscription whose deliveries arrive at the public intake. The
 * subscription row holds the stream's cursor, so a restart resumes where it
 * stopped. A subscription nothing wants any more is ended and removed.
 *
 * When the server refuses a stream for a reason a person has to fix (a
 * sign-in, changed arguments, an event type that went away), the triggers on
 * it are blocked with a plain reason, the automation's owner is told once,
 * and the step retries every 15 minutes. The first success unblocks them.
 */

export type McpEventSubscriptionPumpDeps = McpEventSourceClientDeps & {
  bus: EventBus;
  observability?: Pick<Observability, "warn" | "error">;
  now?: () => Date;
};

const LEASE_MS = 5 * 60_000;
const POLL_MAX_EVENTS = 50;
const POLL_MAX_PAGES = 10;
/** Replay no further back than this after Opengeni was away: older events no longer help anyone. */
export const MCP_EVENT_MAX_REPLAY_MS = 6 * 60 * 60_000;
const POLL_DEFAULT_MS = 60_000;
const POLL_MIN_MS = 15_000;
const POLL_MAX_MS = 60 * 60_000;
const WEBHOOK_TTL_MS = 24 * 60 * 60_000;
const WEBHOOK_MIN_REFRESH_MS = 60_000;
const BLOCKED_RETRY_MS = 15 * 60_000;
const TRANSIENT_FIRST_RETRY_MS = 30_000;
const BLOCK_AFTER_FAILING_MS = 60 * 60_000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function httpUrl(value: string | null): string | null {
  return value && /^https?:\/\//iu.test(value) ? value : null;
}

/** An MCP occurrence as an event: the name is the type and the event id dedupes it. */
export function normalizeMcpEventOccurrence(
  occurrence: McpEventOccurrence,
  receivedAt: Date,
): NormalizedEventInput {
  const data = occurrence.data;
  return {
    externalId: occurrence.eventId,
    type: occurrence.name,
    occurredAt: parseEventTime(occurrence.timestamp) ?? receivedAt,
    subject: null,
    summary:
      firstText(data, ["summary", "title", "subject", "name", "text", "message"]) ??
      occurrence.name,
    url: httpUrl(firstText(data, ["url", "htmlUrl", "html_url", "webUrl", "link", "permalink"])),
    actor: { kind: "unknown", name: null },
    data,
  };
}

function storedOccurrences(
  occurrences: readonly McpEventOccurrence[],
  receivedAt: Date,
  options: { refire: boolean; streamKey: string },
): StoredEventInput[] {
  return occurrences.map((occurrence) => {
    const bounded = boundEvent(
      { ...normalizeMcpEventOccurrence(occurrence, receivedAt), streamKey: options.streamKey },
      receivedAt,
    );
    return options.refire ? { ...bounded, externalId: null } : bounded;
  });
}

/** The events a stored MCP delivery body carries, to replay it: a poll page or one webhook event. */
export function mcpDeliveryEvents(
  body: Uint8Array,
  streamKey: string,
  receivedAt: Date,
): StoredEventInput[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return [];
  }
  const page = (value as { events?: unknown } | null)?.events;
  if (Array.isArray(page)) {
    const occurrences = page.flatMap((entry) => {
      const read = readMcpWebhookBody(new TextEncoder().encode(JSON.stringify(entry)));
      return read.kind === "event" ? [read.occurrence] : [];
    });
    return storedOccurrences(occurrences, receivedAt, { refire: true, streamKey });
  }
  const read = readMcpWebhookBody(body);
  return read.kind === "event"
    ? storedOccurrences([read.occurrence], receivedAt, { refire: true, streamKey })
    : [];
}

type StepOutcome = {
  mode?: "poll" | "webhook";
  cursor?: string | null;
  gapPending?: boolean;
  serverSubscriptionId?: string | null;
  refreshBefore?: Date | null;
  nextActionAt: Date;
};

type StepContext = {
  deps: McpEventSubscriptionPumpDeps;
  source: EventSourceRecord;
  subscription: McpEventSubscriptionRecord;
  client: McpStreamableHttpClient;
  server: McpServerConfig;
  now: Date;
};

async function pollStep(context: StepContext): Promise<StepOutcome> {
  const { deps, subscription, client } = context;
  let cursor = subscription.cursor;
  let gapPending = subscription.gapPending;
  let nextPollMs: number | null = null;
  for (let page = 0; page < POLL_MAX_PAGES; page += 1) {
    const requested = cursor;
    const result = await pollMcpEvents(
      client,
      {
        name: subscription.eventName,
        arguments: subscription.arguments,
        cursor: requested,
        maxEvents: POLL_MAX_EVENTS,
        maxAgeMs: MCP_EVENT_MAX_REPLAY_MS,
      },
      { timeout: 30_000 },
    );
    cursor = result.cursor;
    nextPollMs = result.nextPollMs;
    if (result.events.length > 0) {
      const receivedAt = deps.now?.() ?? new Date();
      const body = JSON.stringify({ events: result.rawEvents });
      const bytes = new TextEncoder().encode(body);
      const recorded = await recordMcpEventDelivery(deps.db, {
        workspaceId: subscription.workspaceId,
        subscriptionId: subscription.id,
        delivery: {
          status: "accepted",
          reason:
            result.skipped > 0
              ? `${result.skipped} malformed event${result.skipped === 1 ? " was" : "s were"} left out`
              : null,
          dedupeKey: `poll:${sha256Hex(`${subscription.streamKey}\u0000${requested ?? ""}\u0000${body}`)}`,
          body: bytes.byteLength <= 1024 * 1024 ? bytes : null,
          bodyBytes: bytes.byteLength,
          bodySha256: sha256Hex(bytes),
          headers: {},
          events: storedOccurrences(result.events, receivedAt, {
            refire: false,
            streamKey: subscription.streamKey,
          }),
          match: eventMatchesTrigger,
        },
        cursor,
        truncated: result.truncated,
      });
      if (!recorded) throw new Error("The subscription was removed while it was polled");
      gapPending = recorded.subscription.gapPending;
    } else if (result.truncated) {
      gapPending = true;
    }
    if (!result.hasMore || cursor === requested) break;
  }
  const waitMs = clamp(nextPollMs ?? POLL_DEFAULT_MS, POLL_MIN_MS, POLL_MAX_MS);
  return {
    mode: "poll",
    cursor,
    gapPending,
    serverSubscriptionId: null,
    refreshBefore: null,
    nextActionAt: new Date(context.now.getTime() + waitMs),
  };
}

function encryptionKey(deps: McpEventSubscriptionPumpDeps): Uint8Array {
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key)
    throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for webhook delivery");
  return key;
}

async function webhookStep(context: StepContext, baseUrl: string): Promise<StepOutcome> {
  const { deps, subscription, client } = context;
  const key = encryptionKey(deps);
  const route =
    subscription.routeId && subscription.secretEncrypted
      ? { routeId: subscription.routeId, secretEncrypted: subscription.secretEncrypted }
      : await ensureMcpEventSubscriptionWebhook(
          deps.db,
          subscription.workspaceId,
          subscription.id,
          encryptEnvironmentValue(key, generateStandardWebhookSecret()),
        );
  if (!route) throw new Error("The subscription was removed while it was refreshed");
  // Refreshing is how a webhook subscription stays alive and how its cursor
  // advances in quiet periods; it is idempotent, so every step refreshes.
  const result = await subscribeMcpEvents(
    client,
    {
      name: subscription.eventName,
      arguments: subscription.arguments,
      url: eventSourceWebhookUrl(baseUrl, route.routeId),
      secret: decryptEnvironmentValue(key, route.secretEncrypted),
      cursor: subscription.cursor,
      maxAgeMs: MCP_EVENT_MAX_REPLAY_MS,
      ttlMs: WEBHOOK_TTL_MS,
    },
    { timeout: 30_000 },
  );
  if (result.deliveryError) {
    deps.observability?.warn("MCP server reports trouble delivering events to Opengeni", {
      subscriptionId: subscription.id,
      category: result.deliveryError,
    });
  }
  const now = context.now.getTime();
  const lifetime = result.refreshBefore ? result.refreshBefore.getTime() - now : WEBHOOK_TTL_MS;
  return {
    mode: "webhook",
    cursor: result.cursor,
    ...(result.truncated ? { gapPending: true } : {}),
    serverSubscriptionId: result.id,
    refreshBefore: result.refreshBefore,
    nextActionAt: new Date(
      now + clamp(Math.floor(lifetime * 0.8), WEBHOOK_MIN_REFRESH_MS, WEBHOOK_TTL_MS),
    ),
  };
}

async function unsubscribeQuietly(context: StepContext, baseUrl: string | null): Promise<void> {
  const { subscription } = context;
  if (subscription.mode !== "webhook" || !subscription.routeId || !baseUrl) return;
  try {
    await unsubscribeMcpEvents(
      context.client,
      {
        name: subscription.eventName,
        arguments: subscription.arguments,
        url: eventSourceWebhookUrl(baseUrl, subscription.routeId),
      },
      { timeout: 15_000 },
    );
  } catch {
    // Its TTL ends it anyway, and later deliveries to the removed route get 410.
  }
}

async function liveStep(context: StepContext): Promise<StepOutcome> {
  const { deps, source, subscription, client, server } = context;
  const types = await mcpSourceEventTypes(client, source, mcpServerDisplayName(server));
  const type = types.find((candidate) => candidate.name === subscription.eventName);
  if (!type) {
    throw new EventSourceBlockedError(
      eventStatusReason(
        "event_type_gone",
        `${mcpServerDisplayName(server)} no longer offers "${subscription.eventName}" events`,
      ),
    );
  }
  const baseUrl = mcpWebhookBaseUrl(deps.settings);
  const mode = mcpDeliveryModeFor(type, {
    webhookAvailable: baseUrl !== null,
    current: subscription.mode,
  });
  if (mode === null) {
    const unavailable = mcpEventTypeUnavailableReason(type, baseUrl !== null);
    throw new EventSourceBlockedError(
      eventStatusReason(
        unavailable?.code ?? "delivery_mode_unsupported",
        `${mcpServerDisplayName(server)} can't deliver "${subscription.eventName}" events to this Opengeni deployment`,
      ),
    );
  }
  if (mode === "webhook") {
    try {
      return await webhookStep(context, baseUrl!);
    } catch (error) {
      // The server can't reach our address (or won't use webhooks after
      // all): poll instead when the type offers it. Polling sticks, so a
      // later step does not try the webhook again.
      const failure = classifyMcpEventsError(error);
      const cannotDeliver =
        failure.kind === "callback_unreachable" || failure.kind === "delivery_mode_unsupported";
      if (!cannotDeliver || !type.delivery.includes("poll")) throw error;
      deps.observability?.warn("MCP server can't deliver events to Opengeni's webhook; polling", {
        subscriptionId: subscription.id,
        failure: failure.kind,
      });
      await dropMcpEventSubscriptionWebhook(deps.db, subscription.workspaceId, subscription.id);
      return await pollStep({
        ...context,
        subscription: { ...subscription, mode: "poll", serverSubscriptionId: null },
      });
    }
  }
  if (subscription.mode === "webhook") {
    await unsubscribeQuietly(context, baseUrl);
    await dropMcpEventSubscriptionWebhook(deps.db, subscription.workspaceId, subscription.id);
  }
  return await pollStep({ ...context, subscription: { ...subscription, mode: "poll" } });
}

function blockedReason(
  failure: McpEventsFailure,
  serverName: string,
  eventName: string,
): EventStatusReason | null {
  switch (failure.kind) {
    case "event_type_gone":
      return eventStatusReason(
        "event_type_gone",
        `${serverName} no longer offers "${eventName}" events`,
      );
    case "forbidden":
      return eventStatusReason(
        "forbidden",
        `${serverName} doesn't let your account receive "${eventName}" events with these settings${failure.detail ? ` (${failure.detail})` : ""}`,
        failure.detail,
      );
    case "invalid_arguments":
      return eventStatusReason(
        "invalid_arguments",
        `${serverName} rejected this trigger's settings for "${eventName}"${failure.detail ? `: ${failure.detail}` : ""}`,
        failure.detail,
      );
    case "events_unsupported":
      return eventStatusReason("events_unsupported", `${serverName} no longer offers events`);
    case "unauthorized":
      return eventStatusReason("reconnect", `Reconnect ${serverName} to keep its events coming`);
    case "callback_unreachable":
      return eventStatusReason(
        "callback_unreachable",
        `${serverName} can't reach Opengeni's webhook address (${failure.reason})`,
        failure.reason,
      );
    case "delivery_mode_unsupported":
      return eventStatusReason(
        "delivery_mode_unsupported",
        `${serverName} won't deliver "${eventName}" events in a way Opengeni can receive`,
      );
    default:
      return null;
  }
}

function transientRetryAt(subscription: McpEventSubscriptionRecord, now: Date): Date {
  const backoff = Math.min(
    TRANSIENT_FIRST_RETRY_MS * 2 ** Math.min(subscription.failures, 10),
    BLOCKED_RETRY_MS,
  );
  return new Date(now.getTime() + backoff);
}

async function block(
  deps: McpEventSubscriptionPumpDeps,
  subscription: McpEventSubscriptionRecord,
  reason: EventStatusReason,
): Promise<void> {
  const notices = await setEventStreamTriggerStatus(
    deps.db,
    subscription.workspaceId,
    { sourceId: subscription.sourceId, streamKey: subscription.streamKey },
    "blocked",
    reason,
  );
  await postTriggerNotices(deps, subscription.workspaceId, notices, {
    blocked: true,
    reason: reason.text,
  });
}

/** Run the next step of one subscription, if it is due and no other pump holds it. */
export async function runMcpEventSubscriptionStep(
  deps: McpEventSubscriptionPumpDeps,
  workspaceId: string,
  subscriptionId: string,
): Promise<void> {
  const claimed = await claimMcpEventSubscription(deps.db, workspaceId, subscriptionId, LEASE_MS);
  if (!claimed) return;
  const { subscription } = claimed;
  const source = await getEventSource(deps.db, workspaceId, subscription.sourceId);
  const now = deps.now?.() ?? new Date();
  if (!claimed.wanted || !source) {
    if (source && subscription.mode === "webhook") {
      await withMcpEventSourceClient(deps, source, (client, { server }) =>
        unsubscribeQuietly(
          { deps, source, subscription, client, server, now },
          mcpWebhookBaseUrl(deps.settings),
        ),
      ).catch(() => undefined);
    }
    await deleteMcpEventSubscription(deps.db, workspaceId, subscription.id);
    return;
  }
  let serverName = source.name;
  try {
    const outcome = await withMcpEventSourceClient(deps, source, async (client, { server }) => {
      serverName = mcpServerDisplayName(server);
      return await liveStep({ deps, source, subscription, client, server, now });
    });
    await finishMcpEventSubscriptionStep(deps.db, workspaceId, subscription.id, {
      ...outcome,
      outcome: { kind: "success" },
    });
    const notices = await setEventStreamTriggerStatus(
      deps.db,
      workspaceId,
      { sourceId: subscription.sourceId, streamKey: subscription.streamKey },
      "active",
      null,
    );
    await postTriggerNotices(deps, workspaceId, notices, { blocked: false });
  } catch (error) {
    await handleStepFailure(deps, subscription, serverName, error, now);
  }
}

async function handleStepFailure(
  deps: McpEventSubscriptionPumpDeps,
  subscription: McpEventSubscriptionRecord,
  serverName: string,
  error: unknown,
  now: Date,
): Promise<void> {
  const { workspaceId } = subscription;
  const message = errorMessage(error);
  const finish = (nextActionAt: Date, extra: Partial<StepOutcome> = {}) =>
    finishMcpEventSubscriptionStep(deps.db, workspaceId, subscription.id, {
      ...extra,
      nextActionAt,
      outcome: { kind: "failure", error: message },
    });
  let reason: EventStatusReason | null = null;
  if (error instanceof EventSourceBlockedError) {
    reason = error.reason;
  } else {
    const failure = classifyMcpEventsError(error);
    if (failure.kind === "event_type_gone" || failure.kind === "schema_changed") {
      forgetMcpSourceEventTypes(subscription.sourceId);
    }
    if (failure.kind === "schema_changed") {
      // Start over on the current schema; the restart may skip events.
      await finish(subscription.failures === 0 ? now : transientRetryAt(subscription, now), {
        cursor: null,
        gapPending: true,
        serverSubscriptionId: null,
      });
      return;
    }
    if (failure.kind === "delivery_mode_unsupported") {
      // The offered modes changed under us: look again before giving up.
      forgetMcpSourceEventTypes(subscription.sourceId);
      if (subscription.failures === 0) {
        await finish(now);
        return;
      }
    }
    reason = blockedReason(failure, serverName, subscription.eventName);
    if (reason === null) {
      const failingFor = subscription.failingSince
        ? now.getTime() - subscription.failingSince.getTime()
        : 0;
      if (failingFor < BLOCK_AFTER_FAILING_MS) {
        deps.observability?.warn("MCP event subscription step failed; it will retry", {
          subscriptionId: subscription.id,
          failures: subscription.failures + 1,
          error: message,
        });
        await finish(transientRetryAt(subscription, now));
        return;
      }
      reason = eventStatusReason("not_answering", `${serverName} hasn't answered for over an hour`);
    }
  }
  await finish(new Date(now.getTime() + BLOCKED_RETRY_MS));
  await block(deps, subscription, reason);
}

/** One bounded pass over due subscriptions. Returns how many it stepped. */
export async function pumpDueMcpEventSubscriptions(
  deps: McpEventSubscriptionPumpDeps,
  options: { limit?: number; concurrency?: number } = {},
): Promise<number> {
  const due = await listDueMcpEventSubscriptions(deps.db, options.limit ?? 32);
  const queue = [...due];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await runMcpEventSubscriptionStep(deps, next.workspaceId, next.id);
      } catch (error) {
        deps.observability?.error("MCP event subscription step crashed; it will retry", {
          subscriptionId: next.id,
          error: errorMessage(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, due.length)) }, worker),
  );
  return due.length;
}

export type McpWebhookIntakeResult =
  | { outcome: "not_found" }
  | { outcome: "gone" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "challenge"; challenge: string }
  | { outcome: "stored"; delivery: EventDelivery; duplicate: boolean };

const MCP_RETAINED_HEADERS = ["webhook-id", "x-mcp-subscription-id"];

function retainedHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of MCP_RETAINED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value.slice(0, 512);
  }
  return kept;
}

/**
 * One POST from an MCP server to a subscription's callback URL. The route
 * names the subscription and so its secret, which is checked over the raw
 * body before anything else. A delivery for a subscription that has ended
 * gets 410, which tells the server to stop retrying it.
 */
export async function receiveMcpEventWebhook(input: {
  deps: Pick<McpEventSubscriptionPumpDeps, "db" | "settings">;
  route: { routeId: string; workspaceId: string };
  headers: Headers;
  body: Uint8Array;
  receivedAt: Date;
}): Promise<McpWebhookIntakeResult> {
  const { db, settings } = input.deps;
  const { workspaceId } = input.route;
  const claimedId = input.headers.get("x-mcp-subscription-id");
  const subscription = await getMcpEventSubscriptionByRoute(db, workspaceId, input.route.routeId);
  if (!subscription?.secretEncrypted) {
    return claimedId ? { outcome: "gone" } : { outcome: "not_found" };
  }
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) return { outcome: "not_found" };
  const bodySha256 = sha256Hex(input.body);
  const base = {
    accountId: subscription.accountId,
    workspaceId,
    sourceId: subscription.sourceId,
    bodyBytes: input.body.byteLength,
    bodySha256,
    match: eventMatchesTrigger,
  };
  const verified = verifyStandardWebhook({
    secret: decryptEnvironmentValue(key, subscription.secretEncrypted),
    headers: input.headers,
    body: input.body,
    nowSeconds: input.receivedAt.getTime() / 1000,
  });
  if (!verified.ok) {
    await recordEventDelivery(db, {
      ...base,
      streamKey: subscription.streamKey,
      status: "rejected",
      reason: verified.reason,
      dedupeKey: `rejected:${randomUUID()}`,
      body: null,
      headers: {},
      events: [],
    });
    return { outcome: "rejected", reason: verified.reason };
  }
  const read = readMcpWebhookBody(input.body);
  if (read.kind === "verification") {
    // The id the server derived arrives first on its verification POST.
    if (claimedId && !subscription.serverSubscriptionId) {
      await setMcpEventSubscriptionServerId(
        db,
        workspaceId,
        subscription.id,
        claimedId.slice(0, 512),
      );
    }
    return { outcome: "challenge", challenge: read.challenge };
  }
  if (
    claimedId &&
    subscription.serverSubscriptionId &&
    claimedId !== subscription.serverSubscriptionId
  ) {
    return { outcome: "gone" };
  }
  if (claimedId && !subscription.serverSubscriptionId) {
    await setMcpEventSubscriptionServerId(
      db,
      workspaceId,
      subscription.id,
      claimedId.slice(0, 512),
    );
  }
  const delivery = {
    ...base,
    dedupeKey: `webhook-id:${verified.webhookId}`,
    body: input.body,
    headers: retainedHeaders(input.headers),
  };
  const ignored = async (reason: string) =>
    await recordEventDelivery(db, {
      ...delivery,
      streamKey: subscription.streamKey,
      status: "ignored",
      reason,
      events: [],
    });
  if (read.kind === "event") {
    if (read.occurrence.name !== subscription.eventName) {
      const recorded = await ignored(
        `An event for "${read.occurrence.name.slice(0, 120)}", which this subscription is not for`,
      );
      return { outcome: "stored", delivery: recorded.delivery, duplicate: recorded.duplicate };
    }
    const recorded = await recordMcpEventDelivery(db, {
      workspaceId,
      subscriptionId: subscription.id,
      delivery: {
        ...delivery,
        status: "accepted",
        reason: null,
        events: storedOccurrences([read.occurrence], input.receivedAt, {
          refire: false,
          streamKey: subscription.streamKey,
        }),
      },
      // A delivered cursor is a safe watermark; absent means none.
      cursor: read.occurrence.cursor ?? null,
    });
    if (!recorded) return { outcome: "gone" };
    if (recorded.matchedTaskIds.length === 0 && !recorded.duplicate) {
      await wakeMcpEventSubscription(db, workspaceId, subscription.id, { onlyIfUnwanted: true });
    }
    return { outcome: "stored", delivery: recorded.delivery, duplicate: recorded.duplicate };
  }
  if (read.kind === "gap") {
    await recordMcpEventGap(db, workspaceId, subscription.id, read.cursor);
    const recorded = await ignored("The server reported that some events were skipped");
    return { outcome: "stored", delivery: recorded.delivery, duplicate: recorded.duplicate };
  }
  if (read.kind === "terminated") {
    const failure = classifyMcpEventsProtocolError(read.error);
    if (failure.kind === "event_type_gone" || failure.kind === "schema_changed") {
      forgetMcpSourceEventTypes(subscription.sourceId);
    }
    const recorded = await ignored(
      `The server ended the subscription: ${read.error.message.slice(0, 300) || "no reason given"}`,
    );
    // The next step subscribes again, or blocks the triggers if the server refuses.
    await wakeMcpEventSubscription(db, workspaceId, subscription.id, {
      forgetServerSubscription: true,
    });
    return { outcome: "stored", delivery: recorded.delivery, duplicate: recorded.duplicate };
  }
  const recorded = await recordEventDelivery(db, {
    ...delivery,
    streamKey: subscription.streamKey,
    status: "failed",
    reason: read.reason,
    events: [],
  });
  return { outcome: "stored", delivery: recorded.delivery, duplicate: recorded.duplicate };
}
