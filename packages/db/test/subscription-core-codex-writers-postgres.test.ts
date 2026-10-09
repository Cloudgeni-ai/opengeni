// M3 PR 3b: Codex connect/disconnect, the owner-scoped personal writer, the
// owner's personal-connection reader and organization-level reset-credit
// redemption on the shared core, as the restricted application role.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  claimCodexResetRedemption,
  claimSessionWorkForAttempt,
  connectSubscriptionCoreCodexConnection,
  createDb,
  createSession,
  disconnectAllSubscriptionCoreCodexConnections,
  disconnectSubscriptionCoreCodexConnection,
  reserveSubscriptionCoreCodexRequest,
  settleSubscriptionCoreCodexRequest,
  reserveSubscriptionCoreCodexTurnCredentialRequest,
  settleSubscriptionCoreCodexTurnCredentialRequest,
  reserveSubscriptionCoreCodexOperationRequest,
  settleSubscriptionCoreCodexOperationRequest,
  SubscriptionCoreCodexSourceDisconnectedError,
  SubscriptionCoreCodexRequestOutcomeUnknownError,
  SubscriptionCoreCodexLeaseLostError,
  reserveSubscriptionCoreCodexAppsRequest,
  settleSubscriptionCoreCodexAppsRequest,
  designateSubscriptionCoreCodexApps,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  fenceSubscriptionCoreCodexResetCredit,
  getSubscriptionCoreCodexWorkspaceProjection,
  getSubscriptionCoreOrganizationCodexProjection,
  getSubscriptionCoreSessionCodexAccounts,
  readSubscriptionCoreCodexResetAuthority,
  renameSubscriptionCoreCodexConnection,
  setSubscriptionCoreCodexAllocator,
  setSubscriptionCoreCodexPrimary,
  setSubscriptionCoreCodexExtraCredits,
  readSubscriptionCoreTurnIdentity,
  evaluateSubscriptionCoreCodexPlacement,
  subscriptionCoreCodexResetAuthority,
  subscriptionCoreCodexResetCreditFence,
  SubscriptionCoreCodexOrganizationManagedError,
  withSessionRlsActorContext,
  withSubscriptionCoreAcceptedTurn,
  type DbClient,
  type SubscriptionCoreCodexCredentialInput,
} from "../src";
import { rawRows, withRlsContext } from "../src/database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 53);
const MODEL = "codex/gpt-5.5";

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-writers-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
  otherWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `core-codex-writers-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex writers fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const workspaces: string[] = [];
  for (const name of ["Core Codex writers shared", "Core Codex writers other"]) {
    const [workspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}::uuid, ${name}) returning id::text as id`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}::uuid, ${accountId}::uuid)`;
    workspaces.push(workspace!.id);
  }
  // Migration 0680 seeds the organization settings row; the fixture writes its own.
  await shared!.admin`
    delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  await shared!.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (
      ${accountId}::uuid, ${shared!.admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, false
    )`;
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: workspaces[0]!,
    otherWorkspaceId: workspaces[1]!,
  };
}

/** A second person: an organization member with their own Personal workspace. */
async function person(
  org: Org,
  role: "admin" | "member",
): Promise<{ subjectId: string; membershipId: string; personalWorkspaceId: string }> {
  const subjectId = `user:core-codex-person-${crypto.randomUUID()}`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${org.accountId}::uuid, 'Personal') returning id::text as id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${org.accountId}::uuid)`;
  const [membership] = await shared!.admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id, role)
    values (${org.accountId}::uuid, ${subjectId}, 'active', ${workspace!.id}::uuid, 'member')
    returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${subjectId}, ${role})`;
  return { subjectId, membershipId: membership!.id, personalWorkspaceId: workspace!.id };
}

async function setCutover(accountId: string, enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    await shared!.admin`delete from subscription_provider_cutovers
      where account_id = ${accountId}::uuid and provider = 'codex'`;
    return;
  }
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

function credential(label: string): SubscriptionCoreCodexCredentialInput {
  return {
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: `access-${label}`,
        refresh_token: `refresh-${label}`,
        id_token: `id-${label}`,
      }),
    ),
    providerAccountId: `chatgpt-${label}`,
    providerSubjectId: `user-${label}`,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 86_400_000),
    lastRefreshAt: new Date(),
    accountEmail: `${label}@example.test`,
    label,
  };
}

function connect(
  org: Org,
  subjectId: string,
  workspaceId: string | null,
  label: string,
  accountId = org.accountId,
) {
  return withSessionRlsActorContext({ subjectId }, () =>
    connectSubscriptionCoreCodexConnection(client!.db, {
      accountId,
      workspaceId,
      subjectId,
      ...credential(label),
    }),
  );
}

function disconnect(org: Org, subjectId: string, workspaceId: string | null, connectionId: string) {
  return withSessionRlsActorContext({ subjectId }, () =>
    disconnectSubscriptionCoreCodexConnection(client!.db, {
      accountId: org.accountId,
      workspaceId,
      subjectId,
      connectionId,
    }),
  );
}

function personalAccounts(org: Org, subjectId: string, workspaceId: string) {
  return withSessionRlsActorContext({ subjectId }, () =>
    getSubscriptionCoreCodexWorkspaceProjection(client!.db, {
      accountId: org.accountId,
      workspaceId,
      viewerSubjectId: subjectId,
    }),
  );
}

async function row(connectionId: string) {
  const [found] = await shared!.admin<
    {
      ownership: string;
      scope_kind: string;
      managed_by_workspace_id: string | null;
      refresh_generation: string;
      credential_encrypted: string;
      owner_subject_id: string | null;
      authority_generation: string | null;
      authority_id: string | null;
      allow_personal_workspaces: boolean;
      connected_by_subject_id: string | null;
    }[]
  >`select ownership, scope_kind, managed_by_workspace_id::text as managed_by_workspace_id,
      refresh_generation::text as refresh_generation, credential_encrypted, owner_subject_id,
      authority_generation::text as authority_generation, authority_id::text as authority_id,
      allow_personal_workspaces, connected_by_subject_id
    from subscription_connections where id = ${connectionId}::uuid and disconnected_at is null`;
  return found ?? null;
}

function accessToken(encrypted: string): string {
  return (JSON.parse(decryptEnvironmentValue(key, encrypted)) as { access_token: string })
    .access_token;
}

async function disconnectDesignationCase() {
  const org = await organization();
  await setCutover(org.accountId, true);
  const connected = await connect(org, org.ownerSubjectId, null, "designation-drain");
  if (connected.kind !== "connected") throw new Error("connect failed");
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into subscription_apps_designations(account_id, workspace_id, connection_id, updated_by_subject_id)
      values (${org.accountId}::uuid, ${org.otherWorkspaceId}::uuid, ${connected.id}::uuid, ${org.ownerSubjectId})`;
  });
  const target = {
    accountId: org.accountId,
    workspaceId: org.otherWorkspaceId,
    connectionId: connected.id,
  };
  const reserved = await reserveSubscriptionCoreCodexAppsRequest(client!.db, target, {
    requestId: crypto.randomUUID(),
    transportAttempt: 1,
  });
  await expect(
    reserveSubscriptionCoreCodexAppsRequest(
      client!.db,
      { ...target, workspaceId: org.sharedWorkspaceId },
      { requestId: crypto.randomUUID(), transportAttempt: 1 },
    ),
  ).rejects.toThrow();
  expect((await disconnect(org, org.ownerSubjectId, null, connected.id)).outcome).toBe("removed");
  await expect(
    reserveSubscriptionCoreCodexAppsRequest(client!.db, target, {
      requestId: crypto.randomUUID(),
      transportAttempt: 1,
    }),
  ).rejects.toBeInstanceOf(SubscriptionCoreCodexSourceDisconnectedError);
  await settleSubscriptionCoreCodexAppsRequest(client!.db, target, {
    operationId: reserved.operationId,
    outcome: "response_received",
  });
  expect(
    Array.from(
      await shared!.admin`select connection_id from subscription_apps_designations
    where account_id = ${org.accountId}::uuid and workspace_id = ${org.otherWorkspaceId}::uuid`,
    ),
  ).toEqual([]);
  const [source] = await shared!
    .admin`select credential_encrypted, disconnected_at is not null as disconnected
    from subscription_connections where id = ${connected.id}::uuid`;
  expect(source).toEqual({ credential_encrypted: "", disconnected: true });
  const staleTarget = {
    accountId: org.accountId,
    workspaceId: null,
    subjectId: org.ownerSubjectId,
    connectionId: connected.id,
  };
  expect((await setSubscriptionCoreCodexPrimary(client!.db, staleTarget)).activated).toBeNull();
  expect(
    (
      await setSubscriptionCoreCodexAllocator(client!.db, {
        ...staleTarget,
        enabled: true,
        expectedVersion: 1,
      })
    ).result,
  ).toEqual({ kind: "not_found" });
}

/**
 * Fixture only: a chat lease as placement leaves it. Inserted without row
 * triggers (the reference guard checks a request context the fixture has
 * none of); the delete-side foreign-key check still applies to it.
 */
async function insertLease(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  connectionId: string;
}): Promise<void> {
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into subscription_leases (
        account_id, workspace_id, session_id, turn_id, connection_id, provider, holder_id,
        generation, leased_until
      ) values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
        ${input.turnId}::uuid, ${input.connectionId}::uuid, 'codex', 'writers-holder', 1,
        now() + interval '5 minutes')`;
  });
}

describe.skipIf(!realDb)("Codex writers on the shared core (M3 PR 3b)", () => {
  test("Codex Apps admission does not grant actorless Claude or xAI operation authority", async () => {
    const org = await organization();
    for (const provider of ["claude", "xai"]) {
      const [source] = await shared!.admin<{ id: string }[]>`insert into subscription_connections(
        account_id, provider, credential_encrypted, ownership, scope_kind)
        values (${org.accountId}::uuid, ${provider}, 'synthetic-nonsecret', 'shared', 'organization') returning id::text as id`;
      await expect(
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          async (tx) => {
            await tx.execute(sql`select set_config('opengeni.subject_id', '', true),
          set_config('opengeni.initiating_human_subject_id', '', true)`);
            await tx.execute(sql`insert into subscription_operation_leases(account_id, workspace_id,
          operation_id, attempt_id, operation_kind, provider, connection_id, holder_id, generation, leased_until)
          values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${crypto.randomUUID()}::uuid,
            ${crypto.randomUUID()}::uuid, 'apps', ${provider}, ${source!.id}::uuid, 'actorless', 1,
            now() + interval '1 minute')`);
          },
        ),
      ).rejects.toThrow();
    }
  });

  test("shared-workspace projection clears disconnected local and inherited organization primaries", async () => {
    for (const organizationScope of [false, true]) {
      const org = await organization();
      await setCutover(org.accountId, true);
      const workspaceId = organizationScope ? null : org.sharedWorkspaceId;
      const connected = await connect(org, org.ownerSubjectId, workspaceId, "primary-drain");
      if (connected.kind !== "connected") throw new Error("connect failed");
      await setSubscriptionCoreCodexPrimary(client!.db, {
        accountId: org.accountId,
        workspaceId,
        subjectId: org.ownerSubjectId,
        connectionId: connected.id,
      });
      const projection = () =>
        getSubscriptionCoreCodexWorkspaceProjection(client!.db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          viewerSubjectId: org.ownerSubjectId,
        });
      expect((await projection()).rotation.activeCredentialId).toBe(connected.id);
      expect((await disconnect(org, org.ownerSubjectId, workspaceId, connected.id)).outcome).toBe(
        "removed",
      );
      const removed = await projection();
      expect(removed.rotation.activeCredentialId).toBeNull();
      expect(removed.accounts.some((account) => account.id === connected.id)).toBe(false);
    }
  });

  test("Apps designation versus disconnect is serialized in both lock orders", async () => {
    for (const first of ["designate", "disconnect"] as const) {
      const org = await organization();
      await setCutover(org.accountId, true);
      const connected = await connect(org, org.ownerSubjectId, null, `designation-race-${first}`);
      if (connected.kind !== "connected") throw new Error("connect failed");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const designate = (db = client!.db) =>
        designateSubscriptionCoreCodexApps(db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          subjectId: org.ownerSubjectId,
          connectionId: connected.id,
          expectedVersion: 0,
        });
      const remove = (db = client!.db) =>
        disconnectSubscriptionCoreCodexConnection(db, {
          accountId: org.accountId,
          workspaceId: null,
          subjectId: org.ownerSubjectId,
          connectionId: connected.id,
        });
      const holding = withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
        withRlsContext(
          client!.db,
          {
            accountId: org.accountId,
            workspaceId: first === "designate" ? org.sharedWorkspaceId : null,
          },
          async (tx) => {
            if (first === "designate")
              expect(await designate(tx)).toMatchObject({ kind: "updated" });
            else expect(await remove(tx)).toMatchObject({ outcome: "removed" });
            entered.resolve();
            await release.promise;
          },
        ),
      );
      void holding.catch(entered.reject);
      await entered.promise;
      const waiting = withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, async () =>
        first === "designate" ? await remove() : await designate(),
      );
      for (let tries = 0; tries < 100; tries++) {
        const [locks] = await shared!.admin`select count(*)::int as pending from pg_locks
          where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`;
        if (locks!.pending > 0) break;
        if (tries === 99) {
          release.resolve();
          throw new Error("designation did not contend on source lock");
        }
        await Bun.sleep(5);
      }
      release.resolve();
      await holding;
      const result = await waiting;
      if (first === "designate") expect(result).toMatchObject({ outcome: "removed" });
      else expect(result).toMatchObject({ kind: "forbidden" });
      expect(
        Array.from(
          await shared!.admin`select connection_id from subscription_apps_designations
        where account_id = ${org.accountId}::uuid`,
        ),
      ).toEqual([]);
    }
  });

  test(
    "disconnect clears the exact Apps designation in another workspace",
    disconnectDesignationCase,
  );
  test("one-shot nonturn reservation, unknown crash outcome, reconnect and RLS isolation", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connected = await connect(org, org.ownerSubjectId, null, "request-custody");
    if (connected.kind !== "connected") throw new Error("connect failed");
    const scope = {
      kind: "workspace" as const,
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      subjectId: org.ownerSubjectId,
    };
    const request = { requestId: crypto.randomUUID(), transportAttempt: 1 };
    const receipt = await reserveSubscriptionCoreCodexOperationRequest(
      client!.db,
      scope,
      null,
      connected.id,
      request,
    );
    await expect(
      reserveSubscriptionCoreCodexOperationRequest(client!.db, scope, null, connected.id, request),
    ).rejects.toThrow();
    const other = await organization();
    await expect(
      reserveSubscriptionCoreCodexOperationRequest(
        client!.db,
        {
          ...scope,
          accountId: other.accountId,
          workspaceId: other.sharedWorkspaceId,
          subjectId: other.ownerSubjectId,
        },
        null,
        connected.id,
        { ...request, requestId: crypto.randomUUID() },
      ),
    ).rejects.toThrow();
    await settleSubscriptionCoreCodexOperationRequest(client!.db, scope, {
      operationId: receipt.operationId,
      outcome: "unknown",
    });
    await shared!
      .admin`update subscription_operation_leases set leased_until = now() - interval '1 hour'
      where operation_id = ${receipt.operationId}::uuid`;
    expect((await disconnect(org, org.ownerSubjectId, null, connected.id)).outcome).toBe("removed");
    expect((await disconnect(org, org.ownerSubjectId, null, connected.id)).outcome).toBe("removed");
    await expect(
      reserveSubscriptionCoreCodexOperationRequest(client!.db, scope, null, connected.id, {
        ...request,
        transportAttempt: 2,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreCodexSourceDisconnectedError);
    const [retained] = await shared!.admin`select request_outcome from subscription_operation_leases
      where operation_id = ${receipt.operationId}::uuid`;
    expect(retained!.request_outcome).toBe("unknown");
    const [secret] = await shared!
      .admin`select credential_encrypted from subscription_connections where id = ${connected.id}::uuid`;
    expect(secret!.credential_encrypted).toBe("");
    // Neither an old refresh nor a reconnect-by-update can rehydrate history.
    const lateWrite = await shared!
      .admin`update subscription_connections set credential_encrypted = 'late-refresh'
      where id = ${connected.id}::uuid`.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(lateWrite)).toContain("disconnected subscription identity");
    const reconnected = await connect(org, org.ownerSubjectId, null, "request-custody");
    if (reconnected.kind !== "connected") throw new Error("reconnect failed");
    expect(reconnected.id).not.toBe(connected.id);
    const projected = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      getSubscriptionCoreOrganizationCodexProjection(client!.db, {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
      }),
    );
    expect(projected.accounts.map((account) => account.id)).toEqual([reconnected.id]);
  });

  test("reserve versus disconnect linearizes in both lock orders", async () => {
    for (const first of ["reserve", "disconnect"] as const) {
      const org = await organization();
      await setCutover(org.accountId, true);
      const connected = await connect(org, org.ownerSubjectId, null, `race-${first}`);
      if (connected.kind !== "connected") throw new Error("connect failed");
      const scope = {
        kind: "workspace" as const,
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        subjectId: org.ownerSubjectId,
      };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const reserve = (db = client!.db) =>
        reserveSubscriptionCoreCodexOperationRequest(db, scope, null, connected.id, {
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
        });
      const remove = (db = client!.db) =>
        disconnectSubscriptionCoreCodexConnection(db, {
          accountId: org.accountId,
          workspaceId: null,
          subjectId: org.ownerSubjectId,
          connectionId: connected.id,
        });
      const holding = withSessionRlsActorContext(
        { subjectId: org.ownerSubjectId, initiatingHumanSubjectId: org.ownerSubjectId },
        () =>
          withRlsContext(
            client!.db,
            {
              accountId: org.accountId,
              workspaceId: first === "reserve" ? org.sharedWorkspaceId : null,
            },
            async (tx) => {
              if (first === "reserve") await reserve(tx);
              else await remove(tx);
              entered.resolve();
              await release.promise;
            },
          ),
      );
      await entered.promise;
      let completed = false;
      const waiting = withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, async () =>
        first === "reserve" ? await remove() : await reserve(),
      )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          completed = true;
        });
      // Observe actual PostgreSQL lock contention, not a sleep-as-proof.
      for (let tries = 0; tries < 100; tries++) {
        const [locks] = await shared!.admin`select count(*)::int as pending from pg_locks
          where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`;
        if (locks!.pending > 0) break;
        if (tries === 99) {
          release.resolve();
          throw new Error("no competing database lock observed");
        }
        await Bun.sleep(5);
      }
      expect(completed).toBe(false);
      release.resolve();
      await holding;
      const result = await waiting;
      if (first === "reserve") expect(result).toMatchObject({ value: { outcome: "removed" } });
      else
        expect("error" in result && result.error).toBeInstanceOf(
          SubscriptionCoreCodexSourceDisconnectedError,
        );
    }
  });

  test("refresh serialization scrubs the winning token and cannot resurrect a disconnected generation", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connected = await connect(org, org.ownerSubjectId, null, "refresh-drain");
    if (connected.kind !== "connected") throw new Error("connect failed");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refreshing = withSessionRlsActorContext(
      { subjectId: org.ownerSubjectId, initiatingHumanSubjectId: org.ownerSubjectId },
      () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          async (tx) => {
            const [started] = await rawRows<{ refresh_generation: number | string }>(
              tx,
              sql`select refresh_generation from opengeni_private.begin_subscription_codex_connection_refresh(
            ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${connected.id}::uuid,
            null, null, null, null)`,
            );
            expect(started).toBeDefined();
            entered.resolve();
            await release.promise;
            const [persisted] = await rawRows<{ persisted: boolean }>(
              tx,
              sql`select opengeni_private.persist_subscription_codex_connection_refresh(
            ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${connected.id}::uuid,
            ${Number(started!.refresh_generation)}::bigint, ${encryptEnvironmentValue(key, JSON.stringify({ access_token: "synthetic-rotated" }))},
            now() + interval '1 hour', now()) as persisted`,
            );
            expect(persisted!.persisted).toBe(true);
          },
        ),
    );
    await entered.promise;
    const removing = disconnect(org, org.ownerSubjectId, null, connected.id);
    release.resolve();
    await refreshing;
    expect((await removing).outcome).toBe("removed");
    const [stored] = await shared!
      .admin`select credential_encrypted, disconnected_at is not null as disconnected
      from subscription_connections where id = ${connected.id}::uuid`;
    expect(stored).toEqual({ credential_encrypted: "", disconnected: true });
    await withSessionRlsActorContext(
      { subjectId: org.ownerSubjectId, initiatingHumanSubjectId: org.ownerSubjectId },
      () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          async (tx) => {
            expect(
              await rawRows(
                tx,
                sql`select refresh_generation from opengeni_private.begin_subscription_codex_connection_refresh(
          ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${connected.id}::uuid,
          null, null, null, null)`,
              ),
            ).toEqual([]);
          },
        ),
    );
  });

  test("personal extra-credit consent is owner-only, OCC-fenced, preserved and immediately revocable", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const member = await person(org, "member");
    const connected = await connect(
      org,
      member.subjectId,
      member.personalWorkspaceId,
      "personal-credit",
    );
    if (connected.kind !== "connected") throw new Error("connect failed");
    const alias = crypto.randomUUID();
    await shared!
      .admin`insert into subscription_connection_aliases(account_id, provider, alias_connection_id, connection_id)
      values (${org.accountId}::uuid, 'codex', ${alias}::uuid, ${connected.id}::uuid)`;
    const admin = {
      accountId: org.accountId,
      workspaceId: member.personalWorkspaceId,
      subjectId: member.subjectId,
      connectionId: connected.id,
    };
    const change = (
      connectionId: string,
      enabled: boolean,
      expectedVersion: number,
      subjectId = member.subjectId,
    ) =>
      withSessionRlsActorContext({ subjectId }, () =>
        setSubscriptionCoreCodexExtraCredits(client!.db, {
          ...admin,
          subjectId,
          connectionId,
          enabled,
          expectedVersion,
        }),
      );
    expect(
      (await personalAccounts(org, member.subjectId, member.personalWorkspaceId)).accounts[0],
    ).toMatchObject({
      extraCreditsEnabled: false,
      extraCreditsVersion: 1,
      extraCreditsUpdatedAt: null,
    });
    for (const subject of [org.ownerSubjectId, "service:fixture", "user:other"]) {
      expect((await change(alias, true, 1, subject)).result).toEqual({ kind: "not_found" });
    }
    expect(await change(connected.id, true, 1)).toMatchObject({
      result: { kind: "updated", extraCreditsEnabled: true, extraCreditsVersion: 2 },
      wake: { accountId: org.accountId, reason: "core_codex_extra_credits_changed" },
    });
    expect(await change(alias, true, 1)).toMatchObject({
      result: { kind: "unchanged", extraCreditsVersion: 2 },
      wake: null,
    });
    expect(await change(alias, false, 1)).toMatchObject({
      result: { kind: "conflict", extraCreditsEnabled: true, extraCreditsVersion: 2 },
      wake: null,
    });
    await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
      setSubscriptionCoreCodexAllocator(client!.db, {
        ...admin,
        enabled: false,
        expectedVersion: 1,
      }),
    );
    await connect(org, member.subjectId, member.personalWorkspaceId, "personal-credit");
    const projection = (await personalAccounts(org, member.subjectId, member.personalWorkspaceId))
      .accounts[0]!;
    expect(projection).toMatchObject({
      extraCreditsEnabled: true,
      extraCreditsVersion: 2,
      allocatorEnabled: false,
    });
    expect(projection.extraCreditsUpdatedAt).toBeInstanceOf(Date);
    await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
      setSubscriptionCoreCodexAllocator(client!.db, {
        ...admin,
        enabled: true,
        expectedVersion: 2,
      }),
    );
    const accepted = await withSessionRlsActorContext({ subjectId: member.subjectId }, async () => {
      const session = await createSession(client!.db, {
        accountId: org.accountId,
        workspaceId: member.personalWorkspaceId,
        subjectId: member.subjectId,
        initialMessage: "credit consent",
        resources: [],
        metadata: {},
        model: MODEL,
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        visibility: "user_private",
        createdBy: { kind: "subject", subjectId: member.subjectId },
        createdByContext: {},
      });
      const turn = await enqueueSessionTurn(client!.db, {
        accountId: org.accountId,
        workspaceId: member.personalWorkspaceId,
        sessionId: session.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${session.id}`,
        source: "user",
        prompt: "credit consent",
        resources: [],
        tools: [],
        model: MODEL,
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: {},
        initiator: { kind: "subject", subjectId: member.subjectId },
      });
      return {
        accountId: org.accountId,
        workspaceId: member.personalWorkspaceId,
        sessionId: session.id,
        turnId: turn.id,
      };
    });
    const now = Date.now();
    await shared!.admin`insert into subscription_connection_quota(account_id, connection_id, quota,
      observed_refresh_generation, revision) values (${org.accountId}::uuid, ${connected.id}::uuid,
      ${shared!.admin.json({
        windows: [
          { id: "primary", usedPercent: 100, resetsAt: now + 3600_000, status: "exhausted" },
        ],
        modelCooldowns: {},
        exhaustedUntil: null,
        exhaustedKind: null,
        observedAt: now,
        source: "usage_endpoint",
      })}::jsonb, 2, 1)`;
    const identity = await readSubscriptionCoreTurnIdentity(client!.db, accepted);
    if (!identity) throw new Error("accepted identity missing");
    const placement = () =>
      evaluateSubscriptionCoreCodexPlacement(client!.db, {
        identity,
        productModelId: MODEL,
        reasoningLevel: "medium",
      });
    expect((await placement()).kind).toBe("run");
    expect((await change(alias, false, 2)).result).toMatchObject({
      kind: "updated",
      extraCreditsEnabled: false,
      extraCreditsVersion: 3,
    });
    expect((await placement()).kind).toBe("wait");
    const audits = await shared!
      .admin`select metadata from audit_events where account_id = ${org.accountId}::uuid
      and target_id = ${connected.id} and action = 'codex.extra_credits.updated'`;
    expect(audits).toHaveLength(2);
  });

  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test("without a cutover row, and with a disabled one, nothing is written or read", async () => {
    const org = await organization();
    const owner = org.ownerSubjectId;
    for (const state of [null, false] as const) {
      await setCutover(org.accountId, state);
      expect(await connect(org, owner, null, "gate-org")).toEqual({
        kind: "refused",
        reason: "unavailable",
      });
      expect(await connect(org, owner, org.sharedWorkspaceId, "gate-ws")).toEqual({
        kind: "refused",
        reason: "unavailable",
      });
      expect(await connect(org, owner, org.personalWorkspaceId, "gate-personal")).toEqual({
        kind: "refused",
        reason: "unavailable",
      });
      expect(
        (await personalAccounts(org, owner, org.personalWorkspaceId)).personalAccountIds,
      ).toBeUndefined();
    }
    const [count] = await shared!.admin<{ total: number }[]>`
      select count(*)::int as total from subscription_connections
      where account_id = ${org.accountId}::uuid`;
    expect(count!.total).toBe(0);
    // A connection written while enabled cannot be removed once disabled.
    await setCutover(org.accountId, true);
    const connected = await connect(org, owner, null, "gate-then-disabled");
    if (connected.kind !== "connected") throw new Error("connect failed");
    await setCutover(org.accountId, false);
    expect((await disconnect(org, owner, null, connected.id)).outcome).toBe("not_found");
    expect(await row(connected.id)).not.toBeNull();
  });

  test("organization route: an administrator connects and reconnects an organization account", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const first = await connect(org, org.ownerSubjectId, null, "org-account");
    expect(first).toMatchObject({ kind: "connected", isNew: true, ownership: "shared" });
    if (first.kind !== "connected") throw new Error("connect failed");
    expect(await row(first.id)).toMatchObject({
      ownership: "shared",
      scope_kind: "organization",
      managed_by_workspace_id: null,
      refresh_generation: "1",
      allow_personal_workspaces: true,
    });
    const listed = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      getSubscriptionCoreOrganizationCodexProjection(client!.db, {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
      }),
    );
    expect(listed.accounts.map((account) => account.id)).toEqual([first.id]);
    // The same upstream account replaces the credential of the same connection.
    const again = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      connectSubscriptionCoreCodexConnection(client!.db, {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.ownerSubjectId,
        ...credential("org-account"),
        credentialEncrypted: encryptEnvironmentValue(
          key,
          JSON.stringify({ access_token: "access-rotated", refresh_token: "r", id_token: "i" }),
        ),
      }),
    );
    expect(again).toMatchObject({ kind: "connected", id: first.id, isNew: false });
    const replaced = await row(first.id);
    expect(replaced!.refresh_generation).toBe("2");
    // A user-shaped grant alone is not proof of a managed browser human.
    expect(replaced!.connected_by_subject_id).toBeNull();
    expect(accessToken(replaced!.credential_encrypted)).toBe("access-rotated");
  });

  test("two people's logins of one ChatGPT workspace stay distinct shared connections", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    // Both members of one ChatGPT Team workspace: same account id, different person.
    const login = (loginPerson: string): SubscriptionCoreCodexCredentialInput => ({
      ...credential(`team-${loginPerson}`),
      providerAccountId: "chatgpt-team-workspace",
      providerSubjectId: `user-${loginPerson}`,
    });
    const asAdmin = (input: SubscriptionCoreCodexCredentialInput) =>
      withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
        connectSubscriptionCoreCodexConnection(client!.db, {
          accountId: org.accountId,
          workspaceId: null,
          subjectId: org.ownerSubjectId,
          ...input,
        }),
      );
    const alice = await asAdmin(login("alice"));
    const bob = await asAdmin(login("bob"));
    if (alice.kind !== "connected" || bob.kind !== "connected") throw new Error("connect failed");
    expect(bob.id).not.toBe(alice.id);
    expect(bob.isNew).toBe(true);
    expect(accessToken((await row(alice.id))!.credential_encrypted)).toBe("access-team-alice");
    expect(accessToken((await row(bob.id))!.credential_encrypted)).toBe("access-team-bob");
    // Alice signing in again replaces only her own credential.
    const again = await asAdmin({
      ...login("alice"),
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "access-alice-2", refresh_token: "r", id_token: "i" }),
      ),
    });
    expect(again).toMatchObject({ kind: "connected", id: alice.id, isNew: false });
    expect(accessToken((await row(alice.id))!.credential_encrypted)).toBe("access-alice-2");
    expect(accessToken((await row(bob.id))!.credential_encrypted)).toBe("access-team-bob");
  });

  test("a workspace reconnect cannot silently replace another workspace's login, even as org admin", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connected = await connect(org, org.ownerSubjectId, org.sharedWorkspaceId, "elsewhere");
    if (connected.kind !== "connected") throw new Error("connect failed");
    expect(await connect(org, org.ownerSubjectId, org.otherWorkspaceId, "elsewhere")).toEqual({
      kind: "refused",
      reason: "managed_elsewhere",
    });
    expect((await row(connected.id))!.refresh_generation).toBe("1");
  });

  test("unidentified migrated logins are never guessed, merged, or silently duplicated", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connected = await connect(org, org.ownerSubjectId, org.sharedWorkspaceId, "unidentified");
    if (connected.kind !== "connected") throw new Error("connect failed");
    await shared!
      .admin`update subscription_connections set provider_subject_id = null where id = ${connected.id}::uuid`;
    const manager = await person(org, "admin");
    for (const subject of [org.ownerSubjectId, manager.subjectId]) {
      expect(await connect(org, subject, org.sharedWorkspaceId, "unidentified")).toEqual({
        kind: "refused",
        reason: "identity_unverified",
      });
    }
    expect((await row(connected.id))!.refresh_generation).toBe("1");
    const [count] = await shared!
      .admin`select count(*)::int as n from subscription_connections where account_id = ${org.accountId}::uuid`;
    expect(count!.n).toBe(1);
  });

  test("concurrent reconnect rechecks a disconnected identity under the lifecycle lock", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const first = await connect(org, org.ownerSubjectId, null, "reconnect-drain-race");
    if (first.kind !== "connected") throw new Error("connect failed");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = shared!.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"subscription-refresh:" + first.id}, 0))`;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const waitForQueued = async (count: number) => {
      for (let i = 0; i < 200; i++) {
        const [locks] = await shared!.admin`select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())`;
        if (locks!.n >= count) return;
        await Bun.sleep(5);
      }
      throw new Error("expected lifecycle lock contention");
    };
    const removing = disconnect(org, org.ownerSubjectId, null, first.id);
    let reconnecting: ReturnType<typeof connect> | undefined;
    try {
      await waitForQueued(1);
      reconnecting = connect(org, org.ownerSubjectId, null, "reconnect-drain-race");
      await waitForQueued(2);
    } finally {
      release.resolve();
      await holding;
    }
    expect((await removing).outcome).toBe("removed");
    const replacement = await reconnecting!;
    expect(replacement.kind).toBe("connected");
    if (replacement.kind !== "connected") throw new Error("reconnect failed");
    expect(replacement.isNew).toBe(true);
    expect(replacement.id).not.toBe(first.id);
    const [old] = await shared!.admin`select credential_encrypted from subscription_connections
      where id = ${first.id}::uuid`;
    expect(old!.credential_encrypted).toBe("");
    const [current] = await shared!.admin`select status from subscription_connections
      where id = ${replacement.id}::uuid`;
    expect(current!.status).toBe("active");
  });

  test("credential replacement waits behind an in-flight refresh and invalidates its old generation", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const first = await connect(org, org.ownerSubjectId, null, "serialized");
    if (first.kind !== "connected") throw new Error("connect failed");
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refresh = shared!.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"subscription-refresh:" + first.id}, 0))`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const reconnect = connect(org, org.ownerSubjectId, null, "serialized");
    try {
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const [blocked] = await shared!.admin`select exists(select 1 from pg_locks
          where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())) as waiting`;
        if (blocked!.waiting) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      expect((await row(first.id))!.refresh_generation).toBe("1");
    } finally {
      release.resolve();
      await refresh;
    }
    expect(await reconnect).toMatchObject({ kind: "connected", id: first.id });
    expect((await row(first.id))!.refresh_generation).toBe("2");
    const stale = await shared!
      .admin`update subscription_connections set credential_encrypted = 'stale'
      where id = ${first.id}::uuid and refresh_generation = 1 returning id`;
    expect(stale).toHaveLength(0);
  });

  test("workspace route: SUB-OWN-04 delegated managers reconnect only; administrators create and delete", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const manager = await person(org, "admin");
    const plain = await person(org, "member");
    // An organization administrator connects a workspace account.
    const local = await connect(org, org.ownerSubjectId, org.sharedWorkspaceId, "ws-account");
    expect(local).toMatchObject({ kind: "connected", isNew: true, ownership: "shared" });
    if (local.kind !== "connected") throw new Error("connect failed");
    expect(await row(local.id)).toMatchObject({
      scope_kind: "workspaces",
      managed_by_workspace_id: org.sharedWorkspaceId,
      allow_personal_workspaces: false,
    });
    const [policy] = await shared!.admin<{ inference_pool: string; managed: string }[]>`
      select inference_pool, managed_by_workspace_id::text as managed
      from subscription_connection_assignment_policies
      where connection_id = ${local.id}::uuid and workspace_id = ${org.sharedWorkspaceId}::uuid`;
    expect(policy).toEqual({ inference_pool: "workspace", managed: org.sharedWorkspaceId });
    const projection = await withSessionRlsActorContext({ subjectId: manager.subjectId }, () =>
      getSubscriptionCoreCodexWorkspaceProjection(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
      }),
    );
    expect(projection.accounts.find((account) => account.id === local.id)?.source).toBe(
      "workspace",
    );
    const organizationAccount = await connect(org, org.ownerSubjectId, null, "org-managed");
    if (organizationAccount.kind !== "connected") throw new Error("connect failed");

    // The delegated manager reconnects what the workspace manages ...
    expect(
      await connect(org, manager.subjectId, org.sharedWorkspaceId, "ws-account"),
    ).toMatchObject({ kind: "connected", id: local.id, isNew: false });
    expect((await row(local.id))!.refresh_generation).toBe("2");
    // ... but cannot take over an organization account, create a new shared
    // account, or delete one.
    expect(await connect(org, manager.subjectId, org.sharedWorkspaceId, "org-managed")).toEqual({
      kind: "refused",
      reason: "managed_elsewhere",
    });
    expect(await connect(org, manager.subjectId, org.sharedWorkspaceId, "brand-new")).toEqual({
      kind: "refused",
      reason: "forbidden",
    });
    expect(
      (await disconnect(org, manager.subjectId, org.sharedWorkspaceId, local.id)).outcome,
    ).toBe("forbidden");
    // A plain member manages nothing (the update policy refuses).
    expect(await connect(org, plain.subjectId, org.sharedWorkspaceId, "ws-account")).toEqual({
      kind: "refused",
      reason: "forbidden",
    });
    expect((await disconnect(org, plain.subjectId, org.sharedWorkspaceId, local.id)).outcome).toBe(
      "forbidden",
    );
    // An organization account named from a workspace route keeps the legacy 409.
    await expect(
      disconnect(org, org.ownerSubjectId, org.sharedWorkspaceId, organizationAccount.id),
    ).rejects.toBeInstanceOf(SubscriptionCoreCodexOrganizationManagedError);
    expect(await row(local.id)).not.toBeNull();
    // The administrator removes the workspace account.
    const removed = await disconnect(org, org.ownerSubjectId, org.sharedWorkspaceId, local.id);
    expect(removed).toMatchObject({ outcome: "removed", connectionId: local.id });
    expect(await row(local.id)).toBeNull();
  });

  test("organization route: canonical and aliased ids, and another organization's admin", async () => {
    const org = await organization();
    const other = await organization();
    await setCutover(org.accountId, true);
    await setCutover(other.accountId, true);
    const connected = await connect(org, org.ownerSubjectId, null, "alias-target");
    if (connected.kind !== "connected") throw new Error("connect failed");
    const alias = crypto.randomUUID();
    await shared!.admin`
      insert into subscription_connection_aliases (account_id, provider, alias_connection_id, connection_id)
      values (${org.accountId}::uuid, 'codex', ${alias}::uuid, ${connected.id}::uuid)`;
    // RLS isolation: the other organization's administrator neither writes
    // into nor removes from this organization.
    expect(await connect(other, other.ownerSubjectId, null, "intruder", org.accountId)).toEqual({
      kind: "refused",
      reason: "forbidden",
    });
    const foreign = await withSessionRlsActorContext({ subjectId: other.ownerSubjectId }, () =>
      disconnectSubscriptionCoreCodexConnection(client!.db, {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: other.ownerSubjectId,
        connectionId: connected.id,
      }),
    );
    expect(["forbidden", "not_found"]).toContain(foreign.outcome);
    expect(await row(connected.id)).not.toBeNull();
    // The legacy id resolves to the canonical connection.
    const removed = await disconnect(org, org.ownerSubjectId, null, alias);
    expect(removed).toMatchObject({ outcome: "removed", connectionId: connected.id });
    expect(await row(connected.id)).toBeNull();
  });

  test("personal connections: only the owner, in their Personal workspace, with personal connections allowed", async () => {
    await personalCase();
  });

  test("disconnect scrubs secrets with a live exact request and unknown redemption, then preserves response custody", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connected = await connect(org, org.ownerSubjectId, null, "guarded");
    if (connected.kind !== "connected") throw new Error("connect failed");
    const attempt = crypto.randomUUID();
    await shared!.admin`insert into codex_reset_redemption_attempts (
        id, account_id, workspace_id, credential_id, subject_id, browser_session_hash, credit_id,
        status, confirmation_expires_at, provider_started_at
      ) values (${attempt}::uuid, ${org.accountId}::uuid, ${org.otherWorkspaceId}::uuid,
        ${connected.id}::uuid, ${org.ownerSubjectId}, 'browser', 'credit-guarded',
        'provider_started', now() + interval '5 minutes', now())`;
    // A chat lease on a running turn.
    const session = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      createSession(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        initialMessage: "writers lease fixture",
        resources: [],
        metadata: {},
        model: MODEL,
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId: org.ownerSubjectId,
        createdBy: { kind: "subject", subjectId: org.ownerSubjectId },
        createdByContext: {},
      }),
    );
    const turn = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      enqueueSessionTurn(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        sessionId: session.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${session.id}`,
        source: "user",
        prompt: "writers lease fixture",
        resources: [],
        tools: [],
        model: MODEL,
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: {},
        initiator: { kind: "subject", subjectId: org.ownerSubjectId },
      }),
    );
    const claimed = await claimSessionWorkForAttempt(client!.db, org.sharedWorkspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    await insertLease({
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: session.id,
      turnId: turn.id,
      connectionId: connected.id,
    });
    const identity = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      readSubscriptionCoreTurnIdentity(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        sessionId: session.id,
        turnId: turn.id,
      }),
    );
    if (!identity) throw new Error("missing accepted identity");
    const [fence] = await shared!.admin<{ attempt_id: string; generation: number }[]>`
      select active_attempt_id::text as attempt_id, execution_generation::int as generation
      from session_turns where id = ${turn.id}::uuid`;
    const ref = { connectionId: connected.id, holderId: "writers-holder", generation: 1 };
    const request = {
      requestId: crypto.randomUUID(),
      transportAttempt: 1,
      attemptId: fence!.attempt_id,
      executionGeneration: fence!.generation,
    };
    await expect(
      reserveSubscriptionCoreCodexRequest(
        client!.db,
        identity,
        { ...ref, holderId: "stale-holder" },
        request,
      ),
    ).rejects.toBeInstanceOf(SubscriptionCoreCodexLeaseLostError);
    const usage = await reserveSubscriptionCoreCodexTurnCredentialRequest(
      client!.db,
      identity,
      ref,
      { ...request, requestId: crypto.randomUUID() },
    );
    await settleSubscriptionCoreCodexTurnCredentialRequest(client!.db, identity, ref, {
      ...request,
      operationId: usage.operationId,
      outcome: "unknown",
    });
    const [usageEvidence] = await shared!.admin`select operation_kind, request_outcome
      from subscription_operation_leases where operation_id = ${usage.operationId}::uuid`;
    expect(usageEvidence).toMatchObject({
      operation_kind: "credential_request",
      request_outcome: "unknown",
    });
    // A read-only usage failure never manufactures an ambiguous model request.
    const reserved = await reserveSubscriptionCoreCodexRequest(client!.db, identity, ref, request);
    await expect(
      reserveSubscriptionCoreCodexRequest(client!.db, identity, ref, request),
    ).rejects.toThrow();
    // A previous crashed attempt cannot be replayed by a replacement merely
    // because its lease expired. Fixture the historical admitted request.
    const crashed = crypto.randomUUID();
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into subscription_operation_leases(account_id, workspace_id, operation_id,
        attempt_id, operation_kind, session_id, turn_id, provider, connection_id, holder_id,
        generation, leased_until, request_id, transport_attempt, request_reserved_at, request_outcome)
        values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${crashed}::uuid,
          ${crypto.randomUUID()}::uuid, 'model', ${session.id}::uuid, ${turn.id}::uuid,
          'codex', ${connected.id}::uuid, 'crashed-owner', 1, now() - interval '1 hour',
          ${crypto.randomUUID()}, 1, now() - interval '2 hours', 'reserved')`;
    });
    await expect(
      reserveSubscriptionCoreCodexRequest(client!.db, identity, ref, {
        ...request,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreCodexRequestOutcomeUnknownError);
    // Only explicit outcome evidence (a synthetic definitive refusal here),
    // never timeout/expiry, releases the cross-attempt uncertainty fence.
    await shared!.admin`update subscription_operation_leases set request_outcome = 'refused'
      where operation_id = ${crashed}::uuid`;
    expect((await disconnect(org, org.ownerSubjectId, null, connected.id)).outcome).toBe("removed");
    expect(await row(connected.id)).toBeNull();
    const [scrubbed] = await shared!.admin`select credential_encrypted, status, allocator_enabled,
      disconnected_at is not null as disconnected from subscription_connections where id = ${connected.id}::uuid`;
    expect(scrubbed).toEqual({
      credential_encrypted: "",
      status: "disabled",
      allocator_enabled: false,
      disconnected: true,
    });
    await expect(
      reserveSubscriptionCoreCodexRequest(client!.db, identity, ref, {
        ...request,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreCodexSourceDisconnectedError);
    // Expiry does not delete response custody or manufacture remote completion.
    await shared!
      .admin`update subscription_leases set leased_until = now() - interval '1 hour' where turn_id = ${turn.id}::uuid`;
    await shared!
      .admin`update subscription_operation_leases set leased_until = now() - interval '1 hour' where connection_id = ${connected.id}::uuid`;
    expect((await disconnect(org, org.ownerSubjectId, null, connected.id)).outcome).toBe("removed");
    const [leases] = await shared!.admin`select
      (select count(*) from subscription_leases where connection_id = ${connected.id}::uuid)::int as chat,
      (select count(*) from subscription_operation_leases where connection_id = ${connected.id}::uuid)::int as operation`;
    expect(leases).toEqual({ chat: 1, operation: 3 });
    const [unknown] = await shared!.admin`select request_outcome, request_observed_at
      from subscription_operation_leases where operation_id = ${reserved.operationId}::uuid`;
    expect(unknown).toEqual({ request_outcome: "reserved", request_observed_at: null });
    // Reconnect is a new identity, even with exactly the same upstream person.
    const replacement = await connect(org, org.ownerSubjectId, null, "guarded");
    if (replacement.kind !== "connected") throw new Error("reconnect failed");
    expect(replacement.id).not.toBe(connected.id);
    await settleSubscriptionCoreCodexRequest(client!.db, identity, ref, {
      ...request,
      operationId: reserved.operationId,
      outcome: "response_received",
    });
    expect(await row(replacement.id)).not.toBeNull();
    const [receipt] = await shared!.admin`select request_outcome from subscription_operation_leases
      where operation_id = ${reserved.operationId}::uuid`;
    expect(receipt!.request_outcome).toBe("response_received");
    const [redemption] = await shared!
      .admin`select status from codex_reset_redemption_attempts where id = ${attempt}::uuid`;
    expect(redemption!.status).toBe("provider_started");
  });

  test("organization-level reset redemption: authority and one credit across workspaces", async () => {
    await organizationRedemptionCase();
  });

  test("owner-only routines and capability internals are not the runtime role's", async () => {
    const [schema] = await rawRows<{ usage: boolean }>(
      client!.db,
      sql`select has_schema_privilege(current_user, 'opengeni_subscription_internal', 'USAGE') as usage`,
    );
    expect(schema!.usage).toBe(false);
    for (const signature of [
      "opengeni_subscription_internal.subscription_codex_writer_context(uuid,uuid,text)",
      "opengeni_subscription_internal.grant_subscription_codex_owner_capability(text,uuid,uuid,text,uuid)",
      "opengeni_subscription_internal.drop_subscription_codex_owner_capabilities(uuid)",
      "opengeni_subscription_internal.derive_scheduled_revision_subscription_authority()",
    ]) {
      const [privilege] = await rawRows<{ executable: boolean }>(
        client!.db,
        sql`select has_function_privilege(current_user, p.oid, 'EXECUTE') as executable
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'opengeni_subscription_internal'
            and p.proname = ${signature.split(".")[1]!.split("(")[0]!}`,
      );
      expect({ signature, executable: privilege!.executable }).toEqual({
        signature,
        executable: false,
      });
    }
    const direct = await rawRows(
      client!.db,
      sql`insert into opengeni_private.subscription_runtime_capabilities (
          backend_pid, transaction_id, capability_kind, account_id, provider,
          session_owner_subject_id
        ) values (pg_backend_pid(), pg_current_xact_id(), 'codex_connection_owner',
          gen_random_uuid(), 'codex', 'user:intruder')`,
    ).catch((error: unknown) => error);
    expect(String((direct as { cause?: unknown })?.cause ?? direct)).toContain("permission denied");
  });

  test("personal identity preserves distinct upstream people and refuses unresolved identities", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const write = (
      providerSubjectId: string | null,
      workspaceId: string | null = org.personalWorkspaceId,
    ) =>
      withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
        connectSubscriptionCoreCodexConnection(client!.db, {
          ...credential("team-identity"),
          accountId: org.accountId,
          subjectId: org.ownerSubjectId,
          workspaceId,
          providerSubjectId,
        }),
      );
    const a = await write("upstream-A");
    const b = await write("upstream-B");
    if (a.kind !== "connected" || b.kind !== "connected") throw new Error("connect failed");
    expect(a.id).not.toBe(b.id);
    expect(await write("upstream-A")).toMatchObject({ kind: "connected", id: a.id, isNew: false });
    expect(await write("upstream-B")).toMatchObject({ kind: "connected", id: b.id, isNew: false });
    for (const workspaceId of [org.personalWorkspaceId, null]) {
      if (workspaceId === null) await write("upstream-A", workspaceId);
      for (const unresolved of [null, `legacy:${crypto.randomUUID()}`]) {
        await shared!.admin`update subscription_connections set provider_subject_id = ${unresolved}
          where account_id = ${org.accountId}::uuid and provider_account_id = 'chatgpt-team-identity'
          and provider_subject_id = 'upstream-A'
          and ownership = ${workspaceId === null ? "shared" : "personal"}`;
        for (const incoming of [null, "upstream-A", "upstream-C"]) {
          expect(await write(incoming, workspaceId)).toEqual({
            kind: "refused",
            reason: "identity_unverified",
          });
        }
        await shared!.admin`update subscription_connections set provider_subject_id = 'upstream-A'
          where account_id = ${org.accountId}::uuid and provider_account_id = 'chatgpt-team-identity'
          and provider_subject_id is not distinct from ${unresolved}
          and ownership = ${workspaceId === null ? "shared" : "personal"}`;
      }
      expect(await write("upstream-A", workspaceId)).toMatchObject({
        kind: "connected",
        isNew: false,
      });
    }
  });

  test("canonical and aliased resolve and repeated personal disconnect never change unrelated settings", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const a = await connect(org, org.ownerSubjectId, org.personalWorkspaceId, "resolve-A");
    const b = await connect(org, org.ownerSubjectId, org.personalWorkspaceId, "resolve-B");
    if (a.kind !== "connected" || b.kind !== "connected") throw new Error("connect failed");
    await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      setSubscriptionCoreCodexPrimary(client!.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.ownerSubjectId,
        connectionId: a.id,
      }),
    );
    const snapshot = () => shared!
      .admin`select to_jsonb(settings) as settings from subscription_settings settings
      where account_id = ${org.accountId}::uuid and workspace_id = ${org.personalWorkspaceId}::uuid`;
    const before = await snapshot();
    const alias = crypto.randomUUID();
    await shared!
      .admin`insert into subscription_connection_aliases(account_id, provider, alias_connection_id, connection_id)
      values (${org.accountId}::uuid, 'codex', ${alias}::uuid, ${b.id}::uuid)`;
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into subscription_operation_leases(account_id, workspace_id, operation_id, attempt_id, operation_kind,
        provider, connection_id, holder_id, generation, leased_until)
        values (${org.accountId}::uuid, ${org.personalWorkspaceId}::uuid, ${crypto.randomUUID()}::uuid,
          ${crypto.randomUUID()}::uuid, 'transcription', 'codex', ${b.id}::uuid, 'resolve-proof', 1, now() + interval '5 minutes')`;
    });
    for (const target of [b.id, alias]) {
      await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
          async (tx) => {
            const [resolved] = await rawRows<{ result: { id: string } }>(
              tx,
              sql`select opengeni_private.manage_subscription_codex_personal(${org.accountId}::uuid,
              ${org.personalWorkspaceId}::uuid, ${org.ownerSubjectId}, ${target}::uuid,
              'resolve', null, null, null) as result`,
            );
            expect(resolved!.result.id).toBe(b.id);
          },
        ),
      );
      expect(await snapshot()).toEqual(before);
      expect(
        (await disconnect(org, org.ownerSubjectId, org.personalWorkspaceId, target)).outcome,
      ).toBe("removed");
      expect(await snapshot()).toEqual(before);
    }
  });

  test("the owner-scoped writer and fences hold under a NOBYPASSRLS migration owner", async () => {
    const owned = await acquireOwnerMigratedTestDatabase("subscription-core-codex-writers-owner");
    if (!owned) throw new Error("Real PostgreSQL is required");
    const previous = { shared, client };
    let ownerClient: DbClient | null = null;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      ownerClient = createDb(appUrl.toString(), { max: 4 });
      shared = { ...previous.shared!, admin: owned.admin } as SharedTestDatabase;
      client = ownerClient;
      const [owner] = await owned.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        select rolsuper, rolbypassrls from pg_roles where rolname = ${owned.ownerRole}`;
      expect(owner).toEqual({ rolsuper: false, rolbypassrls: false });
      // The old binary inventories opengeni_private as its runtime API. New
      // owner-only implementations must not enter that inventory at all.
      const [executable] = await owned.admin<{ executable: boolean }[]>`
        select has_function_privilege('opengeni_app',
          'opengeni_subscription_internal.grant_subscription_codex_owner_capability(text,uuid,uuid,text,uuid)',
          'EXECUTE') as executable`;
      expect(executable).toEqual({ executable: false });
      const options = {
        rlsStrategy: "force" as const,
        expectedRole: "opengeni_app",
        targetSchema: "public",
      };
      const posture = await inspectRuntimeDatabasePosture(ownerClient!.db, options);
      expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
      expect(posture.subscriptionOwnerRoutines).toHaveLength(4);
      await disconnectDesignationCase();
      for (const routine of posture.subscriptionOwnerRoutines!) {
        expect(posture.privateRoutines.some((entry) => entry.name === routine.name)).toBe(false);
      }
      await personalCase();
      await organizationRedemptionCase();
    } finally {
      shared = previous.shared;
      client = previous.client;
      await ownerClient?.close();
      await owned.release();
    }
  }, 900_000);
});

async function personalCase(): Promise<void> {
  const org = await organization();
  await setCutover(org.accountId, true);
  const member = await person(org, "member");
  // The member connects in their own Personal workspace.
  const first = await connect(org, member.subjectId, member.personalWorkspaceId, "personal-one");
  expect(first).toMatchObject({ kind: "connected", isNew: true, ownership: "personal" });
  if (first.kind !== "connected") throw new Error("connect failed");
  expect(await row(first.id)).toMatchObject({
    ownership: "personal",
    scope_kind: "people",
    owner_subject_id: member.subjectId,
    authority_generation: "1",
    managed_by_workspace_id: null,
  });
  const [authority] = await shared!.admin<
    { resource_kind: string; status: string; generation: string; origin: string }[]
  >`select resource_kind, status, generation::text as generation,
      origin_workspace_id::text as origin
    from organization_user_resource_authorities where resource_id = ${first.id}::uuid`;
  expect(authority).toEqual({
    resource_kind: "subscription_connection",
    status: "active",
    generation: "1",
    origin: member.personalWorkspaceId,
  });
  // A second account keeps the owner's one generation; a reconnect replaces
  // the credential in place.
  const second = await connect(org, member.subjectId, member.personalWorkspaceId, "personal-two");
  if (second.kind !== "connected") throw new Error("connect failed");
  expect((await row(second.id))!.authority_generation).toBe("1");
  expect(
    await connect(org, member.subjectId, member.personalWorkspaceId, "personal-one"),
  ).toMatchObject({ kind: "connected", id: first.id, isNew: false });
  expect((await row(first.id))!.refresh_generation).toBe("2");
  expect((await row(first.id))!.connected_by_subject_id).toBeNull();

  // Listed to the owner in their Personal workspace, and to nobody else.
  const own = await personalAccounts(org, member.subjectId, member.personalWorkspaceId);
  expect(own.personalAccountIds?.sort()).toEqual([first.id, second.id].sort());
  expect(
    own.accounts.filter((account) => own.personalAccountIds?.includes(account.id)),
  ).toHaveLength(2);
  const adminView = await personalAccounts(org, org.ownerSubjectId, org.personalWorkspaceId);
  expect(adminView.accounts.some((account) => account.id === first.id)).toBe(false);
  const adminOrg = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    getSubscriptionCoreOrganizationCodexProjection(client!.db, {
      organizationId: org.accountId,
      subjectId: org.ownerSubjectId,
    }),
  );
  expect(adminOrg.accounts).toHaveLength(0);
  const [adminRead] = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    rawRows<{ total: number }>(
      client!.db,
      sql`select count(*)::int as total from opengeni_private.subscription_codex_personal_connections(
        ${org.accountId}::uuid, ${member.personalWorkspaceId}::uuid, ${member.subjectId})`,
    ),
  );
  expect(adminRead!.total).toBe(0);

  // Not in someone else's Personal workspace, not as an administrator on the
  // member's behalf, and not when personal connections are turned off.
  expect(await connect(org, org.ownerSubjectId, member.personalWorkspaceId, "takeover")).toEqual({
    kind: "refused",
    reason: "forbidden",
  });
  await shared!.admin`update subscription_settings set personal_connections_allowed = false
    where account_id = ${org.accountId}::uuid and workspace_id is null`;
  expect(
    await connect(org, member.subjectId, member.personalWorkspaceId, "personal-three"),
  ).toEqual({ kind: "refused", reason: "personal_connections_disabled" });
  await shared!.admin`update subscription_settings set personal_connections_allowed = true
    where account_id = ${org.accountId}::uuid and workspace_id is null`;

  // Only the owner removes it, and only from their Personal workspace.
  const personalAlias = crypto.randomUUID();
  await shared!.admin`insert into subscription_connection_aliases
    (account_id, provider, alias_connection_id, connection_id)
    values (${org.accountId}::uuid, 'codex', ${personalAlias}::uuid, ${first.id}::uuid)`;
  expect(
    (await disconnect(org, org.ownerSubjectId, member.personalWorkspaceId, personalAlias)).outcome,
  ).toBe("not_found");
  expect((await disconnect(org, org.ownerSubjectId, null, first.id)).outcome).toBe("not_found");
  expect((await disconnect(org, member.subjectId, org.sharedWorkspaceId, first.id)).outcome).toBe(
    "not_found",
  );
  const removed = await disconnect(
    org,
    member.subjectId,
    member.personalWorkspaceId,
    personalAlias,
  );
  expect(removed.outcome).toBe("removed");
  expect(removed.connectionId).toBe(first.id);
  expect(await row(first.id)).toBeNull();
  expect(
    (
      await setSubscriptionCoreCodexPrimary(client!.db, {
        accountId: org.accountId,
        workspaceId: member.personalWorkspaceId,
        subjectId: member.subjectId,
        connectionId: first.id,
      })
    ).activated,
  ).toBeNull();
  const [revoked] = await shared!.admin<{ status: string }[]>`
    select status from organization_user_resource_authorities where resource_id = ${first.id}::uuid`;
  expect(revoked).toEqual({ status: "revoked" });
  // Disconnect-all in the Personal workspace removes the rest atomically.
  const all = await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
    disconnectAllSubscriptionCoreCodexConnections(client!.db, {
      accountId: org.accountId,
      workspaceId: member.personalWorkspaceId,
      subjectId: member.subjectId,
    }),
  );
  expect(all).toMatchObject({ removed: 1, refused: null });
  expect(await row(second.id)).toBeNull();

  // "Running on": a turn on the owner's personal connection shows it only to
  // the owner.
  const third = await connect(org, member.subjectId, member.personalWorkspaceId, "personal-run");
  if (third.kind !== "connected") throw new Error("connect failed");
  expect((await row(third.id))!.authority_generation).toBe("2");
  const personalAdmin = {
    accountId: org.accountId,
    workspaceId: member.personalWorkspaceId,
    subjectId: member.subjectId,
    connectionId: third.id,
  };
  expect(
    await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
      renameSubscriptionCoreCodexConnection(client!.db, {
        ...personalAdmin,
        label: "renamed personal",
      }),
    ),
  ).toBe(third.id);
  expect(
    (
      await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
        setSubscriptionCoreCodexPrimary(client!.db, personalAdmin),
      )
    ).activated,
  ).toBe(third.id);
  const personalPool = await personalAccounts(org, member.subjectId, member.personalWorkspaceId);
  expect(personalPool.rotation.activeCredentialId).toBe(third.id);
  const account = personalPool.accounts.find((candidate) => candidate.id === third.id)!;
  expect(account.label).toBe("renamed personal");
  expect(
    (
      await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
        setSubscriptionCoreCodexAllocator(client!.db, {
          ...personalAdmin,
          enabled: false,
          expectedVersion: account.allocatorVersion,
        }),
      )
    ).result.kind,
  ).toBe("updated");
  expect(
    await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      renameSubscriptionCoreCodexConnection(client!.db, {
        ...personalAdmin,
        subjectId: org.ownerSubjectId,
        label: "stolen",
      }),
    ),
  ).toBeNull();
  const session = await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId: member.personalWorkspaceId,
      initialMessage: "personal running fixture",
      resources: [],
      metadata: {},
      model: MODEL,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: "user_private",
      subjectId: member.subjectId,
      createdBy: { kind: "subject", subjectId: member.subjectId },
      createdByContext: {},
    }),
  );
  const turn = await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId: org.accountId,
      workspaceId: member.personalWorkspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "personal running fixture",
      resources: [],
      tools: [],
      model: MODEL,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: member.subjectId },
    }),
  );
  const claimed = await claimSessionWorkForAttempt(client!.db, member.personalWorkspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claimed.action).toBe("claimed");
  // This low-level enqueue fixture bypasses HTTP acceptance; freeze each
  // historical snapshot explicitly, then exercise real placement revalidation.
  const freeze = (generation: number) =>
    shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update session_turns set subscription_authority = ${tx.json({ version: 2, personal: [{ provider: "codex", ownerMembershipId: member.membershipId, authorityGeneration: generation }] })}::jsonb
      where id = ${turn.id}::uuid`;
    });
  await freeze(2);
  const authorize = (generation: number) =>
    withSubscriptionCoreAcceptedTurn(
      client!.db,
      {
        accountId: org.accountId,
        workspaceId: member.personalWorkspaceId,
        sessionId: session.id,
        turnId: turn.id,
        sessionOwnerSubjectId: member.subjectId,
        sessionOwnerMembershipId: member.membershipId,
        initiatingHumanSubjectId: member.subjectId,
      },
      async (tx) => {
        const [authorization] = await rawRows<{ allowed: boolean }>(
          tx,
          sql`select opengeni_private.authorize_subscription_personal_placement_access(
        ${org.accountId}::uuid, ${member.personalWorkspaceId}::uuid, ${session.id}::uuid, ${turn.id}::uuid,
        'codex', ${member.membershipId}::uuid, ${generation}::bigint, ${member.subjectId}, ${member.subjectId}) as allowed`,
        );
        return authorization!.allowed;
      },
    );
  expect(await authorize(2)).toEqual({ status: "completed", value: true });
  // Fixture an old accepted snapshot. It cannot acquire the replacement
  // connection after disconnect-all, even though membership is unchanged.
  await freeze(1);
  expect(await authorize(1)).toEqual({ status: "completed", value: false });
  await insertLease({
    accountId: org.accountId,
    workspaceId: member.personalWorkspaceId,
    sessionId: session.id,
    turnId: turn.id,
    connectionId: third.id,
  });
  const view = await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
    getSubscriptionCoreSessionCodexAccounts(client!.db, {
      accountId: org.accountId,
      workspaceId: member.personalWorkspaceId,
      sessionId: session.id,
      viewerSubjectId: member.subjectId,
    }),
  );
  expect(view?.currentSelection).toEqual({ waiting: false, credentialId: third.id });
  expect(view?.currentAccount?.id).toBe(third.id);
  const anonymous = await withSessionRlsActorContext({ subjectId: member.subjectId }, () =>
    getSubscriptionCoreSessionCodexAccounts(client!.db, {
      accountId: org.accountId,
      workspaceId: member.personalWorkspaceId,
      sessionId: session.id,
    }),
  );
  expect(anonymous?.currentAccount).toBeNull();
  await shared!.admin`delete from subscription_leases where turn_id = ${turn.id}::uuid`;
}

async function organizationRedemptionCase(): Promise<void> {
  const org = await organization();
  await setCutover(org.accountId, true);
  const manager = await person(org, "admin");
  const connected = await connect(org, org.ownerSubjectId, null, "org-redeem");
  if (connected.kind !== "connected") throw new Error("connect failed");
  const connectionId = connected.id;
  const authority = (subjectId: string, workspaceId: string) =>
    withSessionRlsActorContext({ subjectId }, () =>
      readSubscriptionCoreCodexResetAuthority(client!.db, {
        accountId: org.accountId,
        workspaceId,
        credentialId: connectionId,
        subjectId,
      }),
    );
  // An organization account: the organization administrator, from any
  // workspace it serves; a workspace administrator is not its manager.
  expect(await authority(org.ownerSubjectId, org.sharedWorkspaceId)).toEqual({
    status: "active",
    owned: true,
  });
  expect(await authority(org.ownerSubjectId, org.otherWorkspaceId)).toEqual({
    status: "active",
    owned: true,
  });
  expect((await authority(manager.subjectId, org.sharedWorkspaceId))?.owned).not.toBe(true);

  const claimFrom = (
    workspaceId: string,
    attemptId: string,
    browser = "browser-a",
    creditId = "credit-org",
  ) =>
    withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      claimCodexResetRedemption(
        client!.db,
        {
          id: attemptId,
          accountId: org.accountId,
          workspaceId,
          credentialId: connectionId,
          subjectId: org.ownerSubjectId,
          browserSessionHash: browser,
          creditId,
          confirmationExpiresAt: new Date(Date.now() + 300_000),
          claimHolderId: crypto.randomUUID(),
        },
        subscriptionCoreCodexResetAuthority,
        subscriptionCoreCodexResetCreditFence,
      ),
    );
  const original = crypto.randomUUID();
  const started = await claimFrom(org.sharedWorkspaceId, original);
  expect(started.kind).toBe("claimed");
  if (started.kind !== "claimed") throw new Error("claim failed");
  const upstreamKey = started.attempt.upstreamIdempotencyKey;
  expect((await claimFrom(org.otherWorkspaceId, original)).kind).toBe("conflict");
  // The provider call started and its outcome is unknown; the claim lapsed.
  await shared!.admin`update codex_reset_redemption_attempts
    set status = 'provider_started', provider_started_at = now(), claim_expires_at = null,
      claim_holder_id = null
    where id = ${original}::uuid`;
  // Another logical attempt for the same credit from another workspace is
  // refused: the per-credit fence spans workspaces.
  expect((await claimFrom(org.otherWorkspaceId, crypto.randomUUID())).kind).toBe("conflict");
  const [count] = await shared!.admin<{ total: number }[]>`
    select count(*)::int as total from codex_reset_redemption_attempts
    where credential_id = ${connectionId}::uuid and credit_id = 'credit-org'`;
  expect(count!.total).toBe(1);
  await shared!
    .admin`update codex_reset_redemption_attempts set subject_id = 'user:another-human' where id = ${original}::uuid`;
  expect((await claimFrom(org.otherWorkspaceId, original)).kind).toBe("conflict");
  await shared!
    .admin`update codex_reset_redemption_attempts set subject_id = ${org.ownerSubjectId} where id = ${original}::uuid`;
  // The same person recovers their own attempt from the other workspace: it
  // moves there and resumes on its one upstream key.
  const fence = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    fenceSubscriptionCoreCodexResetCredit(client!.db, {
      accountId: org.accountId,
      workspaceId: org.otherWorkspaceId,
      credentialId: connectionId,
      subjectId: org.ownerSubjectId,
      creditId: "credit-org",
      attemptId: original,
    }),
  );
  expect(fence).toBe("refiled");
  const resumed = await claimFrom(org.otherWorkspaceId, original);
  expect(resumed.kind).toBe("claimed");
  if (resumed.kind !== "claimed") throw new Error("claim failed");
  expect(resumed.attempt.status).toBe("provider_started");
  expect(resumed.attempt.upstreamIdempotencyKey).toBe(upstreamKey);
  const [moved] = await shared!.admin<{ workspace_id: string }[]>`
    select workspace_id::text as workspace_id from codex_reset_redemption_attempts
    where id = ${original}::uuid`;
  expect(moved).toEqual({ workspace_id: org.otherWorkspaceId });
  // A workspace administrator has no organization-level authority to fence.
  const managerFence = await withSessionRlsActorContext({ subjectId: manager.subjectId }, () =>
    fenceSubscriptionCoreCodexResetCredit(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      credentialId: connectionId,
      subjectId: manager.subjectId,
      creditId: "credit-org",
      attemptId: original,
    }),
  );
  expect(managerFence).toBe("refused");
  const expired = crypto.randomUUID();
  expect((await claimFrom(org.sharedWorkspaceId, expired, "browser-a", "expired-claim")).kind).toBe(
    "claimed",
  );
  await shared!
    .admin`update codex_reset_redemption_attempts set claim_expires_at = now() - interval '1 hour' where id = ${expired}::uuid`;
  expect(
    (await claimFrom(org.otherWorkspaceId, crypto.randomUUID(), "browser-a", "expired-claim")).kind,
  ).toBe("claimed");
  const stale = await shared!
    .admin`select id from codex_reset_redemption_attempts where id = ${expired}::uuid`;
  expect(stale).toHaveLength(0);
}
