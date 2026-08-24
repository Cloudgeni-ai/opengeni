import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createConnection,
  createDb,
  getOrCreateSlackInteraction,
  getSlackBotUserLink,
  resolveSlackInteractionFirstTaskHint,
  saveSlackBotUserLink,
  type Database,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationUrl = new URL("../drizzle/0327_slack_first_task_hint.sql", import.meta.url);

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0327-slack-first-task-hint");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0327-slack-first-task-hint] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function installation(label: string) {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`Slack hint ${label}`}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`Slack hint ${label}`}) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const connection = await createConnection(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: ["fixture", "ciphertext"].join("-"),
    grantedScopes: ["app_mentions:read", "chat:write", "commands", "im:history"],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: `T_${label}`,
      slackTeamName: "Slack hint database test",
      botId: `B_${label}`,
      botUserId: `U_BOT_${label}`,
      botDisplayName: "OpenGeni",
      verifiedAt: new Date().toISOString(),
    },
  });
  const target = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    connectionId: connection.id,
    slackTeamId: `T_${label}`,
  };
  const link = async (slackUserId: string, subjectId: string) =>
    await saveSlackBotUserLink(db, {
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      slackTeamId: target.slackTeamId,
      slackUserId,
      subjectId,
      linkedBySubjectId: subjectId,
    });
  const interaction = async (slackUserId: string, channel: string) => {
    const created = await getOrCreateSlackInteraction(db, {
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      slackTeamId: target.slackTeamId,
      slackChannelId: channel,
      slackThreadTs: `${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`,
      routeKey: `${channel}:${crypto.randomUUID()}`,
      triggeringProviderEventId: `E_${crypto.randomUUID()}`,
      initiatingSlackUserId: slackUserId,
      owningSubjectId: `user:${slackUserId}`,
      visibility: "workspace",
    });
    return created.interaction;
  };
  return { ...target, link, interaction };
}

describe("migration 0327 Slack first-task hint", () => {
  test("is a rolling additive pair of columns with no RLS-blind backfill", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain('ADD COLUMN "first_task_hint_interaction_id" uuid');
    expect(source).toContain('ADD COLUMN "first_task_hint" boolean');
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/u);
    expect(source).not.toContain("NO FORCE ROW LEVEL SECURITY");
  });

  test("keeps both tables FORCE-RLS and defaults existing rows to unresolved", async () => {
    if (!available) return;
    for (const table of ["slack_bot_user_links", "slack_interactions"]) {
      const [posture] = await shared!.admin<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        select relrowsecurity, relforcerowsecurity
        from pg_class
        where oid = ${table}::regclass`;
      expect(posture).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const columns = await shared!.admin<
      { table_name: string; is_nullable: string; column_default: string | null }[]
    >`
      select table_name, is_nullable, column_default
      from information_schema.columns
      where (table_name = 'slack_bot_user_links' and column_name = 'first_task_hint_interaction_id')
         or (table_name = 'slack_interactions' and column_name = 'first_task_hint')
      order by table_name`;
    expect([...columns]).toEqual([
      { table_name: "slack_bot_user_links", is_nullable: "YES", column_default: null },
      { table_name: "slack_interactions", is_nullable: "YES", column_default: null },
    ]);

    const target = await installation(`unresolved-${Date.now()}`);
    const link = await target.link("U_UNCLAIMED", "user:hint-unclaimed");
    expect(link.firstTaskHintInteractionId).toBeNull();
    const interaction = await target.interaction("U_UNCLAIMED", "D_UNCLAIMED");
    expect(interaction.firstTaskHint).toBeNull();
  });

  test("freezes the decision on the interaction and claims it once per identity", async () => {
    if (!available) return;
    const target = await installation(`claim-${Date.now()}`);
    await target.link("U_FIRST", "user:hint-first");
    await target.link("U_SECOND", "user:hint-second");
    const winner = await target.interaction("U_FIRST", "D_FIRST");
    const later = await target.interaction("U_FIRST", "D_FIRST_LATER");
    const identity = {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      slackUserId: "U_FIRST",
    };

    expect(
      await resolveSlackInteractionFirstTaskHint(db, { ...identity, interactionId: winner.id }),
    ).toBe(true);
    // The winner replays its frozen answer, so a re-rendered acknowledgement
    // produces the same bytes for the digest-bound post ledger.
    expect(
      await resolveSlackInteractionFirstTaskHint(db, { ...identity, interactionId: winner.id }),
    ).toBe(true);
    expect(
      await resolveSlackInteractionFirstTaskHint(db, { ...identity, interactionId: later.id }),
    ).toBe(false);

    // A different Slack identity in the same installation still gets its own.
    const otherFirst = await target.interaction("U_SECOND", "D_SECOND");
    expect(
      await resolveSlackInteractionFirstTaskHint(db, {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        slackUserId: "U_SECOND",
        interactionId: otherFirst.id,
      }),
    ).toBe(true);

    // Unlink plus relink resets the per-identity claim, but it cannot flip an
    // acknowledgement that already rendered: the frozen fact wins.
    await shared!.admin`
      update slack_bot_user_links
      set first_task_hint_interaction_id = null
      where workspace_id = ${target.workspaceId} and slack_user_id = 'U_FIRST'`;
    expect(
      await resolveSlackInteractionFirstTaskHint(db, { ...identity, interactionId: later.id }),
    ).toBe(false);
    expect(
      await resolveSlackInteractionFirstTaskHint(db, { ...identity, interactionId: winner.id }),
    ).toBe(true);
  });

  test("claiming the hint does not look like a re-link", async () => {
    if (!available) return;
    const target = await installation(`audit-${Date.now()}`);
    const link = await target.link("U_AUDIT", "user:hint-audit");
    const interaction = await target.interaction("U_AUDIT", "D_AUDIT");
    expect(
      await resolveSlackInteractionFirstTaskHint(db, {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        slackUserId: "U_AUDIT",
        interactionId: interaction.id,
      }),
    ).toBe(true);
    const claimed = await getSlackBotUserLink(
      db,
      target.workspaceId,
      target.connectionId,
      "U_AUDIT",
    );
    expect(claimed?.firstTaskHintInteractionId).toBe(interaction.id);
    expect(claimed?.updatedAt.getTime()).toBe(link.updatedAt.getTime());
  });

  test("an unlinked identity resolves to no hint without claiming anything", async () => {
    if (!available) return;
    const target = await installation(`absent-${Date.now()}`);
    const interaction = await target.interaction("U_ABSENT", "D_ABSENT");
    expect(
      await resolveSlackInteractionFirstTaskHint(db, {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        slackUserId: "U_ABSENT",
        interactionId: interaction.id,
      }),
    ).toBe(false);
    const [links] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from slack_bot_user_links
      where workspace_id = ${target.workspaceId}`;
    expect(links!.count).toBe(0);
  });

  test("a missing interaction row raises instead of guessing", async () => {
    if (!available) return;
    const target = await installation(`missing-${Date.now()}`);
    await target.link("U_MISSING", "user:hint-missing");
    await expect(
      resolveSlackInteractionFirstTaskHint(db, {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        slackUserId: "U_MISSING",
        interactionId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("durable interaction row");
  });

  test("concurrent resolvers of one interaction all replay the same decision", async () => {
    if (!available) return;
    // The replica race the acknowledgement path actually runs into: two API
    // instances repairing the same acknowledgement at once. They must agree, or
    // the digest-bound post ledger rejects the loser's render.
    const target = await installation(`same-${Date.now()}`);
    await target.link("U_SAME", "user:hint-same");
    const interaction = await target.interaction("U_SAME", "D_SAME");
    const identity = {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      slackUserId: "U_SAME",
    };
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        resolveSlackInteractionFirstTaskHint(db, { ...identity, interactionId: interaction.id }),
      ),
    );
    expect(outcomes).toEqual([true, true, true, true, true, true]);

    // Exactly one claim happened: the identity's slot points at this
    // interaction, and the next interaction for that identity gets nothing.
    const link = await getSlackBotUserLink(db, target.workspaceId, target.connectionId, "U_SAME");
    expect(link?.firstTaskHintInteractionId).toBe(interaction.id);
    const next = await target.interaction("U_SAME", "D_SAME_NEXT");
    expect(
      await resolveSlackInteractionFirstTaskHint(db, { ...identity, interactionId: next.id }),
    ).toBe(false);
  });

  test("concurrent resolvers of distinct interactions elect a single winner", async () => {
    if (!available) return;
    const target = await installation(`race-${Date.now()}`);
    await target.link("U_RACE", "user:hint-race");
    const interactions = await Promise.all(
      Array.from({ length: 6 }, (_, index) => target.interaction("U_RACE", `D_RACE_${index}`)),
    );
    const outcomes = await Promise.all(
      interactions.map((interaction) =>
        resolveSlackInteractionFirstTaskHint(db, {
          workspaceId: target.workspaceId,
          connectionId: target.connectionId,
          slackUserId: "U_RACE",
          interactionId: interaction.id,
        }),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
});
