import type { Settings } from "@opengeni/config";
import {
  createEventSource,
  findAppEventSource,
  getConnectionMetadata,
  getEventSource,
  listSlackInstallationBindings,
  recordEventDelivery,
  sharedOrganizationSlackBots,
  sharedSlackEventSourceIds,
  type Database,
  type EventSourceRecord,
} from "@opengeni/db";
import { errorMessage } from "@opengeni/contracts/values";
import { HTTPException } from "hono/http-exception";
import { readDelivery, sha256Hex } from "./delivery-intake";
import { eventMatchesTrigger } from "./matching";

/**
 * The Slack source: the Slack app's event callbacks, for a workspace the
 * Slack team's bot is installed in or that its organization shares the bot
 * with. Shared with the whole workspace, like the channels the app is in.
 * Slack's own installation routing names the bot's home workspace for every
 * callback, and its live sharing names the others, so the source needs no
 * ingress route.
 */

export function slackTeamSourceKey(teamId: string): string {
  return `team:${teamId}`;
}

/**
 * The Slack team a new Slack source listens to: the first one, local bots
 * before shared ones, the workspace has no source for yet, else the first
 * (whose source is returned as it is). Null when no bot is available here.
 */
export function chooseSlackSourceTeam(input: {
  localTeamIds: readonly string[];
  sharedTeamIds: readonly string[];
  hasSource: (teamId: string) => boolean;
}): string | null {
  const teams = [...new Set([...input.localTeamIds, ...input.sharedTeamIds])];
  return teams.find((teamId) => !input.hasSource(teamId)) ?? teams[0] ?? null;
}

/** Slack teams of the bots the organization currently shares with the workspace. */
async function sharedSlackTeamIds(
  db: Database,
  scope: { accountId: string; workspaceId: string },
): Promise<string[]> {
  const shares = await sharedOrganizationSlackBots(db, scope);
  const teams = await Promise.all(
    shares
      .filter((share) => share.homeWorkspaceId !== scope.workspaceId)
      .map(async (share) => {
        const row = await getConnectionMetadata(
          db,
          share.homeWorkspaceId,
          share.connectionId,
          null,
        );
        const teamId = row?.accountId === scope.accountId ? row.metadata.slackTeamId : null;
        return typeof teamId === "string" && teamId.length > 0 ? teamId : null;
      }),
  );
  return teams.filter((teamId) => teamId !== null);
}

/**
 * Add the workspace's Slack source, or return the one it has. The bot may be
 * installed here or shared with this workspace by its organization.
 */
export async function createSlackEventSource(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  name?: string | undefined;
}): Promise<EventSourceRecord> {
  const scope = { accountId: input.accountId, workspaceId: input.workspaceId };
  const [bindings, sharedTeamIds] = await Promise.all([
    listSlackInstallationBindings(input.db, scope),
    sharedSlackTeamIds(input.db, scope),
  ]);
  const localTeamIds = bindings
    .filter((entry) => entry.state === "active")
    .map((entry) => entry.slackTeamId);
  const candidates = [...new Set([...localTeamIds, ...sharedTeamIds])];
  const existing = new Set<string>();
  if (candidates.length > 1) {
    for (const teamId of candidates) {
      const found = await findAppEventSource(
        input.db,
        input.workspaceId,
        "slack",
        slackTeamSourceKey(teamId),
      );
      if (found) existing.add(teamId);
    }
  }
  const teamId = chooseSlackSourceTeam({
    localTeamIds,
    sharedTeamIds,
    hasSource: (team) => existing.has(team),
  });
  if (!teamId) {
    throw new HTTPException(422, {
      message: "Connect Slack to this workspace first",
    });
  }
  const { source } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "slack",
    name: input.name ?? "Slack",
    ownerSubjectId: null,
    visibility: "workspace",
    externalKey: slackTeamSourceKey(teamId),
  });
  return source;
}

/**
 * Run `record` for every source, one after another; a failure for one is
 * reported and the others still get theirs.
 */
export async function forEachSlackSource(
  sources: readonly EventSourceRecord[],
  record: (source: EventSourceRecord) => Promise<void>,
  onError: (source: EventSourceRecord, error: unknown) => void,
): Promise<void> {
  for (const source of sources) {
    try {
      await record(source);
    } catch (error) {
      onError(source, error);
    }
  }
}

/** The Slack sources of the other workspaces the bot is currently shared with. */
async function sharedSlackSources(
  db: Database,
  input: {
    accountId: string;
    homeWorkspaceId: string;
    connectionId: string;
    externalKey: string;
  },
): Promise<EventSourceRecord[]> {
  const ids = await sharedSlackEventSourceIds(db, input);
  const sources = await Promise.all(
    ids.map(async (id) => await getEventSource(db, id.workspaceId, id.sourceId)),
  );
  return sources.filter(
    (source): source is EventSourceRecord =>
      source !== null && source.kind === "slack" && source.accountId === input.accountId,
  );
}

/**
 * Record one verified Slack event callback as events of the Slack source of
 * the bot's home workspace, and of every other workspace its organization
 * currently shares the bot with that has one. Only callbacks that become
 * events are kept: direct messages and other callbacks are not stored. A
 * failure for one workspace is logged and never stops the others.
 */
export async function recordSlackEvent(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  /** The bot's home workspace, the one Slack's installation routing names. */
  workspaceId: string;
  connectionId: string;
  teamId: string;
  body: Uint8Array;
  receivedAt?: Date;
}): Promise<void> {
  if (input.settings.eventTriggersEnabled !== true) return;
  const externalKey = slackTeamSourceKey(input.teamId);
  const sources: EventSourceRecord[] = [];
  const home = await findAppEventSource(input.db, input.workspaceId, "slack", externalKey).catch(
    (error: unknown) => {
      logRecordingFailure(input.workspaceId, error);
      return null;
    },
  );
  if (home) sources.push(home);
  const shared = await sharedSlackSources(input.db, {
    accountId: input.accountId,
    homeWorkspaceId: input.workspaceId,
    connectionId: input.connectionId,
    externalKey,
  }).catch((error: unknown) => {
    logRecordingFailure(input.workspaceId, error);
    return [];
  });
  sources.push(...shared.filter((source) => source.workspaceId !== input.workspaceId));
  if (sources.length === 0) return;
  const receivedAt = input.receivedAt ?? new Date();
  const bodySha256 = sha256Hex(input.body);
  await forEachSlackSource(
    sources,
    async (source) => {
      const outcome = readDelivery({
        source,
        settings: input.settings,
        headers: new Headers(),
        body: input.body,
        receivedAt,
        refire: false,
      });
      if (outcome.status !== "accepted") return;
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
    },
    (source, error) => logRecordingFailure(source.workspaceId, error),
  );
}

function logRecordingFailure(workspaceId: string, error: unknown): void {
  console.error("[event-triggers] recording the Slack event failed", {
    workspaceId,
    error: errorMessage(error),
  });
}
