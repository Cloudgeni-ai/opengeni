import { afterAll, beforeAll, expect, test } from "bun:test";
import { OPENGENI_SLACK_BOT_REQUIRED_SCOPES } from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  createEventSource,
  createWorkspace,
  listEventSources,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  recordSlackEvent,
  SLACK_SOURCE_NOT_SHARED_REASON,
  withSlackSourceSharing,
} from "../src/domain/event-triggers/slack-source";

// One verified Slack callback, recorded into the home workspace's Slack source
// before it returns and into the live-shared workspaces' sources after (real
// PostgreSQL); a workspace the bot is no longer shared with reads as blocked.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-slack-event-source");
  if (!shared && requireRealDatabase) throw new Error("Slack event sources require PostgreSQL");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const teamId = "T0RECORD1";
let eventSequence = 0;

function callback(): Uint8Array {
  eventSequence += 1;
  return new TextEncoder().encode(
    JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      api_app_id: "A_OURS",
      event_id: `EvRecord${eventSequence}`,
      event_time: 1_761_200_000,
      authorizations: [{ team_id: teamId, user_id: "U_BOT", is_bot: true }],
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "Deploy is green",
        ts: `1761200000.00${eventSequence}`,
      },
    }),
  );
}

test("a callback reaches the home and live-shared Slack sources, never the others", async () => {
  if (!shared || !client) return;
  const db = client.db;
  const [account] = await shared.admin`insert into managed_accounts (name)
    values ('Slack recording') returning id`;
  const accountId = String(account!.id);
  const workspace = async (name: string) =>
    ({ accountId, workspaceId: (await createWorkspace(db, { accountId, name })).id }) as const;
  const home = await workspace("Home");
  const target = await workspace("Shared");
  const left = await workspace("Left out");
  const bot = await createConnection(db, {
    ...home,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: "fixture-bot",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: "opengeni_slack_bot",
      credentialLabel: "Opengeni Slack bot",
      slackTeamId: teamId,
      slackTeamName: "Recording fixture",
      botId: "B0RECORD1",
      botUserId: "U0RECORD1",
      botDisplayName: "Opengeni",
      verifiedAt: new Date().toISOString(),
    },
    createdBySubjectId: "user:owner",
  });
  const sources: Record<string, string> = {};
  for (const scope of [home, target, left]) {
    const { source } = await createEventSource(db, {
      ...scope,
      createdBySubjectId: "user:owner",
      kind: "slack",
      name: "Slack",
      ownerSubjectId: null,
      visibility: "workspace",
      externalKey: `team:${teamId}`,
    });
    sources[scope.workspaceId] = source.id;
  }
  await shared.admin`insert into opengeni_private.organization_slack_bot_access(
      connection_id, account_id, home_workspace_id, enabled, generation, workspace_ids,
      updated_by_subject_id)
    values (${bot.id}, ${accountId}, ${home.workspaceId}, true, 1,
      ${[target.workspaceId]}::uuid[], 'user:owner')`;
  const settings = testSettings({ eventTriggersEnabled: true });
  const deliveries = async () => {
    const rows = await shared!.admin<{ source_id: string; count: number }[]>`
      select source_id, count(*)::int as count from event_deliveries
      where account_id = ${accountId} group by source_id`;
    return Object.fromEntries(rows.map((row) => [row.source_id, row.count]));
  };
  const record = async () =>
    await recordSlackEvent({
      db,
      settings,
      accountId,
      workspaceId: home.workspaceId,
      connectionId: bot.id,
      teamId,
      body: callback(),
    });

  // The home source is recorded before the call returns; the shared one after.
  const first = await record();
  expect((await deliveries())[sources[home.workspaceId]!]).toBe(1);
  await first.shared;
  expect(await deliveries()).toEqual({
    [sources[home.workspaceId]!]: 1,
    [sources[target.workspaceId]!]: 1,
  });

  // Only the workspace the bot is shared with reads as active.
  const status = async (scope: { accountId: string; workspaceId: string }) => {
    const [source] = await withSlackSourceSharing(
      db,
      scope,
      await listEventSources(db, scope.workspaceId, null),
    );
    return { status: source!.status, statusReason: source!.statusReason };
  };
  expect(await status(home)).toEqual({ status: "active", statusReason: null });
  expect(await status(target)).toEqual({ status: "active", statusReason: null });
  expect(await status(left)).toEqual({
    status: "blocked",
    statusReason: SLACK_SOURCE_NOT_SHARED_REASON,
  });

  // Revoked: the next callback reaches only the home source, and the shared
  // source says why it hears nothing.
  await shared.admin`update opengeni_private.organization_slack_bot_access
    set enabled = false, generation = generation + 1 where connection_id = ${bot.id}`;
  await (await record()).shared;
  expect(await deliveries()).toEqual({
    [sources[home.workspaceId]!]: 2,
    [sources[target.workspaceId]!]: 1,
  });
  expect(await status(target)).toEqual({
    status: "blocked",
    statusReason: SLACK_SOURCE_NOT_SHARED_REASON,
  });

  // Shared again with every workspace: both receive again.
  await shared.admin`update opengeni_private.organization_slack_bot_access
    set enabled = true, workspace_ids = null, generation = generation + 1
    where connection_id = ${bot.id}`;
  await (await record()).shared;
  expect(await deliveries()).toEqual({
    [sources[home.workspaceId]!]: 3,
    [sources[target.workspaceId]!]: 2,
    [sources[left.workspaceId]!]: 1,
  });
  expect(await status(target)).toEqual({ status: "active", statusReason: null });
}, 120_000);
