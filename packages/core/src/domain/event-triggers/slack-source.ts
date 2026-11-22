import type { Settings } from "@opengeni/config";
import {
  availableSlackBotConnectionMetadata,
  createEventSource,
  findAppEventSource,
  getConnectionMetadata,
  listSlackInstallationBindings,
  recordEventDelivery,
  sharedOrganizationSlackBots,
  sharedSlackEventSources,
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

/** Why a Slack source whose bot is no longer shared with its workspace receives nothing. */
export const SLACK_SOURCE_NOT_SHARED_REASON =
  "The Slack bot isn't shared with this workspace anymore";

/**
 * The workspace's sources as people see them: an active Slack source whose
 * team's bot is neither installed here nor shared with this workspace any
 * more receives nothing, so it reads as blocked with that reason. Nothing is
 * stored; sharing the bot again makes it read as active, and receive, again.
 * Reads the workspace's bots only when it has such a source.
 */
export async function withSlackSourceSharing<T extends EventSourceRecord>(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  sources: readonly T[],
): Promise<T[]> {
  const candidates = (source: T) =>
    source.kind === "slack" &&
    source.status === "active" &&
    source.workspaceId === scope.workspaceId &&
    source.externalKey?.startsWith("team:") === true;
  if (!sources.some(candidates)) return [...sources];
  // The bots installed here, in any state, and those shared with it now.
  const bots = await availableSlackBotConnectionMetadata(db, scope);
  const available = new Set(
    bots.flatMap((bot) => {
      const team = (bot.metadata as Record<string, unknown>).slackTeamId;
      return typeof team === "string" && team.length > 0 ? [slackTeamSourceKey(team)] : [];
    }),
  );
  return sources.map((source) =>
    candidates(source) && !available.has(source.externalKey!)
      ? {
          ...source,
          status: "blocked",
          statusReason: SLACK_SOURCE_NOT_SHARED_REASON,
          statusReasonCode: "connector_removed",
          statusReasonDetail: null,
        }
      : source,
  );
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

/** How many shared workspaces' deliveries of one callback are written at once. */
export const SHARED_SLACK_DELIVERY_CONCURRENCY = 4;

/**
 * Run `record` for every source, at most `concurrency` at a time; a failure
 * for one is reported and the others still get theirs.
 */
export async function forEachSlackSource<T>(
  sources: readonly T[],
  record: (source: T) => Promise<void>,
  onError: (source: T, error: unknown) => void,
  concurrency = 1,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < sources.length) {
      const source = sources[next++]!;
      try {
        await record(source);
      } catch (error) {
        onError(source, error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, sources.length)) }, lane),
  );
}

/** A Slack source a callback is recorded into, with what recording needs. */
type SlackDeliveryTarget = {
  accountId: string;
  workspaceId: string;
  sourceId: string;
  status: EventSourceRecord["status"];
  statusReason: string | null;
};

/** The shared workspaces' recordings still running in this process. */
const sharedRecordings = new Set<Promise<void>>();

/**
 * Resolves once every shared workspaces' recording started so far has
 * finished, so shutdown can let them land before the database closes. With
 * `timeoutMs` it stops waiting after that long, so a stuck write can't hold
 * up the rest of shutdown.
 */
export async function settleSlackEventRecordings(timeoutMs?: number): Promise<void> {
  const settled = (async () => {
    while (sharedRecordings.size > 0) await Promise.allSettled([...sharedRecordings]);
  })();
  if (timeoutMs === undefined) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    }),
  ]);
  clearTimeout(timer);
}

/** What recording one callback started: the shared workspaces' part runs on. */
export type SlackEventRecording = {
  /**
   * The deliveries into the other workspaces the bot is shared with. Never
   * rejects; the events receiver acknowledges Slack without waiting for it.
   */
  shared: Promise<void>;
};

/**
 * Record one verified Slack event callback as events of the Slack source of
 * the bot's home workspace, and of every other workspace its organization
 * currently shares the bot with that has one. Only callbacks that become
 * events are kept: direct messages and other callbacks are not stored. A
 * failure for one workspace is logged and never stops the others.
 *
 * The home workspace's delivery is recorded before this returns. The shared
 * workspaces' are found in one statement that returns what recording needs,
 * then written a few at a time in `shared`, so their number never delays the
 * reply to Slack.
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
}): Promise<SlackEventRecording> {
  if (input.settings.eventTriggersEnabled !== true) return { shared: Promise.resolve() };
  const externalKey = slackTeamSourceKey(input.teamId);
  const receivedAt = input.receivedAt ?? new Date();
  const bodySha256 = sha256Hex(input.body);
  const deliver = async (target: SlackDeliveryTarget) => {
    const outcome = readDelivery({
      source: {
        kind: "slack",
        status: target.status,
        statusReason: target.statusReason,
        adapter: null,
        format: null,
      },
      settings: input.settings,
      headers: new Headers(),
      body: input.body,
      receivedAt,
      refire: false,
    });
    if (outcome.status !== "accepted") return;
    const eventId = outcome.events[0]?.externalId;
    await recordEventDelivery(input.db, {
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      sourceId: target.sourceId,
      ...outcome,
      dedupeKey: eventId ? `slack:${eventId}` : `sha256:${bodySha256}`,
      body: input.body,
      bodyBytes: input.body.byteLength,
      bodySha256,
      headers: {},
      match: eventMatchesTrigger,
    });
  };
  const onError = (target: SlackDeliveryTarget, error: unknown) =>
    logRecordingFailure(target.workspaceId, error);

  const home = await findAppEventSource(input.db, input.workspaceId, "slack", externalKey).catch(
    (error: unknown) => {
      logRecordingFailure(input.workspaceId, error);
      return null;
    },
  );
  if (home) {
    await forEachSlackSource(
      [
        {
          accountId: home.accountId,
          workspaceId: home.workspaceId,
          sourceId: home.id,
          status: home.status,
          statusReason: home.statusReason,
        },
      ],
      deliver,
      onError,
    );
  }
  const shared = (async () => {
    const targets = await sharedSlackEventSources(input.db, {
      accountId: input.accountId,
      homeWorkspaceId: input.workspaceId,
      connectionId: input.connectionId,
      externalKey,
    });
    await forEachSlackSource(
      targets
        .filter((target) => target.workspaceId !== input.workspaceId)
        .map((target) => ({ ...target, accountId: input.accountId })),
      deliver,
      onError,
      SHARED_SLACK_DELIVERY_CONCURRENCY,
    );
  })().catch((error: unknown) => logRecordingFailure(input.workspaceId, error));
  sharedRecordings.add(shared);
  void shared.finally(() => sharedRecordings.delete(shared));
  return { shared };
}

function logRecordingFailure(workspaceId: string, error: unknown): void {
  console.error("[event-triggers] recording the Slack event failed", {
    workspaceId,
    error: errorMessage(error),
  });
}
