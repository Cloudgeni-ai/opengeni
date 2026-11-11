import type { Settings } from "@opengeni/config";
import {
  createEventSource,
  findAppEventSource,
  listSlackInstallationBindings,
  recordEventDelivery,
  type Database,
  type EventSourceRecord,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { readDelivery, sha256Hex } from "./delivery-intake";
import { eventMatchesTrigger } from "./matching";

/**
 * The Slack source: the Slack app's event callbacks, for the workspace its
 * Slack team is installed in. Shared with the whole workspace, like the
 * channels the app is in. Slack's own installation routing already names the
 * workspace of every callback, so the source needs no ingress route.
 */

function slackTeamSourceKey(teamId: string): string {
  return `team:${teamId}`;
}

/** Add the workspace's Slack source, or return the one it has. */
export async function createSlackEventSource(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  name?: string | undefined;
}): Promise<EventSourceRecord> {
  const bindings = await listSlackInstallationBindings(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  });
  const binding = bindings.find((entry) => entry.state === "active");
  if (!binding) {
    throw new HTTPException(422, { message: "Connect Slack to this workspace first" });
  }
  const { source } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "slack",
    name: input.name ?? "Slack",
    ownerSubjectId: null,
    visibility: "workspace",
    externalKey: slackTeamSourceKey(binding.slackTeamId),
  });
  return source;
}

/**
 * Record one verified Slack event callback as events of the Slack source of
 * `workspaceId`, the workspace the team is installed in. Only callbacks that
 * become events are kept: direct messages and other callbacks are not stored.
 */
export async function recordSlackEvent(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  teamId: string;
  body: Uint8Array;
  receivedAt?: Date;
}): Promise<void> {
  if (input.settings.eventTriggersEnabled !== true) return;
  const source = await findAppEventSource(
    input.db,
    input.workspaceId,
    "slack",
    slackTeamSourceKey(input.teamId),
  );
  if (!source) return;
  const outcome = readDelivery({
    source,
    settings: input.settings,
    headers: new Headers(),
    body: input.body,
    receivedAt: input.receivedAt ?? new Date(),
    refire: false,
  });
  if (outcome.status !== "accepted") return;
  const bodySha256 = sha256Hex(input.body);
  const eventId = outcome.events[0]?.externalId;
  await recordEventDelivery(input.db, {
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    sourceId: source.id,
    ...outcome,
    dedupeKey: eventId ? `slack:${eventId}` : `sha256:${bodySha256}`,
    body: input.body,
    bodyBytes: input.body.byteLength,
    bodySha256,
    headers: {},
    match: eventMatchesTrigger,
  });
}
