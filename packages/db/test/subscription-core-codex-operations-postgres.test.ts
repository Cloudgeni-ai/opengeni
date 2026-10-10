import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import { sql } from "drizzle-orm";
import {
  acquireSubscriptionCoreCodexOperationLease,
  appendSessionEvents,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  fetchSubscriptionCoreCodexUsage,
  ensureManagedAccessForUser,
  listSubscriptionCoreCodexOperationCandidates,
  placeSubscriptionCoreCodexTurn,
  loadSubscriptionCoreCodexConnectionCredential,
  readCodexCutoverDisposition,
  readSubscriptionCoreTurnIdentity,
  recordModelCallFact,
  recordSubscriptionCoreCodexUsageObservation,
  refreshSubscriptionCoreCodexConnectionCredential,
  releaseSubscriptionCoreCodexOperationLease,
  requestSessionCompaction,
  renewSubscriptionCoreCodexOperationLease,
  reserveSubscriptionCoreCodexOperationRequest,
  settleSubscriptionCoreCodexOperationRequest,
  resolveSubscriptionCoreCodexConnectionId,
  withSessionRlsActorContext,
  type DbClient,
  type SubscriptionCoreCodexOperationLeaseRef,
  type SubscriptionCoreCodexOperationScope,
  type SubscriptionCoreTurnIdentity,
} from "../src";
import { rawRows } from "../src/database";
import { subscriptionCoreCodexProvider } from "../src/subscription-core-codex-adapter";
import { subscriptionCoreOperations } from "../src/subscription-core/operations";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 43);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
const MODEL = "codex/gpt-5.5";

type TurnFixture = {
  identity: SubscriptionCoreTurnIdentity;
  attemptId: string;
  executionGeneration: number;
  holderId: string;
};

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-operations-v1");
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
    fedramp?: boolean;
  } = {},
): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at, managed_by_workspace_id, label
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens(label)},
      'shared', ${options.scope ?? "organization"}, ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: options.fedramp ?? false, resetCreditAvailableCount: 2 })}::jsonb,
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

async function personalConnection(org: Org, label: string): Promise<string> {
  // Placement needs the owner's personal-fallback opt-in.
  await shared!.admin`
    insert into subscription_person_preferences (
      account_id, organization_membership_id, personal_fallback_opt_in
    ) values (${org.accountId}::uuid, ${org.ownerMembershipId}::uuid, true)
    on conflict do nothing`;
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared!.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  await shared!.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state, expires_at
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'codex', ${encryptedTokens(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`chatgpt-${label}`},
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )`;
  return connectionId;
}

async function runningTurn(
  org: Org,
  input: {
    workspaceId: string;
    visibility?: "user_private" | "workspace_shared";
    owner?: "owner" | "none";
    initiator?: { kind: "subject"; subjectId: string } | { kind: "service" };
    personalAuthority?: boolean;
  },
): Promise<TurnFixture> {
  const ownerless = input.owner === "none";
  const createSessionCall = () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId: input.workspaceId,
      initialMessage: "core codex chat fixture",
      resources: [],
      metadata: {},
      model: MODEL,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(ownerless
        ? {}
        : {
            subjectId: org.ownerSubjectId,
            createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
            createdByContext: {},
          }),
    });
  const session = ownerless
    ? await createSessionCall()
    : await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, createSessionCall);
  const initiator = input.initiator ?? { kind: "subject", subjectId: org.ownerSubjectId };
  const actor =
    initiator.kind === "subject"
      ? { subjectId: initiator.subjectId }
      : { subjectId: "service:subscription-core", initiatingHumanSubjectId: null };
  const turn = await withSessionRlsActorContext(actor, () =>
    enqueueSessionTurn(client!.db, {
      accountId: org.accountId,
      workspaceId: input.workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "core codex chat fixture",
      resources: [],
      tools: [],
      model: MODEL,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator:
        initiator.kind === "subject"
          ? { kind: "subject", subjectId: initiator.subjectId }
          : { kind: "service", subjectId: "service:subscription-core" },
    }),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client!.db, input.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  expect(claimed.turn.id).toBe(turn.id);
  if (input.personalAuthority) {
    // Fixture only: the immutable-authority trigger admits only the table
    // owner, which is not this superuser in an owner-migrated database.
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
      update session_turns set subscription_authority = ${tx.json({
        version: 2,
        personal: [
          { provider: "codex", ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
        ],
      })}::jsonb
      where account_id = ${org.accountId}::uuid and id = ${turn.id}::uuid`;
    });
  }
  const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
    accountId: org.accountId,
    workspaceId: input.workspaceId,
    sessionId: session.id,
    turnId: turn.id,
  });
  if (!identity) throw new Error("accepted turn identity was not readable");
  return {
    identity,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    holderId: `codex-turn:${session.id}:${turn.id}:${attemptId}`,
  };
}

function ref(
  connectionId: string,
  overrides: Partial<SubscriptionCoreCodexOperationLeaseRef> = {},
): SubscriptionCoreCodexOperationLeaseRef {
  return {
    operationId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    operationKind: "image",
    connectionId,
    holderId: `holder:${crypto.randomUUID()}`,
    generation: 1,
    ...overrides,
  };
}

/** Place the turn's chat lease on the core (image operations require it). */
async function placeChat(turn: TurnFixture, connectionId: string): Promise<void> {
  const placed = await placeSubscriptionCoreCodexTurn(client!.db, {
    identity: turn.identity,
    attemptId: turn.attemptId,
    executionGeneration: turn.executionGeneration,
    holderId: turn.holderId,
    productModelId: MODEL,
    reasoningLevel: "medium",
    leaseTtlMs: 120_000,
  });
  expect(placed).toMatchObject({ kind: "run", connectionId });
}

async function chatState(turn: TurnFixture) {
  const rows = await shared!.admin<{ lease: string | null; binding: string | null }[]>`
    select (select string_agg(connection_id::text || ':' || holder_id || ':' || generation::text
              || ':' || leased_until::text, ',')
            from subscription_leases where turn_id = ${turn.identity.turnId}::uuid) as lease,
      (select string_agg(connection_id::text || ':' || version::text, ',')
       from subscription_session_bindings where session_id = ${turn.identity.sessionId}::uuid) as binding`;
  return rows[0]!;
}

function turnScope(turn: TurnFixture): SubscriptionCoreCodexOperationScope {
  return { kind: "turn", identity: turn.identity };
}

function workspaceScope(
  org: Org,
  workspaceId = org.sharedWorkspaceId,
  subjectId = org.ownerSubjectId,
): Extract<SubscriptionCoreCodexOperationScope, { kind: "workspace" }> {
  return { kind: "workspace", accountId: org.accountId, workspaceId, subjectId };
}

async function operationLeases(connectionId: string) {
  const rows = await shared!.admin<
    { operation_kind: string; session_id: string | null; turn_id: string | null }[]
  >`
    select operation_kind, session_id::text as session_id, turn_id::text as turn_id
    from subscription_operation_leases where connection_id = ${connectionId}::uuid
    order by updated_at`;
  return [...rows];
}

async function peopleConnection(org: Org, label: string): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at, label
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens(label)},
      'shared', 'people', ${`chatgpt-${label}`}, 'pro', '{}'::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label}
    ) returning id::text as id`;
  await shared!.admin`
    insert into subscription_connection_people (account_id, connection_id, organization_membership_id)
    values (${org.accountId}::uuid, ${row!.id}::uuid, ${org.ownerMembershipId}::uuid)`;
  return row!.id;
}

const rotate = async () => ({
  accessToken: "access-rotated",
  refreshToken: "refresh-rotated",
  idToken: "id-rotated",
});

describe.skipIf(!realDb)("Codex operations on the shared core (M3 PR 2c)", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test("without a cutover row, and with a disabled one, no operation reads, leases or refreshes", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "ops-gate");
    const scope = workspaceScope(org);
    for (const state of ["absent", "disabled"] as const) {
      if (state === "disabled") await setCutover(org.accountId, false);
      expect(await readCodexCutoverDisposition(client!.db, org.accountId)).toBe("maintenance");
      expect(await listSubscriptionCoreCodexOperationCandidates(client!.db, scope)).toEqual([]);
      const lease = ref(connectionId, { operationKind: "transcription" });
      expect(await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).toEqual({
        kind: "not_enabled",
      });
      expect(
        await loadSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          scope,
          connectionId,
          null,
        ),
      ).toEqual({ kind: "not_visible" });
      expect(
        await refreshSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          scope,
          connectionId,
          null,
          1,
          { refresh: rotate },
        ),
      ).toEqual({ kind: "refused" });
    }
    expect(await operationLeases(connectionId)).toEqual([]);
    expect(await connectionRefreshGeneration(connectionId)).toBe(1);
  });

  test("image operations lease the turn's connection per call, never the chat lease, fenced on generation", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "ops-image");
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    await placeChat(turn, connectionId);
    const chatBefore = await chatState(turn);
    expect(chatBefore.lease).not.toBeNull();
    const scope = turnScope(turn);
    const first = ref(connectionId, {
      attemptId: turn.attemptId,
      generation: turn.executionGeneration,
    });
    const second = ref(connectionId, {
      attemptId: turn.attemptId,
      generation: turn.executionGeneration,
    });
    const [a, b] = await Promise.all([
      acquireSubscriptionCoreCodexOperationLease(client!.db, scope, first),
      acquireSubscriptionCoreCodexOperationLease(client!.db, scope, second),
    ]);
    expect(a.kind).toBe("acquired");
    expect(b.kind).toBe("acquired");
    // A replay of the same holder and generation is idempotent.
    expect((await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, first)).kind).toBe(
      "acquired",
    );
    // Another holder of a live operation id is fenced.
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, {
          ...first,
          holderId: "intruder",
        })
      ).kind,
    ).toBe("busy");
    expect(await operationLeases(connectionId)).toEqual([
      {
        operation_kind: "image",
        session_id: turn.identity.sessionId,
        turn_id: turn.identity.turnId,
      },
      {
        operation_kind: "image",
        session_id: turn.identity.sessionId,
        turn_id: turn.identity.turnId,
      },
    ]);
    // The chat-turn lease and the session binding are untouched.
    expect(await chatState(turn)).toEqual(chatBefore);

    const loaded = await loadSubscriptionCoreCodexConnectionCredential(
      client!.db,
      settings,
      scope,
      connectionId,
      first,
    );
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind === "loaded")
      expect(loaded.credential.tokens.accessToken).toBe("access-ops-image");

    // A stale generation, holder or attempt cannot read, renew, refresh or release.
    for (const stale of [
      { ...first, generation: first.generation + 1 },
      { ...first, holderId: "other-holder" },
      { ...first, attemptId: crypto.randomUUID() },
    ]) {
      expect(
        await loadSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          scope,
          connectionId,
          stale,
        ),
      ).toEqual({ kind: "not_visible" });
      expect(await renewSubscriptionCoreCodexOperationLease(client!.db, scope, stale)).toBeNull();
      expect(
        await refreshSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          scope,
          connectionId,
          stale,
          1,
          { refresh: rotate },
        ),
      ).toEqual({ kind: "refused" });
      expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, scope, stale)).toBe(
        false,
      );
    }

    // The exact lease refreshes under the generation compare-and-swap.
    expect(
      await refreshSubscriptionCoreCodexConnectionCredential(
        client!.db,
        settings,
        scope,
        connectionId,
        first,
        1,
        { refresh: rotate },
      ),
    ).toEqual({ kind: "refreshed", accessToken: "access-rotated", refreshGeneration: 2 });
    expect(await connectionRefreshGeneration(connectionId)).toBe(2);
    // A refresh that observed the old generation is superseded, not replayed.
    expect(
      await refreshSubscriptionCoreCodexConnectionCredential(
        client!.db,
        settings,
        scope,
        connectionId,
        second,
        1,
        { refresh: rotate },
      ),
    ).toEqual({ kind: "superseded" });
    expect(await renewSubscriptionCoreCodexOperationLease(client!.db, scope, first)).toBeInstanceOf(
      Date,
    );
    expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, scope, first)).toBe(true);
    expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, scope, second)).toBe(true);
    expect(await operationLeases(connectionId)).toEqual([]);

    // Switch-off fails closed mid-operation: a live lease reads nothing.
    const third = ref(connectionId, {
      attemptId: turn.attemptId,
      generation: turn.executionGeneration,
    });
    expect((await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, third)).kind).toBe(
      "acquired",
    );
    await setCutover(org.accountId, false);
    expect(
      await loadSubscriptionCoreCodexConnectionCredential(
        client!.db,
        settings,
        scope,
        connectionId,
        third,
      ),
    ).toEqual({ kind: "not_visible" });
    expect(await renewSubscriptionCoreCodexOperationLease(client!.db, scope, third)).toBeNull();
  });

  test("personal connections serve only the owner's private turn under its frozen v2 authority", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const personal = await personalConnection(org, "ops-personal");
    const authorized = await runningTurn(org, {
      workspaceId: org.personalWorkspaceId,
      visibility: "user_private",
      personalAuthority: true,
    });
    await placeChat(authorized, personal);
    const lease = ref(personal, {
      attemptId: authorized.attemptId,
      generation: authorized.executionGeneration,
    });
    expect(
      (await acquireSubscriptionCoreCodexOperationLease(client!.db, turnScope(authorized), lease))
        .kind,
    ).toBe("acquired");
    expect(
      (
        await loadSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          turnScope(authorized),
          personal,
          lease,
        )
      ).kind,
    ).toBe("loaded");

    // The same owner's turn without frozen authority is refused.
    const unauthorized = await runningTurn(org, {
      workspaceId: org.personalWorkspaceId,
      visibility: "user_private",
    });
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(
          client!.db,
          turnScope(unauthorized),
          ref(personal, {
            attemptId: unauthorized.attemptId,
            generation: unauthorized.executionGeneration,
          }),
        )
      ).kind,
    ).toBe("refused");

    // Sessionless and session-bound operations never reach a personal or
    // people-scoped connection, even for its owner.
    const people = await peopleConnection(org, "ops-people");
    for (const connectionId of [personal, people]) {
      expect(
        (
          await acquireSubscriptionCoreCodexOperationLease(
            client!.db,
            workspaceScope(org, org.personalWorkspaceId),
            ref(connectionId, { operationKind: "transcription" }),
          )
        ).kind,
      ).toBe("refused");
      expect(
        (
          await acquireSubscriptionCoreCodexOperationLease(
            client!.db,
            {
              kind: "session",
              accountId: org.accountId,
              workspaceId: org.personalWorkspaceId,
              sessionId: authorized.identity.sessionId,
              sessionOwnerSubjectId: org.ownerSubjectId,
            },
            ref(connectionId, { operationKind: "realtime" }),
          )
        ).kind,
      ).toBe("refused");
      expect(
        await loadSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          workspaceScope(org, org.personalWorkspaceId),
          connectionId,
          null,
        ),
      ).toEqual({ kind: "not_visible" });
    }
    expect(
      (
        await listSubscriptionCoreCodexOperationCandidates(
          client!.db,
          workspaceScope(org, org.personalWorkspaceId),
        )
      ).map((candidate) => candidate.connectionId),
    ).toEqual([]);
  });

  test("sessionless transcription uses only shared capacity in its workspace scope, isolated by organization and workspace", async () => {
    const org = await organization();
    const other = await organization();
    await setCutover(org.accountId, true);
    await setCutover(other.accountId, true);
    const organizationScoped = await sharedConnection(org, "ops-org", { fedramp: true });
    const assignedHere = await sharedConnection(org, "ops-here", {
      scope: "workspaces",
      workspaces: [org.sharedWorkspaceId],
    });
    const scope = workspaceScope(org);
    expect(
      (await listSubscriptionCoreCodexOperationCandidates(client!.db, scope))
        .map((candidate) => candidate.connectionId)
        .sort(),
    ).toEqual([organizationScoped, assignedHere].sort());
    // The owner's Personal workspace is outside the workspace assignment.
    expect(
      (
        await listSubscriptionCoreCodexOperationCandidates(
          client!.db,
          workspaceScope(org, org.personalWorkspaceId),
        )
      ).map((candidate) => candidate.connectionId),
    ).toEqual([organizationScoped]);
    expect(
      await loadSubscriptionCoreCodexConnectionCredential(
        client!.db,
        settings,
        workspaceScope(org, org.personalWorkspaceId),
        assignedHere,
        null,
      ),
    ).toEqual({ kind: "not_visible" });
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(
          client!.db,
          workspaceScope(org, org.personalWorkspaceId),
          ref(assignedHere, { operationKind: "transcription" }),
        )
      ).kind,
    ).toBe("refused");

    const lease = ref(assignedHere, { operationKind: "transcription" });
    expect((await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).kind).toBe(
      "acquired",
    );
    expect(await operationLeases(assignedHere)).toEqual([
      { operation_kind: "transcription", session_id: null, turn_id: null },
    ]);
    // The operation credential read carries the connection's FedRAMP flag.
    const fedrampLease = ref(organizationScoped, { operationKind: "transcription" });
    expect(
      (await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, fedrampLease)).kind,
    ).toBe("acquired");
    const fedrampFlags = [];
    for (const [connectionId, held] of [
      [assignedHere, lease],
      [organizationScoped, fedrampLease],
    ] as const) {
      const loaded = await loadSubscriptionCoreCodexConnectionCredential(
        client!.db,
        settings,
        scope,
        connectionId,
        held,
      );
      fedrampFlags.push(loaded.kind === "loaded" ? loaded.credential.isFedramp : loaded.kind);
    }
    expect(fedrampFlags).toEqual([false, true]);
    expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, scope, fedrampLease)).toBe(
      true,
    );
    // Only a transcription may be sessionless.
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(
          client!.db,
          scope,
          ref(assignedHere, { operationKind: "realtime" }),
        )
      ).kind,
    ).toBe("refused");

    // Another organization cannot read, renew, release or list it, even with
    // forged arguments under its own context.
    const otherScope = workspaceScope(other);
    expect(await listSubscriptionCoreCodexOperationCandidates(client!.db, otherScope)).toEqual([]);
    const forged = await withSessionRlsActorContext({ subjectId: other.ownerSubjectId }, () =>
      rawRows(
        client!.db,
        sql`select 1 from opengeni_private.read_subscription_codex_connection_credential(
          ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${assignedHere}::uuid,
          ${lease.operationId}::uuid, ${lease.attemptId}::uuid, ${lease.holderId}, 1)`,
      ),
    );
    expect(forged).toEqual([]);
    const crossScope: SubscriptionCoreCodexOperationScope = {
      ...otherScope,
      accountId: other.accountId,
    };
    expect(
      await loadSubscriptionCoreCodexConnectionCredential(
        client!.db,
        settings,
        crossScope,
        assignedHere,
        lease,
      ),
    ).toEqual({ kind: "not_visible" });
    expect(
      await renewSubscriptionCoreCodexOperationLease(client!.db, crossScope, lease),
    ).toBeNull();
    expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, crossScope, lease)).toBe(
      false,
    );
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(
          client!.db,
          otherScope,
          ref(assignedHere, { operationKind: "transcription" }),
        )
      ).kind,
    ).toBe("refused");
    expect(
      await resolveSubscriptionCoreCodexConnectionId(client!.db, {
        accountId: other.accountId,
        workspaceId: other.sharedWorkspaceId,
        connectionId: assignedHere,
      }),
    ).toBeNull();
    expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).toBe(true);
  });

  test("a sessionless completion holds its own lease and reserves each request in workspace scope", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "ops-completion");
    const scope = workspaceScope(org);
    const lease = ref(connectionId, { operationKind: "completion" });
    expect((await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).kind).toBe(
      "acquired",
    );
    expect(await operationLeases(connectionId)).toEqual([
      { operation_kind: "completion", session_id: null, turn_id: null },
    ]);
    const reserved = await reserveSubscriptionCoreCodexOperationRequest(
      client!.db,
      scope,
      lease,
      connectionId,
      { requestId: `completion:${lease.operationId}:1`, transportAttempt: 1 },
    );
    const [request] = await shared!.admin<{ operation_kind: string; request_outcome: string }[]>`
      select operation_kind, request_outcome from subscription_operation_leases
      where operation_id = ${reserved.operationId}::uuid`;
    expect(request).toEqual({ operation_kind: "completion", request_outcome: "reserved" });
    await settleSubscriptionCoreCodexOperationRequest(client!.db, scope, {
      operationId: reserved.operationId,
      outcome: "response_received",
    });
    const [settled] = await shared!.admin<{ request_outcome: string }[]>`
      select request_outcome from subscription_operation_leases
      where operation_id = ${reserved.operationId}::uuid`;
    expect(settled).toEqual({ request_outcome: "response_received" });
    expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).toBe(true);
  });

  test("a connection credential that never renews is marked needs-relogin, only under an enabled cutover", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "ops-non-renewing", {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const scope = workspaceScope(org);
    // A binding of the registered provider whose adapter declares no refresh.
    const codex = subscriptionCoreCodexProvider();
    const operations = subscriptionCoreOperations({
      ...codex,
      adapter: { ...codex.adapter, refresh: null },
    });
    const statusOf = async () =>
      (
        await shared!.admin<{ status: string; last_error: string | null }[]>`
          select status, last_error from subscription_connections where id = ${connectionId}::uuid`
      )[0];
    // Without an enabled cutover nothing is written.
    expect(
      (
        await operations.refreshSubscriptionCoreConnectionCredential(
          client!.db,
          settings,
          scope,
          connectionId,
          null,
          1,
        )
      ).kind,
    ).toBe("refused");
    expect(await statusOf()).toEqual({ status: "active", last_error: null });
    await setCutover(org.accountId, true);
    const message = codex.adapter.reloginText("");
    expect(
      await operations.refreshSubscriptionCoreConnectionCredential(
        client!.db,
        settings,
        scope,
        connectionId,
        null,
        2,
      ),
    ).toEqual({ kind: "superseded" });
    expect(
      await operations.refreshSubscriptionCoreConnectionCredential(
        client!.db,
        settings,
        scope,
        connectionId,
        null,
        1,
      ),
    ).toEqual({ kind: "relogin", message, marked: true });
    expect(await statusOf()).toEqual({ status: "needs_relogin", last_error: message });
  });

  test("realtime leases are session-bound: owner context for owned sessions, shared-only for ownerless ones", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "ops-realtime");
    const owned = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const ownedScope: SubscriptionCoreCodexOperationScope = {
      kind: "session",
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: owned.identity.sessionId,
      sessionOwnerSubjectId: org.ownerSubjectId,
    };
    const lease = ref(connectionId, { operationKind: "realtime" });
    expect(
      (await acquireSubscriptionCoreCodexOperationLease(client!.db, ownedScope, lease)).kind,
    ).toBe("acquired");
    expect(await operationLeases(connectionId)).toEqual([
      { operation_kind: "realtime", session_id: owned.identity.sessionId, turn_id: null },
    ]);
    // Another person cannot stand in as the owner.
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(
          client!.db,
          { ...ownedScope, sessionOwnerSubjectId: `user:not-the-owner-${crypto.randomUUID()}` },
          ref(connectionId, { operationKind: "realtime" }),
        )
      ).kind,
    ).not.toBe("acquired");
    expect(await releaseSubscriptionCoreCodexOperationLease(client!.db, ownedScope, lease)).toBe(
      true,
    );

    const ownerless = await runningTurn(org, { workspaceId: org.sharedWorkspaceId, owner: "none" });
    const ownerlessScope: SubscriptionCoreCodexOperationScope = {
      kind: "session",
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sessionId: ownerless.identity.sessionId,
      sessionOwnerSubjectId: null,
    };
    const ownerlessLease = ref(connectionId, { operationKind: "realtime" });
    expect(
      (await acquireSubscriptionCoreCodexOperationLease(client!.db, ownerlessScope, ownerlessLease))
        .kind,
    ).toBe("acquired");
    expect(
      (
        await loadSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          ownerlessScope,
          connectionId,
          ownerlessLease,
        )
      ).kind,
    ).toBe("loaded");
    // An ownerless session cannot borrow a person's context.
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(
          client!.db,
          { ...ownerlessScope, sessionOwnerSubjectId: org.ownerSubjectId },
          ref(connectionId, { operationKind: "realtime" }),
        )
      ).kind,
    ).toBe("refused");
    // Only realtime is session-bound without a turn there.
    expect(
      (
        await acquireSubscriptionCoreCodexOperationLease(
          client!.db,
          ownerlessScope,
          ref(connectionId, { operationKind: "image" }),
        )
      ).kind,
    ).toBe("refused");
  });

  test("usage observations are fenced on the refresh generation and isolated by organization", async () => {
    const org = await organization();
    const other = await organization();
    await setCutover(org.accountId, true);
    await setCutover(other.accountId, true);
    const connectionId = await sharedConnection(org, "ops-usage");
    const observation = (generation: number, percent: number) => ({
      windows: [{ id: "primary", usedPercent: percent, resetsAt: null, status: "ok" as const }],
      modelCooldowns: {},
      exhaustedUntil: null,
      exhaustedKind: null,
      revision: 0,
      observedAt: Date.now(),
      observedRefreshGeneration: generation,
      source: "usage_endpoint" as const,
    });
    expect(
      await recordSubscriptionCoreCodexUsageObservation(
        client!.db,
        workspaceScope(org),
        connectionId,
        observation(1, 40),
      ),
    ).toEqual({ applied: true, recovered: false });
    // A reading from an older credential generation is not applied.
    expect(
      await recordSubscriptionCoreCodexUsageObservation(
        client!.db,
        workspaceScope(org),
        connectionId,
        observation(0, 99),
      ),
    ).toEqual({ applied: false, recovered: false });
    expect(
      await recordSubscriptionCoreCodexUsageObservation(
        client!.db,
        workspaceScope(other),
        connectionId,
        observation(1, 99),
      ),
    ).toEqual({ applied: false, recovered: false });
    const [quota] = await shared!.admin<{ used: number }[]>`
      select (quota->'windows'->0->>'usedPercent')::int as used
      from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
    expect(quota).toEqual({ used: 40 });
  });

  test("compaction turns copy the accepted v2 authority; core usage facts carry the connection", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "ops-compaction");
    const turn = await runningTurn(org, {
      workspaceId: org.personalWorkspaceId,
      visibility: "user_private",
      personalAuthority: true,
    });
    const { sessionId, turnId } = turn.identity;
    await appendSessionEvents(client!.db, org.personalWorkspaceId, sessionId, [
      { type: "turn.started", payload: {}, turnId },
    ]);
    const [trigger] = await shared!.admin<{ id: string }[]>`
      select trigger_event_id::text as id from session_turns where id = ${turnId}::uuid`;
    const settled = await applySessionTurnSettlement(client!.db, org.personalWorkspaceId, {
      sessionId,
      turnId,
      triggerEventId: trigger!.id,
      attemptId: turn.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
    await requestSessionCompaction(client!.db, org.personalWorkspaceId, sessionId);
    const claimed = await claimSessionWorkForAttempt(client!.db, org.personalWorkspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") return;
    expect(claimed.turn.source).toBe("compaction");
    const [authority] = await shared!.admin<{ source: unknown; compaction: unknown }[]>`
      select (select subscription_authority from session_turns where id = ${turnId}::uuid) as source,
        (select subscription_authority from session_turns where id = ${claimed.turn.id}::uuid) as compaction`;
    expect(authority!.compaction).toEqual(authority!.source);
    expect(authority!.compaction).toMatchObject({ version: 2 });

    const fact = await recordModelCallFact(client!.db, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      sessionId,
      turnId: claimed.turn.id,
      sourceKey: `response-${crypto.randomUUID()}`,
      provider: "codex",
      providerApi: "responses",
      model: MODEL,
      billingPath: "external",
      pricedCostMicros: 0,
      connectionId,
    });
    const [row] = await shared!.admin<{ connection_id: string | null }[]>`
      select connection_id::text as connection_id from model_call_facts where id = ${fact.id}::uuid`;
    expect(row).toEqual({ connection_id: connectionId });
  });
  test("an image operation needs its turn's running attempt, generation and live chat lease", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "ops-liveness");
    const operation = async (
      turn: TurnFixture,
      overrides: Partial<SubscriptionCoreCodexOperationLeaseRef> = {},
    ) => {
      const lease = ref(connectionId, {
        attemptId: turn.attemptId,
        generation: turn.executionGeneration,
        ...overrides,
      });
      return {
        lease,
        acquired: (
          await acquireSubscriptionCoreCodexOperationLease(client!.db, turnScope(turn), lease)
        ).kind,
      };
    };
    const readable = async (turn: TurnFixture, lease: SubscriptionCoreCodexOperationLeaseRef) =>
      (
        await loadSubscriptionCoreCodexConnectionCredential(
          client!.db,
          settings,
          turnScope(turn),
          connectionId,
          lease,
        )
      ).kind;

    // No chat lease yet: refused.
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect((await operation(turn)).acquired).toBe("refused");
    await placeChat(turn, connectionId);
    // A random attempt that was never active, or another generation, is refused.
    expect((await operation(turn, { attemptId: crypto.randomUUID() })).acquired).toBe("refused");
    expect((await operation(turn, { generation: 99 })).acquired).toBe("refused");
    const live = await operation(turn);
    expect(live.acquired).toBe("acquired");
    expect(await readable(turn, live.lease)).toBe("loaded");

    // A superseded execution generation stops reads and renewals of the old lease.
    await shared!.admin`update session_turns set execution_generation = execution_generation + 5
      where id = ${turn.identity.turnId}::uuid`;
    expect(await readable(turn, live.lease)).toBe("not_visible");
    expect(
      await renewSubscriptionCoreCodexOperationLease(client!.db, turnScope(turn), live.lease),
    ).toBeNull();
    await shared!.admin`update session_turns set execution_generation = execution_generation - 5
      where id = ${turn.identity.turnId}::uuid`;
    expect(await readable(turn, live.lease)).toBe("loaded");

    // A settled (cancelled) turn's stale attempt can neither acquire nor read.
    const [trigger] = await shared!.admin<{ id: string }[]>`
      select trigger_event_id::text as id from session_turns where id = ${turn.identity.turnId}::uuid`;
    const settled = await applySessionTurnSettlement(client!.db, org.sharedWorkspaceId, {
      sessionId: turn.identity.sessionId,
      turnId: turn.identity.turnId,
      triggerEventId: trigger!.id,
      attemptId: turn.attemptId,
      turnStatus: "cancelled",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.cancelled", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
    expect(await readable(turn, live.lease)).toBe("not_visible");
    expect(
      await renewSubscriptionCoreCodexOperationLease(client!.db, turnScope(turn), live.lease),
    ).toBeNull();
    expect((await operation(turn)).acquired).not.toBe("acquired");
  });

  test("a connection not readable in this workspace reports no data, not an error", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const people = await peopleConnection(org, "ops-usage-people");
    const personal = await personalConnection(org, "ops-usage-personal");
    for (const connectionId of [people, personal]) {
      const read = await fetchSubscriptionCoreCodexUsage(
        client!.db,
        settings,
        workspaceScope(org, org.personalWorkspaceId),
        connectionId,
        (async () => {
          throw new Error("no provider call for an unreadable connection");
        }) as never,
      );
      expect(read.usage.status).toBe("no-data");
      expect(read.recovered).toBe(false);
    }
  });

  test("the connection target helper is owner-only", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const connectionId = await sharedConnection(org, "ops-helper");
    const direct = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      rawRows(
        client!.db,
        sql`select id from opengeni_private.subscription_codex_connection_target(
          ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${connectionId}::uuid,
          null, null, null, null)`,
      ),
    ).catch((error: unknown) => error);
    expect(String((direct as { cause?: unknown })?.cause ?? direct)).toContain("permission denied");
  });

  test("personal reads and renewals recheck current settings and authority explicitly", async () => {
    await personalRevocationCase();
  });

  test("personal reads and renewals recheck explicitly under a NOBYPASSRLS migration owner", async () => {
    const owned = await acquireOwnerMigratedTestDatabase(
      "subscription-core-codex-operations-owner",
    );
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
      // Role provisioning grants every opengeni_private routine; the target
      // helper is revoked again after that blanket grant.
      const [executable] = await owned.admin<{ executable: boolean }[]>`
        select has_function_privilege('opengeni_app',
          'opengeni_private.subscription_codex_connection_target(uuid,uuid,uuid,uuid,uuid,text,bigint)',
          'EXECUTE') as executable`;
      expect(executable).toEqual({ executable: false });
      await personalRevocationCase();
    } finally {
      shared = previous.shared;
      client = previous.client;
      await ownerClient?.close();
      await owned.release();
    }
  }, 900_000);
});

async function personalRevocationCase(): Promise<void> {
  const org = await organization();
  await setCutover(org.accountId, true);
  const personal = await personalConnection(org, "ops-revocation");
  const turn = await runningTurn(org, {
    workspaceId: org.personalWorkspaceId,
    visibility: "user_private",
    personalAuthority: true,
  });
  await placeChat(turn, personal);
  const lease = ref(personal, { attemptId: turn.attemptId, generation: turn.executionGeneration });
  const scope = turnScope(turn);
  expect((await acquireSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).kind).toBe(
    "acquired",
  );
  const readable = async () =>
    (
      await loadSubscriptionCoreCodexConnectionCredential(
        client!.db,
        settings,
        scope,
        personal,
        lease,
      )
    ).kind;
  expect(await readable()).toBe("loaded");

  // Personal connections switched off: no read, no renewal.
  await shared!.admin`update subscription_settings set personal_connections_allowed = false
    where account_id = ${org.accountId}::uuid and workspace_id is null`;
  expect(await readable()).toBe("not_visible");
  expect(await renewSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).toBeNull();
  await shared!.admin`update subscription_settings set personal_connections_allowed = true
    where account_id = ${org.accountId}::uuid and workspace_id is null`;
  expect(await readable()).toBe("loaded");

  // The owner's resource authority revoked: no read, no renewal.
  await shared!.admin`update organization_user_resource_authorities
    set status = 'revoked', revoked_at = now() where resource_id = ${personal}::uuid`;
  expect(await readable()).toBe("not_visible");
  expect(await renewSubscriptionCoreCodexOperationLease(client!.db, scope, lease)).toBeNull();
}

async function connectionRefreshGeneration(connectionId: string): Promise<number> {
  const [row] = await shared!.admin<{ generation: string }[]>`
    select refresh_generation::text as generation from subscription_connections
    where id = ${connectionId}::uuid`;
  return Number(row!.generation);
}
