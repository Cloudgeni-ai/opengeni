import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  abandonCodexResetRedemptionBeforeProvider,
  claimCodexResetRedemption,
  completeSubscriptionCoreCodexResetRedemption,
  createDb,
  ensureManagedAccessForUser,
  fenceCodexResetRedemptionSend,
  listSubscriptionCoreCodexResetRedemptionRecoveries,
  readSubscriptionCoreCodexResetAuthority,
  releaseCodexResetRedemptionClaim,
  resolveSubscriptionCoreCodexConnectionId,
  subscriptionCoreCodexResetAuthority,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 47);

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-reset-credits-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function encryptedTokens(label: string): string {
  return encryptEnvironmentValue(
    key,
    JSON.stringify({
      access_token: `access-${label}`,
      refresh_token: `refresh-${label}`,
      id_token: `id-${label}`,
    }),
  );
}

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `core-codex-consumers-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex consumers fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  // Migration 0680 seeds every organization enabled on the shared core. These
  // dormant-gate fixtures start from the pre-cutover world (no Codex row) and
  // enable or disable the gate explicitly.
  await shared!.admin`
    delete from subscription_provider_cutovers
    where account_id = ${accountId}::uuid and provider = 'codex'`;
  // ...and its seeded organization settings row, which the fixture writes itself.
  await shared!.admin`
    delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [sharedWorkspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Core Codex consumers shared workspace') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${sharedWorkspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${sharedWorkspace!.id}::uuid, ${accountId}::uuid)`;
  await shared!.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (
      ${accountId}::uuid, ${shared!.admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true
    )`;
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: sharedWorkspace!.id,
  };
}

async function setCutover(accountId: string, enabled: boolean): Promise<void> {
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

async function sharedConnection(
  org: Org,
  label: string,
  options: {
    scope?: "organization" | "workspaces";
    workspaces?: string[];
    managedBy?: string | null;
    expiresAt?: Date;
    pool?: "workspace" | "organization";
  } = {},
): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at, managed_by_workspace_id, label
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens(label)},
      'shared', ${options.scope ?? "organization"}, ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false, resetCreditAvailableCount: 2 })}::jsonb,
      ${(options.expiresAt ?? new Date(Date.now() + 86_400_000)).toISOString()}::timestamptz,
      ${options.managedBy ?? null}::uuid, ${label}
    ) returning id::text as id`;
  for (const workspaceId of options.workspaces ?? []) {
    await shared!.admin`
      insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid)`;
  }
  for (const workspaceId of [org.personalWorkspaceId, org.sharedWorkspaceId]) {
    await shared!.admin`
      insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool
      ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid,
        ${options.pool ?? "organization"})`;
  }
  return row!.id;
}

/** A workspace administrator who is not an organization administrator. */
async function workspaceAdmin(org: Org, workspaceId: string): Promise<string> {
  const subjectId = `user:core-codex-manager-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${org.accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'admin')`;
  return subjectId;
}

async function managedHere(org: Org, label: string): Promise<string> {
  return await sharedConnection(org, label, {
    scope: "workspaces",
    workspaces: [org.sharedWorkspaceId],
    managedBy: org.sharedWorkspaceId,
    pool: "workspace",
  });
}

async function member(org: Org, workspaceId: string): Promise<string> {
  const subjectId = `user:core-codex-member-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${org.accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'member')`;
  return subjectId;
}

function authorityOf(
  org: Org,
  subjectId: string,
  credentialId: string,
  workspaceId = org.sharedWorkspaceId,
) {
  return withSessionRlsActorContext({ subjectId }, () =>
    readSubscriptionCoreCodexResetAuthority(client!.db, {
      accountId: org.accountId,
      workspaceId,
      credentialId,
      subjectId,
    }),
  );
}

function claim(
  org: Org,
  subjectId: string,
  credentialId: string,
  attemptId: string,
  creditId = "credit-1",
) {
  return withSessionRlsActorContext({ subjectId }, () =>
    claimCodexResetRedemption(
      client!.db,
      {
        id: attemptId,
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        credentialId,
        subjectId,
        browserSessionHash: `browser-${subjectId}`,
        creditId,
        confirmationExpiresAt: new Date(Date.now() + 300_000),
        claimHolderId: crypto.randomUUID(),
      },
      subscriptionCoreCodexResetAuthority,
    ),
  );
}

describe.skipIf(!realDb)("Codex reset credits on the shared core (M3 PR 2c)", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test("authority is the organization administrator or the managing workspace's administrator, via canonical and aliased ids", async () => {
    const org = await organization();
    const other = await organization();
    const connectionId = await managedHere(org, "reset-authority");
    const alias = crypto.randomUUID();
    await shared!.admin`
      insert into subscription_connection_aliases (account_id, provider, alias_connection_id, connection_id)
      values (${org.accountId}::uuid, 'codex', ${alias}::uuid, ${connectionId}::uuid)`;
    const manager = await workspaceAdmin(org, org.sharedWorkspaceId);
    const plain = await member(org, org.sharedWorkspaceId);

    // Gate off and disabled: nothing is authorized.
    expect(await authorityOf(org, org.ownerSubjectId, connectionId)).toBeNull();
    await setCutover(org.accountId, false);
    expect(await authorityOf(org, org.ownerSubjectId, connectionId)).toBeNull();
    expect(await claim(org, org.ownerSubjectId, connectionId, crypto.randomUUID())).toEqual({
      kind: "not_found",
    });
    await setCutover(org.accountId, true);
    await setCutover(other.accountId, true);

    for (const requested of [connectionId, alias]) {
      const canonical = await resolveSubscriptionCoreCodexConnectionId(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        connectionId: requested,
      });
      expect(canonical).toBe(connectionId);
      expect(await authorityOf(org, org.ownerSubjectId, canonical!)).toEqual({
        status: "active",
        owned: true,
      });
      expect(await authorityOf(org, manager, canonical!)).toEqual({
        status: "active",
        owned: true,
      });
      expect(await authorityOf(org, plain, canonical!)).toEqual({ status: "active", owned: false });
    }
    // Another organization cannot resolve the alias or see the connection.
    expect(
      await resolveSubscriptionCoreCodexConnectionId(client!.db, {
        accountId: other.accountId,
        workspaceId: other.sharedWorkspaceId,
        connectionId: alias,
      }),
    ).toBeNull();
    expect(
      await authorityOf(other, other.ownerSubjectId, connectionId, other.sharedWorkspaceId),
    ).toBeNull();
    // Another workspace of the same organization does not manage it, even for its administrator.
    const otherManager = await workspaceAdmin(org, org.personalWorkspaceId);
    expect(await authorityOf(org, otherManager, connectionId, org.personalWorkspaceId)).toBeNull();
    expect(
      await authorityOf(org, org.ownerSubjectId, connectionId, org.personalWorkspaceId),
    ).toBeNull();
    // The subject argument must be the authenticated RLS subject.
    const forged = await withSessionRlsActorContext({ subjectId: plain }, () =>
      withRlsContext(
        client!.db,
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        (tx) =>
          subscriptionCoreCodexResetAuthority(tx, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            credentialId: connectionId,
            subjectId: org.ownerSubjectId,
          }),
      ),
    );
    expect(forged).toBeNull();
    // A denied principal cannot claim.
    expect(await claim(org, plain, connectionId, crypto.randomUUID())).toEqual({
      kind: "forbidden",
    });
  });

  test("the ledger is single-use, recovers an ambiguous send with the same key, and clears quota under the generation fence", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await managedHere(org, "reset-ledger");
    const manager = await workspaceAdmin(org, org.sharedWorkspaceId);
    const exhaustedUntil = Date.now() + 3_600_000;
    await shared!.admin`
      insert into subscription_connection_quota (account_id, connection_id, quota, observed_refresh_generation, revision)
      values (${org.accountId}::uuid, ${connectionId}::uuid,
        ${shared!.admin.json({ windows: [], modelCooldowns: {}, exhaustedUntil, exhaustedKind: "quota", source: "refusal" })}::jsonb,
        1, 1)`;
    const attemptId = crypto.randomUUID();
    const first = await claim(org, manager, connectionId, attemptId);
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    // A live claim is in progress; another attempt on the same credit conflicts.
    expect((await claim(org, manager, connectionId, attemptId)).kind).toBe("in_progress");
    expect((await claim(org, manager, connectionId, crypto.randomUUID())).kind).toBe("conflict");

    const ledger = {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      attemptId,
      claimHolderId: first.attempt.claimHolderId!,
    };
    const fenced = await withSessionRlsActorContext({ subjectId: manager }, () =>
      fenceCodexResetRedemptionSend(
        client!.db,
        {
          ...ledger,
          credentialId: connectionId,
          subjectId: manager,
          browserSessionHash: `browser-${manager}`,
        },
        subscriptionCoreCodexResetAuthority,
      ),
    );
    expect(fenced.kind).toBe("ready");
    if (fenced.kind !== "ready") return;
    // An uncertain provider outcome releases the claim but keeps provider_started.
    expect(
      await releaseCodexResetRedemptionClaim(client!.db, {
        ...ledger,
        failureKind: "provider_timeout",
      }),
    ).toBe(true);
    expect(await abandonCodexResetRedemptionBeforeProvider(client!.db, ledger)).toBe(false);
    const recovered = await claim(org, manager, connectionId, attemptId);
    expect(recovered.kind).toBe("claimed");
    if (recovered.kind !== "claimed") return;
    expect(recovered.attempt.status).toBe("provider_started");
    expect(recovered.attempt.upstreamIdempotencyKey).toBe(fenced.attempt.upstreamIdempotencyKey);
    const recoveries = await withSessionRlsActorContext({ subjectId: manager }, () =>
      listSubscriptionCoreCodexResetRedemptionRecoveries(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        subjectId: manager,
      }),
    );
    expect(recoveries.map((recovery) => [recovery.attemptId, recovery.status])).toEqual([
      [attemptId, "provider_started"],
    ]);

    // A stale claim holder cannot complete; the current one does.
    expect(
      await completeSubscriptionCoreCodexResetRedemption(client!.db, {
        ...ledger,
        outcome: "reset",
      }),
    ).toEqual({ attempt: null, wake: null });
    const completed = await withSessionRlsActorContext({ subjectId: manager }, () =>
      completeSubscriptionCoreCodexResetRedemption(client!.db, {
        ...ledger,
        claimHolderId: recovered.attempt.claimHolderId!,
        outcome: "reset",
      }),
    );
    expect(completed.attempt?.status).toBe("completed");
    expect(completed.wake).toEqual({
      accountId: org.accountId,
      reason: "codex_reset_credit_redeemed",
    });
    const [quota] = await shared!.admin<{ until: string | null; legacy: number }[]>`
      select quota->>'exhaustedUntil' as until,
        (select count(*)::int from codex_subscription_credentials where id = ${connectionId}::uuid) as legacy
      from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
    expect(quota).toEqual({ until: null, legacy: 0 });

    // Single use: a replay is the durable completion; a new attempt on the credit conflicts.
    const replay = await claim(org, manager, connectionId, attemptId);
    expect(replay.kind).toBe("completed");
    expect((await claim(org, manager, connectionId, crypto.randomUUID())).kind).toBe("conflict");

    // A quota observed with an older credential generation is not cleared.
    const stale = await managedHere(org, "reset-stale");
    await shared!.admin`update subscription_connections set refresh_generation = 2,
      credential_encrypted = ${encryptedTokens("reset-stale-2")} where id = ${stale}::uuid`;
    await shared!.admin`
      insert into subscription_connection_quota (account_id, connection_id, quota, observed_refresh_generation, revision)
      values (${org.accountId}::uuid, ${stale}::uuid,
        ${shared!.admin.json({ windows: [], modelCooldowns: {}, exhaustedUntil, exhaustedKind: "quota", source: "refusal" })}::jsonb,
        1, 1)`;
    const staleAttempt = crypto.randomUUID();
    const staleClaim = await claim(org, manager, stale, staleAttempt);
    if (staleClaim.kind !== "claimed") throw new Error("claim failed");
    const staleLedger = {
      ...ledger,
      attemptId: staleAttempt,
      claimHolderId: staleClaim.attempt.claimHolderId!,
    };
    await withSessionRlsActorContext({ subjectId: manager }, () =>
      fenceCodexResetRedemptionSend(
        client!.db,
        {
          ...staleLedger,
          credentialId: stale,
          subjectId: manager,
          browserSessionHash: `browser-${manager}`,
        },
        subscriptionCoreCodexResetAuthority,
      ),
    );
    await withSessionRlsActorContext({ subjectId: manager }, () =>
      completeSubscriptionCoreCodexResetRedemption(client!.db, {
        ...staleLedger,
        outcome: "reset",
      }),
    );
    const [kept] = await shared!.admin<{ until: string | null }[]>`
      select quota->>'exhaustedUntil' as until from subscription_connection_quota
      where connection_id = ${stale}::uuid`;
    expect(kept!.until).toBe(String(exhaustedUntil));
  });

  test("an authorized ledger step share-locks the connection against disconnect", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await managedHere(org, "reset-lock");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      withRlsContext(
        client!.db,
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        async (tx) => {
          const authority = await subscriptionCoreCodexResetAuthority(tx, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            credentialId: connectionId,
            subjectId: org.ownerSubjectId,
          });
          expect(authority).toEqual({ status: "active", owned: true });
          locked();
          await held;
        },
      ),
    );
    await lockTaken;
    const blocked = await shared!.admin
      .begin(async (tx) => {
        await tx`set local lock_timeout = '300ms'`;
        await tx`update subscription_connections set credential_encrypted = ${encryptedTokens("replaced")}
          where id = ${connectionId}::uuid`;
      })
      .then(() => "replaced")
      .catch((error: { code?: string }) => error.code);
    release();
    await holder;
    expect(blocked).toBe("55P03");
  });
});
