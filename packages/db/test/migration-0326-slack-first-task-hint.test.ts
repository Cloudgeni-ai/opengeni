import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  claimSlackBotUserLinkFirstTaskHint,
  createConnection,
  createDb,
  getSlackBotUserLink,
  saveSlackBotUserLink,
  type Database,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationUrl = new URL("../drizzle/0326_slack_first_task_hint.sql", import.meta.url);

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0326-slack-first-task-hint");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0326-slack-first-task-hint] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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
  return { accountId: account!.id, workspaceId: workspace!.id, connectionId: connection.id };
}

describe("migration 0326 Slack first-task hint", () => {
  test("is a rolling additive column with no RLS-blind backfill", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain('ADD COLUMN "first_task_hint_interaction_id" uuid');
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/u);
    expect(source).not.toContain("NO FORCE ROW LEVEL SECURITY");
  });

  test("keeps the identity link FORCE-RLS and defaults existing rows to unclaimed", async () => {
    if (!available) return;
    const [posture] = await shared!.admin<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'slack_bot_user_links'::regclass`;
    expect(posture).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const [column] = await shared!.admin<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default
      from information_schema.columns
      where table_name = 'slack_bot_user_links'
        and column_name = 'first_task_hint_interaction_id'`;
    expect(column).toEqual({ is_nullable: "YES", column_default: null });

    const target = await installation(`unclaimed-${Date.now()}`);
    const link = await saveSlackBotUserLink(db, {
      ...target,
      slackTeamId: `T_${target.connectionId.slice(0, 8)}`,
      slackUserId: "U_UNCLAIMED",
      subjectId: "user:hint-unclaimed",
      linkedBySubjectId: "user:hint-unclaimed",
    });
    expect(link.firstTaskHintInteractionId).toBeNull();
  });

  test("claims the hint exactly once and answers idempotently per interaction", async () => {
    if (!available) return;
    const target = await installation(`claim-${Date.now()}`);
    const slackTeamId = `T_${target.connectionId.slice(0, 8)}`;
    await saveSlackBotUserLink(db, {
      ...target,
      slackTeamId,
      slackUserId: "U_FIRST",
      subjectId: "user:hint-first",
      linkedBySubjectId: "user:hint-first",
    });
    await saveSlackBotUserLink(db, {
      ...target,
      slackTeamId,
      slackUserId: "U_SECOND",
      subjectId: "user:hint-second",
      linkedBySubjectId: "user:hint-second",
    });
    const winner = crypto.randomUUID();
    const loser = crypto.randomUUID();
    const identity = {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      slackUserId: "U_FIRST",
    };

    expect(
      await claimSlackBotUserLinkFirstTaskHint(db, { ...identity, interactionId: winner }),
    ).toBe(true);
    // A retry, replica race, or delivery replay of the winning interaction
    // keeps rendering the same acknowledgement bytes.
    expect(
      await claimSlackBotUserLinkFirstTaskHint(db, { ...identity, interactionId: winner }),
    ).toBe(true);
    // Every later task for that identity is silent forever.
    expect(
      await claimSlackBotUserLinkFirstTaskHint(db, { ...identity, interactionId: loser }),
    ).toBe(false);

    // A different Slack identity in the same installation still gets its own.
    expect(
      await claimSlackBotUserLinkFirstTaskHint(db, {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        slackUserId: "U_SECOND",
        interactionId: loser,
      }),
    ).toBe(true);

    // Re-linking the same Slack identity preserves the spent claim.
    await saveSlackBotUserLink(db, {
      ...target,
      slackTeamId,
      slackUserId: "U_FIRST",
      subjectId: "user:hint-first-relinked",
      linkedBySubjectId: "user:hint-first-relinked",
    });
    const relinked = await getSlackBotUserLink(
      db,
      target.workspaceId,
      target.connectionId,
      "U_FIRST",
    );
    expect(relinked?.subjectId).toBe("user:hint-first-relinked");
    expect(relinked?.firstTaskHintInteractionId).toBe(winner);

    // An identity with no link row never claims anything.
    expect(
      await claimSlackBotUserLinkFirstTaskHint(db, {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        slackUserId: "U_ABSENT",
        interactionId: crypto.randomUUID(),
      }),
    ).toBe(false);
  });

  test("concurrent claims for one identity elect a single winner", async () => {
    if (!available) return;
    const target = await installation(`race-${Date.now()}`);
    await saveSlackBotUserLink(db, {
      ...target,
      slackTeamId: `T_${target.connectionId.slice(0, 8)}`,
      slackUserId: "U_RACE",
      subjectId: "user:hint-race",
      linkedBySubjectId: "user:hint-race",
    });
    const identity = {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      slackUserId: "U_RACE",
    };
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        claimSlackBotUserLinkFirstTaskHint(db, {
          ...identity,
          interactionId: crypto.randomUUID(),
        }),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
});
