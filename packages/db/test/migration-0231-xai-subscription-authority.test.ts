import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  acquireXaiCredentialLease,
  armXaiCapacityWaiter,
  createDb,
  createXaiSubscriptionCredential,
  disconnectXaiSubscriptionCredential,
  getXaiCapacityWaiter,
  getXaiSessionAccountPin,
  listXaiSubscriptionAccountsMetadata,
  materializeXaiCredentialForRun,
  nestedPostgresSqlState,
  observeXaiCapacityWaiter,
  recordXaiSessionLastAccount,
  releaseXaiCredentialLease,
  setXaiSessionAccountPin,
  settleXaiCapacityWaiter,
  updateXaiQuotaMetadata,
  wakeXaiCapacityWaiters,
  withSessionActivityRlsContext,
  type DbClient,
} from "../src";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0231_xai_subscription_authority.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_XAI_POSTGRES_ADMIN_URL?.trim();
const externalAppUrl = process.env.OPENGENI_XAI_POSTGRES_APP_URL?.trim();
const encryptionKey = Buffer.alloc(32, 23);
const workspaceSnapshot = { version: 1, scope: "workspace" } as const;
const xaiTables = [
  "xai_subscription_credentials",
  "xai_rotation_settings",
  "xai_credential_leases",
  "xai_session_account_pins",
  "xai_capacity_waiters",
] as const;
const xaiRoutines = [
  "create_xai_subscription_credential(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone)",
  "disconnect_xai_subscription_credential(uuid, uuid, text, uuid, jsonb)",
  "resolve_xai_authority_pool(uuid, uuid, text, jsonb)",
  "revalidate_xai_subscription_authority(uuid, text, uuid, jsonb)",
  "xai_provider_account_authority_snapshot_v1_valid(jsonb)",
  "xai_subscription_authority_live(uuid, uuid, text, uuid, text, uuid, uuid, bigint)",
  "xai_subscription_pool_visible(uuid, uuid, text, text, uuid)",
] as const;

let migration = "";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type WorkspaceFixture = {
  accountId: string;
  workspaceId: string;
  subjects: string[];
};

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function seedWorkspace(subjectCount = 1): Promise<WorkspaceFixture> {
  if (!shared) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name)
    values (${`xai-authority-${suffix}`})
    returning id`;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`xai-workspace-${suffix}`})
    returning id`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;

  const subjects: string[] = [];
  for (let index = 0; index < subjectCount; index += 1) {
    const subjectId = `user:xai-${index}-${crypto.randomUUID()}`;
    subjects.push(subjectId);
    const [personalWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (
        account_id, name, external_source, external_id
      ) values (
        ${account!.id}, ${`personal-${index}-${suffix}`},
        'opengeni:organization-membership',
        ${`${account!.id}:${subjectId}`}
      ) returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${personalWorkspace!.id}, ${account!.id})`;
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, ${subjectId},
        ${index === 0 ? "owner" : "member"}, '[]'::jsonb
      )`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (
        ${account!.id}, ${subjectId}, 'active', ${personalWorkspace!.id}
      )`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id, subjects };
}

async function seedSessionTurn(
  fixture: WorkspaceFixture,
  authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1 = workspaceSnapshot,
  executionGeneration = 1,
): Promise<{ sessionId: string; turnId: string }> {
  if (!shared) throw new Error("test database unavailable");
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const workflowId = `xai-${sessionId}`;
  await withSessionActivityRlsContext(
    client!.db,
    { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
    async (tx) => {
      await tx.execute(sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id, status, temporal_workflow_id,
          tool_policy
        ) values (
          ${sessionId}, ${fixture.accountId}, ${fixture.workspaceId},
          'xAI persistence fixture', 'test-model', 'none', ${sessionId},
          'running', ${workflowId},
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
        )`);
      await tx.execute(sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation,
          xai_provider_account_authority_snapshot
        ) values (
          ${turnId}, ${fixture.accountId}, ${fixture.workspaceId}, ${sessionId},
          ${crypto.randomUUID()}, ${workflowId}, 'running', 'user', 1,
          'xAI persistence fixture', 'test-model', 'medium', 'none',
          ${executionGeneration}, ${JSON.stringify(authoritySnapshot)}::jsonb
        )`);
      await tx.execute(sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`);
    },
  );
  return { sessionId, turnId };
}

beforeAll(async () => {
  migration = await readFile(migrationPath, "utf8");
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error("set both OPENGENI_XAI_POSTGRES_ADMIN_URL and OPENGENI_XAI_POSTGRES_APP_URL");
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 8, prepare: false });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0231-xai-authority");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0231-xai-authority] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 12 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0231 xAI subscription authority", () => {
  test("is rolling, identifier-free, FORCE-RLS, and preserves the Codex boundary", () => {
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of xaiTables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
    expect(migration).toContain("\"authority_scope\" IN ('workspace', 'user')");
    expect(migration).toContain("authority.resource_kind = 'xai_subscription'");
    expect(migration).toContain("authority.status = 'active'");
    expect(migration).toContain("membership.status = 'active'");
    expect(migration).toContain("active workspace grant required");
    expect(migration).toContain("NULLS NOT DISTINCT");
    expect(migration).toContain("connected_by_subject_id");
    expect(migration).toContain("audit attribution only; never ownership");
    expect(migration).toContain("has_codex_snapshot");
    expect(migration).toContain("codex_provider_account_authority_snapshot jsonb");
    expect(migration).not.toMatch(/codex_apps|reset_credit|reset_redemption/iu);

    const snapshotSection = migration.slice(
      migration.indexOf("xai_provider_account_authority_snapshot_v1_valid"),
      migration.indexOf("-- Exact-subject RLS"),
    );
    for (const forbidden of [
      "subjectId",
      "membershipId",
      "credentialId",
      "providerAccountId",
      '"label"',
      '"quota"',
      '"token"',
      '"plan"',
    ]) {
      expect(snapshotSection).not.toContain(forbidden);
    }
  });

  test("creates workspace/user accounts through the narrow lifecycle and keeps metadata secret-free", async () => {
    if (!shared || !client) return;
    const fixture = await seedWorkspace(2);
    const [alice, bob] = fixture.subjects as [string, string];
    await expect(
      createXaiSubscriptionCredential(client.db, {
        ...fixture,
        subjectId: `user:ungranted-${crypto.randomUUID()}`,
        secret: { version: 1, accessToken: "denied-secret" },
        encryptionKey,
        providerAccountId: `denied-${crypto.randomUUID()}`,
        label: "Denied xAI",
      }),
    ).rejects.toThrow();
    const workspaceAccount = await createXaiSubscriptionCredential(client.db, {
      ...fixture,
      subjectId: alice,
      secret: { version: 1, accessToken: "workspace-access-secret" },
      encryptionKey,
      providerAccountId: `workspace-${crypto.randomUUID()}`,
      label: "Workspace xAI",
    });
    const userAccount = await createXaiSubscriptionCredential(client.db, {
      ...fixture,
      subjectId: alice,
      scope: "user",
      secret: { version: 1, refreshToken: "alice-refresh-secret" },
      encryptionKey,
      providerAccountId: `alice-${crypto.randomUUID()}`,
      label: "Alice xAI",
    });

    expect(workspaceAccount.authoritySnapshot).toEqual(workspaceSnapshot);
    expect(userAccount.authoritySnapshot).toEqual({
      version: 1,
      scope: "user",
      authorityGeneration: 1,
    });
    expect(JSON.stringify({ workspaceAccount, userAccount })).not.toContain("secret");

    const aliceAccounts = await listXaiSubscriptionAccountsMetadata(client.db, {
      workspaceId: fixture.workspaceId,
      subjectId: alice,
    });
    const bobAccounts = await listXaiSubscriptionAccountsMetadata(client.db, {
      workspaceId: fixture.workspaceId,
      subjectId: bob,
    });
    expect(aliceAccounts.map((account) => account.id).sort()).toEqual(
      [workspaceAccount.account.id, userAccount.account.id].sort(),
    );
    expect(bobAccounts.map((account) => account.id)).toEqual([workspaceAccount.account.id]);
    expect(JSON.stringify(aliceAccounts)).not.toContain("alice-refresh-secret");

    const [stored] = await shared.admin<
      {
        encrypted: string;
        connectedBy: string | null;
        authorityCount: number;
      }[]
    >`
      select credential.credential_encrypted as encrypted,
        credential.connected_by_subject_id as "connectedBy",
        (
          select count(*)::int
          from organization_user_resource_authorities authority
          where authority.account_id = credential.account_id
            and authority.organization_membership_id =
              credential.owner_organization_membership_id
            and authority.resource_kind = 'xai_subscription'
            and authority.resource_id = credential.id
            and authority.generation =
              credential.organization_user_resource_authority_generation
        ) as "authorityCount"
      from xai_subscription_credentials credential
      where credential.id = ${userAccount.account.id}`;
    expect(stored?.encrypted.startsWith("v2:")).toBe(true);
    expect(stored?.encrypted).not.toContain("alice-refresh-secret");
    expect(stored).toMatchObject({ connectedBy: alice, authorityCount: 1 });

    const materialized = await materializeXaiCredentialForRun(client.db, {
      workspaceId: fixture.workspaceId,
      subjectId: alice,
      credentialId: userAccount.account.id,
      authoritySnapshot: userAccount.authoritySnapshot,
      encryptionKey,
    });
    expect(materialized.secret).toEqual({ version: 1, refreshToken: "alice-refresh-secret" });
    await expect(
      materializeXaiCredentialForRun(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: bob,
        credentialId: userAccount.account.id,
        authoritySnapshot: userAccount.authoritySnapshot,
        encryptionKey,
      }),
    ).rejects.toThrow("xAI provider-account authority is no longer active");

    await shared.admin`
      update organization_memberships
      set status = 'suspended', updated_at = now()
      where account_id = ${fixture.accountId} and subject_id = ${alice}`;
    await expect(
      materializeXaiCredentialForRun(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: alice,
        credentialId: userAccount.account.id,
        authoritySnapshot: userAccount.authoritySnapshot,
        encryptionKey,
      }),
    ).rejects.toThrow("xAI provider-account authority is no longer active");
    await shared.admin`
      update organization_memberships
      set status = 'active', updated_at = now()
      where account_id = ${fixture.accountId} and subject_id = ${alice}`;

    expect(
      await disconnectXaiSubscriptionCredential(client.db, {
        ...fixture,
        subjectId: alice,
        credentialId: userAccount.account.id,
        authoritySnapshot: userAccount.authoritySnapshot,
      }),
    ).toBe(true);
    const [revoked] = await shared.admin<{ status: string; revokedAt: Date | null }[]>`
      select status, revoked_at as "revokedAt"
      from organization_user_resource_authorities
      where resource_kind = 'xai_subscription'
        and resource_id = ${userAccount.account.id}`;
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
  }, 180_000);

  test("persists quota metadata and excludes credentials during cooldown", async () => {
    if (!shared || !client) return;
    const fixture = await seedWorkspace();
    const [subjectId] = fixture.subjects;
    const accounts = await Promise.all(
      ["cooling", "available"].map(
        async (label) =>
          await createXaiSubscriptionCredential(client!.db, {
            ...fixture,
            subjectId: subjectId!,
            secret: { version: 1, accessToken: `${label}-secret` },
            encryptionKey,
            providerAccountId: `${label}-${crypto.randomUUID()}`,
            label,
          }),
      ),
    );
    const cooling = accounts[0]!.account;
    const available = accounts[1]!.account;
    const checkedAt = new Date();
    const resetAt = new Date(checkedAt.getTime() + 60_000);
    expect(
      await updateXaiQuotaMetadata(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        credentialId: cooling.id,
        quotaUsedPercent: 100,
        quotaResetAt: resetAt,
        quotaCheckedAt: checkedAt,
        exhaustedUntil: resetAt,
      }),
    ).toBe(true);

    const firstTurn = await seedSessionTurn(fixture);
    const firstLease = await acquireXaiCredentialLease(client.db, {
      ...fixture,
      subjectId: subjectId!,
      turnId: firstTurn.turnId,
      holderId: "holder:quota-cooldown",
      authoritySnapshot: workspaceSnapshot,
      now: checkedAt,
    });
    expect(firstLease.credentialId).toBe(available.id);
    expect(firstLease.accounts.find((account) => account.id === cooling.id)).toMatchObject({
      quotaUsedPercent: 100,
      quotaResetAt: resetAt,
      exhaustedUntil: resetAt,
    });
    expect(
      await releaseXaiCredentialLease(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        turnId: firstTurn.turnId,
        holderId: "holder:quota-cooldown",
        generation: 1,
      }),
    ).toBe(true);

    const recoveredAt = new Date(resetAt.getTime() + 1);
    expect(
      await updateXaiQuotaMetadata(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        credentialId: cooling.id,
        quotaUsedPercent: 5,
        quotaResetAt: null,
        quotaCheckedAt: recoveredAt,
        exhaustedUntil: null,
      }),
    ).toBe(true);
    const secondTurn = await seedSessionTurn(fixture);
    const recoveredLease = await acquireXaiCredentialLease(client.db, {
      ...fixture,
      subjectId: subjectId!,
      turnId: secondTurn.turnId,
      holderId: "holder:quota-recovered",
      authoritySnapshot: workspaceSnapshot,
      now: recoveredAt,
    });
    expect(recoveredLease.credentialId).toBe(cooling.id);
  }, 180_000);

  test("allocates fairly with exact-turn reuse, session pins, cooldowns, and lease exclusion", async () => {
    if (!shared || !client) return;
    const fixture = await seedWorkspace();
    const [subjectId] = fixture.subjects;
    const accounts = await Promise.all(
      ["first", "second"].map(
        async (label) =>
          await createXaiSubscriptionCredential(client!.db, {
            ...fixture,
            subjectId: subjectId!,
            secret: { version: 1, accessToken: `${label}-secret` },
            encryptionKey,
            providerAccountId: `${label}-${crypto.randomUUID()}`,
            label,
          }),
      ),
    );
    const firstTurn = await seedSessionTurn(fixture);
    const secondTurn = await seedSessionTurn(fixture);
    const thirdTurn = await seedSessionTurn(fixture);

    const firstLease = await acquireXaiCredentialLease(client.db, {
      ...fixture,
      subjectId: subjectId!,
      turnId: firstTurn.turnId,
      holderId: "holder:first",
      authoritySnapshot: workspaceSnapshot,
    });
    expect(firstLease.credentialId).not.toBeNull();
    const retriedFirst = await acquireXaiCredentialLease(client.db, {
      ...fixture,
      subjectId: subjectId!,
      turnId: firstTurn.turnId,
      holderId: "holder:first-retry",
      authoritySnapshot: workspaceSnapshot,
    });
    expect(retriedFirst).toMatchObject({
      credentialId: firstLease.credentialId,
      reused: true,
      generation: 2,
    });

    const secondLease = await acquireXaiCredentialLease(client.db, {
      ...fixture,
      subjectId: subjectId!,
      turnId: secondTurn.turnId,
      holderId: "holder:second",
      authoritySnapshot: workspaceSnapshot,
    });
    expect(secondLease.credentialId).not.toBe(firstLease.credentialId);
    expect(new Set([firstLease.credentialId, secondLease.credentialId])).toEqual(
      new Set(accounts.map((account) => account.account.id)),
    );

    const unavailable = await acquireXaiCredentialLease(client.db, {
      ...fixture,
      subjectId: subjectId!,
      turnId: thirdTurn.turnId,
      holderId: "holder:third",
      authoritySnapshot: workspaceSnapshot,
    });
    expect(unavailable).toMatchObject({ credentialId: null, reused: false });
    expect(
      await releaseXaiCredentialLease(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        turnId: firstTurn.turnId,
        holderId: "holder:first",
        generation: 1,
      }),
    ).toBe(false);
    expect(
      await releaseXaiCredentialLease(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        turnId: firstTurn.turnId,
        holderId: "holder:first-retry",
        generation: 2,
      }),
    ).toBe(true);

    const pin = await setXaiSessionAccountPin(client.db, {
      ...fixture,
      subjectId: subjectId!,
      sessionId: thirdTurn.sessionId,
      authoritySnapshot: workspaceSnapshot,
      credentialId: firstLease.credentialId,
      pinSource: "manual",
    });
    expect(pin.pinnedCredentialId).toBe(firstLease.credentialId);
    expect(
      await getXaiSessionAccountPin(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        sessionId: thirdTurn.sessionId,
        authoritySnapshot: workspaceSnapshot,
      }),
    ).toMatchObject({ pinnedCredentialId: firstLease.credentialId, pinSource: "manual" });
    const pinnedLease = await acquireXaiCredentialLease(client.db, {
      ...fixture,
      subjectId: subjectId!,
      turnId: thirdTurn.turnId,
      holderId: "holder:pinned",
      authoritySnapshot: workspaceSnapshot,
      pinnedCredentialId: firstLease.credentialId,
    });
    expect(pinnedLease.credentialId).toBe(firstLease.credentialId);
    const recorded = await recordXaiSessionLastAccount(client.db, {
      ...fixture,
      subjectId: subjectId!,
      sessionId: thirdTurn.sessionId,
      authoritySnapshot: workspaceSnapshot,
      credentialId: firstLease.credentialId!,
    });
    expect(recorded.lastCredentialId).toBe(firstLease.credentialId);

    const mismatchedTurn = await seedSessionTurn(fixture, {
      version: 1,
      scope: "user",
      authorityGeneration: 1,
    });
    await expect(
      acquireXaiCredentialLease(client.db, {
        ...fixture,
        subjectId: subjectId!,
        turnId: mismatchedTurn.turnId,
        holderId: "holder:mismatch",
        authoritySnapshot: workspaceSnapshot,
      }),
    ).rejects.toThrow("xAI logical turn authority snapshot is unavailable");
  }, 180_000);

  test("persists pool-scoped capacity waiters and immutable accepted-work snapshots", async () => {
    if (!shared || !client) return;
    const fixture = await seedWorkspace();
    const [subjectId] = fixture.subjects;
    const turn = await seedSessionTurn(fixture, workspaceSnapshot, 3);
    const waiter = await armXaiCapacityWaiter(client.db, {
      ...fixture,
      subjectId: subjectId!,
      sessionId: turn.sessionId,
      blockedTurnId: turn.turnId,
      blockedTurnGeneration: 3,
      workflowId: `workflow:${turn.sessionId}`,
      authoritySnapshot: workspaceSnapshot,
      earliestResetAt: new Date(Date.now() + 30_000),
      nextCheckAt: new Date(Date.now() + 5_000),
    });
    expect(waiter).toMatchObject({ status: "waiting", generation: 1, wakeRevision: 1 });
    expect(
      await getXaiCapacityWaiter(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        sessionId: turn.sessionId,
        authoritySnapshot: workspaceSnapshot,
      }),
    ).toMatchObject({ id: waiter.id, generation: 1 });
    expect(
      await wakeXaiCapacityWaiters(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        authoritySnapshot: workspaceSnapshot,
        reason: "quota_reset_observed",
      }),
    ).toBe(1);
    const woken = await getXaiCapacityWaiter(client.db, {
      workspaceId: fixture.workspaceId,
      subjectId: subjectId!,
      sessionId: turn.sessionId,
      authoritySnapshot: workspaceSnapshot,
    });
    expect(woken?.wakeRevision).toBe(2);
    expect(
      await observeXaiCapacityWaiter(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        waiterId: waiter.id,
        generation: 1,
        observedWakeRevision: 2,
        authoritySnapshot: workspaceSnapshot,
      }),
    ).toMatchObject({ observedWakeRevision: 2 });
    expect(
      await settleXaiCapacityWaiter(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        waiterId: waiter.id,
        generation: 1,
        status: "resumed",
        reason: "credential_available",
        authoritySnapshot: workspaceSnapshot,
      }),
    ).toMatchObject({ status: "resumed", lastWakeReason: "credential_available" });
    expect(
      await settleXaiCapacityWaiter(client.db, {
        workspaceId: fixture.workspaceId,
        subjectId: subjectId!,
        waiterId: waiter.id,
        generation: 1,
        status: "superseded",
        reason: "stale",
        authoritySnapshot: workspaceSnapshot,
      }),
    ).toBeNull();

    await expect(
      armXaiCapacityWaiter(client.db, {
        ...fixture,
        subjectId: subjectId!,
        sessionId: turn.sessionId,
        blockedTurnId: turn.turnId,
        blockedTurnGeneration: 3,
        workflowId: `workflow:${turn.sessionId}`,
        authoritySnapshot: { version: 1, scope: "user", authorityGeneration: 1 },
        earliestResetAt: null,
        nextCheckAt: new Date(),
      }),
    ).rejects.toThrow("xAI logical turn authority snapshot is unavailable");

    await expectSqlState(
      () =>
        shared!.admin`
          update session_turns
          set xai_provider_account_authority_snapshot =
            ${shared!.admin.json({ version: 1, scope: "user", authorityGeneration: 1 })}
          where id = ${turn.turnId}`,
      "23514",
    );

    const source = await seedSessionTurn(fixture);
    const target = await seedSessionTurn(fixture);
    const outboxSnapshot = { version: 1, scope: "user", authorityGeneration: 7 } as const;
    await shared.admin`
      insert into session_system_update_outbox (
        account_id, workspace_id, source_session_id, target_session_id,
        dedupe_key, kind, classification, source_id, summary, payload,
        lineage, personal_connection_delegations,
        xai_provider_account_authority_snapshot
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${source.sessionId},
        ${target.sessionId}, ${`xai-outbox-${crypto.randomUUID()}`},
        'child_terminal_result', 'info', 'xai-test', 'xAI child result',
        '{"type":"child_terminal_result"}'::jsonb, '{}'::jsonb, '[]'::jsonb,
        ${shared.admin.json(outboxSnapshot)}
      )`;
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      const [claimed] = await app<
        { xai_provider_account_authority_snapshot: typeof outboxSnapshot }[]
      >`select * from opengeni_private.claim_session_system_update_outbox(1)`;
      expect(claimed?.xai_provider_account_authority_snapshot).toEqual(outboxSnapshot);
    } finally {
      await app.end();
    }
  }, 180_000);

  test("records exact native PostgreSQL RLS, ACL, owner, and search-path posture", async () => {
    if (!shared) return;
    const snapshotColumns = await shared.admin<
      { tableName: string; nullable: string; columnDefault: string | null }[]
    >`
      select table_name as "tableName", is_nullable as nullable,
        column_default as "columnDefault"
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = any(array[
          'session_turns', 'scheduled_tasks', 'session_system_updates',
          'session_system_update_outbox'
        ]::text[])
        and column_name = 'xai_provider_account_authority_snapshot'
      order by table_name`;
    expect(snapshotColumns).toHaveLength(4);
    for (const column of snapshotColumns) {
      expect(column.nullable).toBe("NO");
      expect(column.columnDefault).toContain('"scope": "workspace"');
    }
    const [snapshotTriggers] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = current_schema()
        and trigger.tgname = any(array[
          'session_turns_xai_authority_snapshot_immutable_trg',
          'scheduled_tasks_xai_authority_snapshot_immutable_trg',
          'session_system_updates_xai_authority_snapshot_immutable_trg',
          'system_update_outbox_xai_snapshot_immutable_trg'
        ]::text[])
        and not trigger.tgisinternal`;
    expect(snapshotTriggers?.count).toBe(4);

    const tableRows = await shared.admin<
      {
        name: string;
        rls: boolean;
        forceRls: boolean;
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }[]
    >`
      select c.relname as name, c.relrowsecurity as rls,
        c.relforcerowsecurity as "forceRls",
        has_table_privilege('opengeni_app', c.oid, 'SELECT') as select,
        has_table_privilege('opengeni_app', c.oid, 'INSERT') as insert,
        has_table_privilege('opengeni_app', c.oid, 'UPDATE') as update,
        has_table_privilege('opengeni_app', c.oid, 'DELETE') as delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = any(${shared.admin.array([...xaiTables])})
      order by c.relname`;
    expect(tableRows).toHaveLength(xaiTables.length);
    for (const row of tableRows) {
      expect(row).toMatchObject({
        rls: true,
        forceRls: true,
        select: true,
        insert: true,
        update: true,
        delete: true,
      });
    }

    const authorityRows = await shared.admin<
      { name: string; select: boolean; insert: boolean; update: boolean; delete: boolean }[]
    >`
      select c.relname as name,
        has_table_privilege('opengeni_app', c.oid, 'SELECT') as select,
        has_table_privilege('opengeni_app', c.oid, 'INSERT') as insert,
        has_table_privilege('opengeni_app', c.oid, 'UPDATE') as update,
        has_table_privilege('opengeni_app', c.oid, 'DELETE') as delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = any(array[
          'organization_memberships', 'organization_user_resource_authorities'
        ]::text[])
      order by c.relname`;
    expect(authorityRows).toHaveLength(2);
    for (const row of authorityRows) {
      expect(row).toMatchObject({ select: false, insert: false, update: false, delete: false });
    }

    const routines = await shared.admin<
      {
        name: string;
        owner: string;
        appExecute: boolean;
        publicExecute: boolean;
        securityDefiner: boolean;
        config: string[] | null;
      }[]
    >`
      select (p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')')::text
          as name,
        pg_get_userbyid(p.proowner)::text as owner,
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        p.prosecdef as "securityDefiner",
        p.proconfig as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = current_schema()
        and (p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')') =
          any(${shared.admin.array([...xaiRoutines])})
      order by name`;
    expect(routines.map((routine) => routine.name).sort()).toEqual([...xaiRoutines].sort());
    expect(new Set(routines.map((routine) => routine.owner)).size).toBe(1);
    for (const routine of routines) {
      expect(routine.appExecute).toBe(true);
      expect(routine.publicExecute).toBe(false);
      if (routine.name === "xai_provider_account_authority_snapshot_v1_valid(jsonb)") {
        expect(routine.securityDefiner).toBe(false);
      } else {
        expect(routine.securityDefiner).toBe(true);
        expect(routine.config?.join(" ")).toContain("search_path");
        expect(routine.config?.join(" ")).toContain("pg_catalog");
      }
    }

    const [claim] = await shared.admin<
      { appExecute: boolean; publicExecute: boolean; securityDefiner: boolean; config: string[] }[]
    >`
      select has_function_privilege(
          'opengeni_app',
          'opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure,
          'EXECUTE'
        ) as "appExecute",
        exists (
          select 1 from pg_proc p,
            lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where p.oid =
            'opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure
            and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        p.prosecdef as "securityDefiner", p.proconfig as config
      from pg_proc p
      where p.oid =
        'opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure`;
    expect(claim).toMatchObject({
      appExecute: true,
      publicExecute: false,
      securityDefiner: true,
    });
    expect(claim?.config.join(" ")).toContain("search_path=pg_catalog");
  }, 180_000);
});
