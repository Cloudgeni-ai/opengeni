import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  bindSlackInteractionSession,
  claimSlackInteractionInbox,
  createConnection,
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  enqueueSlackInteractionInbox,
  getOrCreateSlackInteraction,
  getSessionForSubject,
  grantWorkspaceAccess,
  listSessionsForSubject,
  releaseSlackInteractionInbox,
  resolveSlackInstallationRoute,
  settleSlackInteractionInbox,
  type Database,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationPath = new URL("../drizzle/0150_slack_task_interactions.sql", import.meta.url)
  .pathname;

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("slack-interactions");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[slack-interactions] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function workspace(label: string) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`Slack interactions ${label}`}) returning id`;
  const [created] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`Slack interactions ${label}`}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${created!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: created!.id };
}

async function member(target: { accountId: string; workspaceId: string }, subjectId: string) {
  await grantWorkspaceAccess(db, {
    ...target,
    subjectId,
    permissions: ["sessions:create", "sessions:read", "sessions:control"],
  });
}

async function botConnection(
  target: { accountId: string; workspaceId: string },
  teamId: string,
  principal: { botId: string; botUserId: string },
) {
  return await createConnection(db, {
    ...target,
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
      slackTeamId: teamId,
      slackTeamName: "Slack interaction database test",
      botId: principal.botId,
      botUserId: principal.botUserId,
      botDisplayName: "OpenGeni",
      verifiedAt: new Date().toISOString(),
    },
  });
}

function inboxInput(input: {
  accountId: string;
  workspaceId: string;
  connectionId: string;
  eventId: string;
  messageId: string;
}) {
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    providerEventId: input.eventId,
    providerMessageId: input.messageId,
    slackTeamId: "T_DB_TEST",
    slackUserId: "U_DB_TEST",
    slackChannelId: "D_DB_TEST",
    slackMessageTs: "1710000000.000001",
    slackThreadTs: null,
    triggerKind: "dm" as const,
    text: "Start a private task",
  };
}

describe("Slack interaction migration and durable database boundary", () => {
  test("declares rolling FORCE-RLS tables and bounded security-definer functions", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(4);
    expect(sql).toContain("slack_interactions_visibility_check");
    expect(sql).toContain("slack_interactions_session_binding_check");
    expect(sql).toContain("slack_interaction_progress_deliveries_slot_uq");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("claim_slack_interaction_delivery");
    expect(sql.match(/\n\s+SECURITY DEFINER\n\s+SET search_path = pg_catalog/g)).toHaveLength(3);
    expect(sql.match(/SET search_path = pg_catalog/g)).toHaveLength(3);
    expect(sql).toContain("credentialRole' = 'opengeni_slack_bot'");
  });

  test("enforces FORCE RLS and grants only the declared runtime DML", async () => {
    if (!available) return;
    const rows = await admin<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
      }[]
    >`
      select
        C.relname,
        C.relrowsecurity,
        C.relforcerowsecurity,
        has_table_privilege('opengeni_app', C.oid, 'select') as can_select,
        has_table_privilege('opengeni_app', C.oid, 'insert') as can_insert,
        has_table_privilege('opengeni_app', C.oid, 'update') as can_update,
        has_table_privilege('opengeni_app', C.oid, 'delete') as can_delete,
        has_table_privilege('opengeni_app', C.oid, 'truncate') as can_truncate
      from pg_class C
      where C.oid in (
        'slack_bot_user_links'::regclass,
        'slack_interaction_inbox'::regclass,
        'slack_interactions'::regclass,
        'slack_interaction_progress_deliveries'::regclass
      )
      order by C.relname`;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: true,
        can_truncate: false,
      });
    }
  });

  test("collapses one Slack principal deterministically and fails closed on tenant ambiguity", async () => {
    if (!available) return;
    const first = await workspace("resolver-a");
    const original = await botConnection(first, "T_RESOLVER", {
      botId: "B_RESOLVER",
      botUserId: "U_RESOLVER_BOT",
    });
    const duplicate = await botConnection(first, "T_RESOLVER", {
      botId: "B_RESOLVER",
      botUserId: "U_RESOLVER_BOT",
    });
    expect((await resolveSlackInstallationRoute(db, "T_RESOLVER"))?.connectionId).toBe(
      duplicate.id,
    );
    expect(duplicate.id).not.toBe(original.id);

    const second = await workspace("resolver-b");
    await botConnection(second, "T_RESOLVER", {
      botId: "B_OTHER",
      botUserId: "U_OTHER_BOT",
    });
    expect(await resolveSlackInstallationRoute(db, "T_RESOLVER")).toBeNull();
  });

  test("deduplicates event and message identities, reclaims expired leases, and scopes settlement", async () => {
    if (!available) return;
    const target = await workspace("inbox");
    const connection = await botConnection(target, "T_INBOX", {
      botId: "B_INBOX",
      botUserId: "U_INBOX_BOT",
    });
    const first = await enqueueSlackInteractionInbox(
      db,
      inboxInput({ ...target, connectionId: connection.id, eventId: "E1", messageId: "M1" }),
    );
    expect(first.inserted).toBe(true);
    const eventRetry = await enqueueSlackInteractionInbox(
      db,
      inboxInput({ ...target, connectionId: connection.id, eventId: "E1", messageId: "M2" }),
    );
    const reconnectRetry = await enqueueSlackInteractionInbox(
      db,
      inboxInput({ ...target, connectionId: connection.id, eventId: "E2", messageId: "M1" }),
    );
    expect(eventRetry).toMatchObject({ inserted: false, entry: { id: first.entry.id } });
    expect(reconnectRetry).toMatchObject({ inserted: false, entry: { id: first.entry.id } });

    const holderA = crypto.randomUUID();
    const claimed = await claimSlackInteractionInbox(db, holderA, 1_000);
    expect(claimed?.id).toBe(first.entry.id);
    await admin`
      update slack_interaction_inbox
      set claim_expires_at = now() - interval '1 second'
      where id = ${first.entry.id}`;
    const holderB = crypto.randomUUID();
    const reclaimed = await claimSlackInteractionInbox(db, holderB, 1_000);
    expect(reclaimed).toMatchObject({ id: first.entry.id, attemptCount: 2 });

    const other = await workspace("inbox-other");
    expect(
      await settleSlackInteractionInbox(db, {
        entry: { id: first.entry.id, ...other },
        claimHolderId: holderB,
        outcome: "processed",
      }),
    ).toBe(false);
    expect(
      await releaseSlackInteractionInbox(db, {
        entry: reclaimed!,
        claimHolderId: holderB,
        errorCode: "retryable_test",
        retryAt: new Date(Date.now() + 1_000),
      }),
    ).toBe(true);
    expect(await claimSlackInteractionInbox(db, crypto.randomUUID(), 1_000)).toBeNull();
    await admin`
      update slack_interaction_inbox
      set retry_at = now() - interval '1 second'
      where id = ${first.entry.id}`;
    expect(await claimSlackInteractionInbox(db, crypto.randomUUID(), 1_000)).toMatchObject({
      id: first.entry.id,
      attemptCount: 3,
    });
  });

  test("binds one route to one session and keeps a private root lineage owner-only", async () => {
    if (!available) return;
    const target = await workspace("private");
    const owner = "user:slack-private-owner";
    const other = "user:slack-private-other";
    await member(target, owner);
    await member(target, other);
    const connection = await botConnection(target, "T_PRIVATE", {
      botId: "B_PRIVATE",
      botUserId: "U_PRIVATE_BOT",
    });
    const { interaction } = await getOrCreateSlackInteraction(db, {
      ...target,
      connectionId: connection.id,
      slackTeamId: "T_PRIVATE",
      slackChannelId: "D_PRIVATE",
      slackThreadTs: "1710000000.000010",
      routeKey: "D_PRIVATE:1710000000.000010",
      triggeringProviderEventId: "E_PRIVATE",
      owningSubjectId: owner,
      visibility: "private",
    });
    const root = await createSession(db, {
      ...target,
      requestedSessionId: interaction.sessionReservationId,
      initialMessage: "private root",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: owner },
      model: "test-model",
      sandboxBackend: "none",
    });
    const child = await createSession(db, {
      ...target,
      initialMessage: "private child",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: owner },
      model: "test-model",
      sandboxBackend: "none",
      parentSessionId: root.id,
    });
    expect(
      await bindSlackInteractionSession(db, {
        ...interaction,
        owningSubjectId: owner,
        sessionId: root.id,
      }),
    ).toMatchObject({ sessionId: root.id, visibility: "private" });

    const ownerList = await listSessionsForSubject(db, target.workspaceId, {
      subjectId: owner,
      limit: 50,
    });
    expect(ownerList.sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([root.id, child.id]),
    );
    const otherList = await listSessionsForSubject(db, target.workspaceId, {
      subjectId: other,
      limit: 50,
    });
    expect(otherList.sessions.map((session) => session.id)).not.toContain(root.id);
    expect(otherList.sessions.map((session) => session.id)).not.toContain(child.id);
    expect(await getSessionForSubject(db, target.workspaceId, root.id, other)).toBeNull();
    expect(await getSessionForSubject(db, target.workspaceId, child.id, other)).toBeNull();
    expect(await getSessionForSubject(db, target.workspaceId, child.id, owner)).not.toBeNull();
  });

  test("keeps a reserved private session unreadable before, during, and after bind across crash retry", async () => {
    if (!available) return;
    const target = await workspace("private-atomic");
    const owner = `user:slack-atomic-owner-${crypto.randomUUID()}`;
    const other = `user:slack-atomic-other-${crypto.randomUUID()}`;
    await member(target, owner);
    await member(target, other);
    const connection = await botConnection(target, "T_PRIVATE_ATOMIC", {
      botId: "B_PRIVATE_ATOMIC",
      botUserId: "U_PRIVATE_ATOMIC_BOT",
    });
    const { interaction } = await getOrCreateSlackInteraction(db, {
      ...target,
      connectionId: connection.id,
      slackTeamId: "T_PRIVATE_ATOMIC",
      slackChannelId: "D_PRIVATE_ATOMIC",
      slackThreadTs: "1710000000.000020",
      routeKey: "D_PRIVATE_ATOMIC:1710000000.000020",
      triggeringProviderEventId: "E_PRIVATE_ATOMIC",
      owningSubjectId: owner,
      visibility: "private",
    });
    const createInput = {
      ...target,
      requestedSessionId: interaction.sessionReservationId,
      createIdempotencyKey: `slack-private-atomic:${interaction.id}`,
      initialMessage: "private root with a durable reservation",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId: owner },
      model: "test-model",
      sandboxBackend: "none" as const,
    };
    const created = await createSessionWithIdempotencyKeyResult(db, createInput);
    expect(created).toMatchObject({ created: true, denied: false });
    if (created.denied) throw new Error("private session create unexpectedly denied");
    expect(created.session.id).toBe(interaction.sessionReservationId);

    const expectPrivate = async () => {
      const ownerList = await listSessionsForSubject(db, target.workspaceId, {
        subjectId: owner,
        limit: 50,
      });
      const otherList = await listSessionsForSubject(db, target.workspaceId, {
        subjectId: other,
        limit: 50,
      });
      expect(ownerList.sessions.map((session) => session.id)).toContain(created.session.id);
      expect(otherList.sessions.map((session) => session.id)).not.toContain(created.session.id);
      expect(
        await getSessionForSubject(db, target.workspaceId, created.session.id, other),
      ).toBeNull();
      expect(
        await getSessionForSubject(db, target.workspaceId, created.session.id, owner),
      ).not.toBeNull();
    };

    // Simulated process death after the session commit but before final binding.
    await expectPrivate();
    const replay = await createSessionWithIdempotencyKeyResult(db, createInput);
    expect(replay).toMatchObject({ created: false, denied: false });
    if (replay.denied) throw new Error("private session replay unexpectedly denied");
    expect(replay.session.id).toBe(created.session.id);
    await expectPrivate();

    let releaseBindLock!: () => void;
    let markBindLockReady!: () => void;
    const bindLockReady = new Promise<void>((resolve) => {
      markBindLockReady = resolve;
    });
    const bindLockGate = new Promise<void>((resolve) => {
      releaseBindLock = resolve;
    });
    const lockTransaction = admin.begin(async (tx) => {
      await tx`select id from slack_interactions where id = ${interaction.id} for update`;
      markBindLockReady();
      await bindLockGate;
    });
    await bindLockReady;
    let bindSettled = false;
    const binding = bindSlackInteractionSession(db, {
      ...interaction,
      owningSubjectId: owner,
      sessionId: created.session.id,
    }).finally(() => {
      bindSettled = true;
    });
    await Bun.sleep(25);
    expect(bindSettled).toBe(false);
    await expectPrivate();
    releaseBindLock();
    await lockTransaction;
    expect(await binding).toMatchObject({ sessionId: created.session.id, visibility: "private" });
    await expectPrivate();
  }, 60_000);
});
