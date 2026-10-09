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
  ensureManagedAccessForUser,
  listSubscriptionCoreCodexOperationCandidates,
  loadSubscriptionCoreCodexConnectionCredential,
  readCodexCutoverDisposition,
  readSubscriptionCoreTurnIdentity,
  recordModelCallFact,
  recordSubscriptionCoreCodexUsageObservation,
  refreshSubscriptionCoreCodexConnectionCredential,
  releaseSubscriptionCoreCodexOperationLease,
  requestSessionCompaction,
  renewSubscriptionCoreCodexOperationLease,
  resolveSubscriptionCoreCodexConnectionId,
  withSessionRlsActorContext,
  type DbClient,
  type SubscriptionCoreCodexOperationLeaseRef,
  type SubscriptionCoreCodexOperationScope,
  type SubscriptionCoreTurnIdentity,
} from "../src";
import { rawRows } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

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

async function personalConnection(org: Org, label: string): Promise<string> {
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
    await shared!.admin`
      update session_turns set subscription_authority = ${shared!.admin.json({
        version: 2,
        personal: [
          { provider: "codex", ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
        ],
      })}::jsonb
      where account_id = ${org.accountId}::uuid and id = ${turn.id}::uuid`;
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
      expect(await readCodexCutoverDisposition(client!.db, org.accountId)).toBe(
        state === "absent" ? "legacy" : "maintenance",
      );
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
    // The chat-turn lease table and the session binding are untouched.
    const [chat] = await shared!.admin<{ leases: number; bindings: number }[]>`
      select (select count(*)::int from subscription_leases where turn_id = ${turn.identity.turnId}::uuid) as leases,
        (select count(*)::int from subscription_session_bindings where session_id = ${turn.identity.sessionId}::uuid) as bindings`;
    expect(chat).toEqual({ leases: 0, bindings: 0 });

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
    const organizationScoped = await sharedConnection(org, "ops-org");
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
});

async function connectionRefreshGeneration(connectionId: string): Promise<number> {
  const [row] = await shared!.admin<{ generation: string }[]>`
    select refresh_generation::text as generation from subscription_connections
    where id = ${connectionId}::uuid`;
  return Number(row!.generation);
}
