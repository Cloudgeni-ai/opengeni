import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  resolveTurnExecutionPolicyV1,
  configuredModels,
  withCodexCatalogProvider,
  type Settings,
} from "@opengeni/config";
import { CodexReloginRequired } from "@opengeni/codex";
import { sql } from "drizzle-orm";
import {
  acquireSubscriptionTurnLease,
  canSpendSubscriptionCoreCodexExtraCredits,
  buildSubscriptionCoreCodexTokenResolver,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  disconnectSubscriptionCoreCodexConnection,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  loadSubscriptionCoreCodexCredential,
  placeSubscriptionCoreCodexTurn,
  evaluateSubscriptionCoreCodexPlacement,
  recordSubscriptionCoreCodexModelCatalog,
  readSubscriptionCoreTurnIdentity,
  readSubscriptionSessionBinding,
  reserveSubscriptionCoreCodexRequest,
  recordSubscriptionCoreCodexQuotaObservation,
  recordSubscriptionCoreCodexSelectionForTurnAttempt,
  recordSubscriptionCoreCodexTurnFailure,
  refreshSubscriptionCoreCodexCredential,
  releaseSubscriptionTurnLease,
  requestSessionTurnRecovery,
  SubscriptionCoreCodexAccessLostError,
  subscriptionCoreTurnActor,
  touchSubscriptionCoreCodexBinding,
  withRlsContext,
  withSessionRlsActorContext,
  writeSubscriptionSessionBinding,
  SubscriptionCoreCodexLeaseLostError,
  type DbClient,
  type SubscriptionCoreTurnIdentity,
} from "../src";
import { rawRows } from "../src/database";
import { subscriptionCoreCodexProvider } from "../src/subscription-core-codex-adapter";
import { subscriptionCoreTurns } from "../src/subscription-core/turns";
import { encryptEnvironmentValue, decryptEnvironmentValue } from "../src/environment-crypto";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 91);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
const MODEL = "codex/gpt-5.5";
const TTL = 120_000;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-chat-v1");
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
  const userId = `core-codex-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex chat fixture",
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
    values (${accountId}::uuid, 'Core Codex shared workspace') returning id::text as id`;
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
  await shared!.admin`
    insert into subscription_person_preferences (
      account_id, organization_membership_id, personal_fallback_opt_in
    ) values (${accountId}::uuid, ${membership!.id}::uuid, true)`;
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: sharedWorkspace!.id,
  };
}

async function enableCodexCutover(accountId: string, enabled = true): Promise<void> {
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

async function sharedConnection(
  org: Org,
  input: { workspaceId: string; label: string; expiresAt?: Date | null },
): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens(input.label)},
      'shared', 'organization', ${`chatgpt-${input.label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${(input.expiresAt === undefined ? new Date(Date.now() + 86_400_000) : input.expiresAt)?.toISOString() ?? null}::timestamptz
    ) returning id::text as id`;
  for (const workspaceId of [org.personalWorkspaceId, org.sharedWorkspaceId]) {
    await shared!.admin`
      insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool
      ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid, 'organization')`;
  }
  void input.workspaceId;
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
      authority_resource_kind, authority_generation, provider_account_id, provider_state,
      expires_at
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'codex', ${encryptedTokens(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`chatgpt-${label}`},
      ${shared!.admin.json({ isFedramp: true })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )`;
  return connectionId;
}

type TurnFixture = {
  identity: SubscriptionCoreTurnIdentity;
  attemptId: string;
  executionGeneration: number;
  holderId: string;
};

/** A claimed, running turn: the exact state the worker places from. */
async function runningTurn(
  org: Org,
  input: {
    workspaceId: string;
    visibility?: "user_private" | "workspace_shared";
    owner?: "owner" | "none";
    initiator?: { kind: "subject"; subjectId: string } | { kind: "service" };
    personalAuthority?: boolean;
    upstreamModelId?: string;
  },
): Promise<TurnFixture> {
  const catalog = withCodexCatalogProvider(testSettings({ codexSubscriptionEnabled: true }));
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
      metadata: input.upstreamModelId
        ? {
            turnExecutionPolicyV1: {
              ...resolveTurnExecutionPolicyV1(catalog, {
                modelId: configuredModels(catalog).find(
                  (model) =>
                    model.credentialSource.kind === "connected_subscription" &&
                    model.credentialSource.provider === "codex",
                )!.id,
                requestedModelId: null,
                modelSource: "session",
                reasoningEffort: "medium",
                reasoningSource: "session",
              }),
              productModelId: MODEL,
              upstreamModelId: input.upstreamModelId,
            },
          }
        : {},
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

function place(turn: TurnFixture, overrides: Partial<TurnFixture> = {}) {
  const merged = { ...turn, ...overrides };
  return placeSubscriptionCoreCodexTurn(client!.db, {
    identity: merged.identity,
    attemptId: merged.attemptId,
    executionGeneration: merged.executionGeneration,
    holderId: merged.holderId,
    productModelId: MODEL,
    reasoningLevel: "medium",
    leaseTtlMs: TTL,
  });
}

function leaseOf(turn: TurnFixture, connectionId: string) {
  return { connectionId, holderId: turn.holderId, generation: turn.executionGeneration };
}

async function leaseRows(
  org: Org,
  turn: TurnFixture,
): Promise<Array<{ connection_id: string; holder_id: string; generation: string }>> {
  const rows = await shared!.admin<
    { connection_id: string; holder_id: string; generation: string }[]
  >`
    select connection_id::text as connection_id, holder_id, generation::text as generation
    from subscription_leases
    where account_id = ${org.accountId}::uuid and turn_id = ${turn.identity.turnId}::uuid`;
  return rows.map((row) => ({ ...row }));
}

describe.skipIf(!realDb)("Codex chat turns on the shared subscription core", () => {
  test("live credit consent preserves held leases after pause, honors revocation and yields to included capacity", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "credit-consent",
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    const admitted = () =>
      canSpendSubscriptionCoreCodexExtraCredits(client!.db, {
        ...turn,
        connectionId,
        productModelId: MODEL,
        reasoningLevel: "medium",
        leaseTtlMs: TTL,
      });
    expect(await admitted()).toBe(false);
    await shared!
      .admin`update subscription_connections set extra_credits_enabled=true,allocator_enabled=false where id=${connectionId}::uuid`;
    expect(await admitted()).toBe(true);
    await shared!
      .admin`update subscription_connections set extra_credits_enabled=false where id=${connectionId}::uuid`;
    expect(await admitted()).toBe(false);
    await shared!
      .admin`update subscription_connections set extra_credits_enabled=true where id=${connectionId}::uuid`;
    await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "included-alternative",
    });
    expect(await admitted()).toBe(false);
    await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      (tx) =>
        releaseSubscriptionTurnLease(tx, {
          ...turn.identity,
          ...leaseOf(turn, connectionId),
          provider: "codex",
        }),
    );
    expect(await admitted()).toBe(false);
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

  test("placement refuses unless the Codex cutover row is enabled in the same transaction", async () => {
    const org = await organization();
    await sharedConnection(org, { workspaceId: org.sharedWorkspaceId, label: "gate" });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toEqual({ kind: "cutover_not_enabled" });
    await enableCodexCutover(org.accountId, false);
    expect(await place(turn)).toEqual({ kind: "cutover_not_enabled" });
    expect(await leaseRows(org, turn)).toEqual([]);
    await enableCodexCutover(org.accountId, true);
    expect(await place(turn)).toMatchObject({ kind: "run" });
  });

  test("shared placement leases, binds, records the selection and materializes the token", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "shared",
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(turn.identity).toMatchObject({
      sessionOwnerSubjectId: org.ownerSubjectId,
      sessionOwnerMembershipId: org.ownerMembershipId,
      initiatingHumanSubjectId: org.ownerSubjectId,
      acceptedAuthorityV2: { version: 2, personal: [] },
    });

    const placed = await place(turn);
    expect(placed).toMatchObject({
      kind: "run",
      connectionId,
      personal: false,
      switch: "initial",
      reusedLease: false,
      explicit: false,
      previousConnectionId: null,
      rotationMode: "spread",
      eligibleCount: 1,
      connectedCount: 1,
    });
    expect(await leaseRows(org, turn)).toEqual([
      {
        connection_id: connectionId,
        holder_id: turn.holderId,
        generation: String(turn.executionGeneration),
      },
    ]);
    const binding = await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      (db) => readSubscriptionSessionBinding(db, turn.identity),
    );
    expect(binding).toMatchObject({
      provider: "codex",
      connectionId,
      modelId: MODEL,
      choice: "automatic",
      lastSwitchReason: "initial",
      version: 1,
    });

    // A Temporal retry of the same attempt reuses its exact live lease.
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId, reusedLease: true });
    // Another holder of the same generation is not this attempt.
    expect(await place(turn, { holderId: "codex-turn:intruder" })).toEqual({
      kind: "attempt_fenced",
    });
    // A stale attempt id is fenced before any lease is touched.
    expect(await place(turn, { attemptId: crypto.randomUUID() })).toEqual({
      kind: "attempt_fenced",
    });

    const selection = await recordSubscriptionCoreCodexSelectionForTurnAttempt(client!.db, {
      workspaceId: org.sharedWorkspaceId,
      sessionId: turn.identity.sessionId,
      turnId: turn.identity.turnId,
      attemptId: turn.attemptId,
      executionGeneration: turn.executionGeneration,
      credentialId: connectionId,
      previousCredentialId: null,
      strategy: "spread",
      reusedLease: false,
      pinnedCredentialId: null,
      eligibleCount: 1,
      connectedCount: 1,
    });
    expect(selection.events.map((event) => event.type)).toEqual(["codex.credential.selected"]);
    expect(selection.events[0]!.payload).toMatchObject({
      credentialId: connectionId,
      transition: "assigned",
      source: "allocator",
      previousCredentialId: null,
    });
    // The legacy session pointer never receives a core connection id.
    const [sessionRow] = await shared!.admin<{ codex_last_credential_id: string | null }[]>`
      select codex_last_credential_id::text as codex_last_credential_id from sessions
      where id = ${turn.identity.sessionId}::uuid`;
    expect(sessionRow!.codex_last_credential_id).toBeNull();

    const loaded = await loadSubscriptionCoreCodexCredential(
      client!.db,
      settings,
      turn.identity,
      leaseOf(turn, connectionId),
    );
    expect(loaded).toMatchObject({
      kind: "loaded",
      credential: {
        connectionId,
        ownership: "shared",
        refreshGeneration: 1,
        tokens: {
          accessToken: "access-shared",
          refreshToken: "refresh-shared",
          idToken: "id-shared",
        },
        chatgptAccountId: "chatgpt-shared",
        isFedramp: false,
        planType: "pro",
      },
    });
    const resolver = buildSubscriptionCoreCodexTokenResolver(
      client!.db,
      settings,
      turn.identity,
      leaseOf(turn, connectionId),
    );
    expect(await resolver.getToken()).toEqual({
      accessToken: "access-shared",
      chatgptAccountId: "chatgpt-shared",
      isFedramp: false,
      credentialVersion: 1,
      planType: "pro",
    });

    // Lease loss blocks credential materialization (and therefore dispatch).
    await withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
      withRlsContext(
        client!.db,
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        (db) =>
          releaseSubscriptionTurnLease(db, {
            ...turn.identity,
            provider: "codex",
            ...leaseOf(turn, connectionId),
          }),
      ),
    );
    expect(await leaseRows(org, turn)).toEqual([]);
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, connectionId),
      ),
    ).toEqual({ kind: "lease_lost" });
    await expect(resolver.getToken()).rejects.toBeInstanceOf(SubscriptionCoreCodexLeaseLostError);
  });

  test("the core lease is renewed, fenced and released under the core turn actor", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "renew",
    });
    // A private session: the lease row inherits the session's visibility.
    const turn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      visibility: "user_private",
    });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    const actor = subscriptionCoreTurnActor(turn.identity);
    expect(actor).toEqual({
      subjectId: "service:subscription-core",
      initiatingHumanSubjectId: org.ownerSubjectId,
    });
    const identity = {
      ...turn.identity,
      provider: "codex" as const,
      ...leaseOf(turn, connectionId),
    };
    const scoped = <T>(operation: (db: DbClient["db"]) => Promise<T>) =>
      withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          operation,
        ),
      );
    const { renewSubscriptionTurnLease, assertSubscriptionTurnLeaseCurrent } =
      await import("../src");
    expect(
      await scoped((db) => renewSubscriptionTurnLease(db, { ...identity, ttlMs: TTL })),
    ).toBeInstanceOf(Date);
    expect(await scoped((db) => assertSubscriptionTurnLeaseCurrent(db, identity))).toBe(true);
    expect(
      await scoped((db) =>
        assertSubscriptionTurnLeaseCurrent(db, {
          ...identity,
          generation: identity.generation + 1,
        }),
      ),
    ).toBe(false);
    expect(await scoped((db) => releaseSubscriptionTurnLease(db, identity))).toBe(true);
  });

  test("an explicit pin is honoured and waits instead of failing over", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const pinned = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "pin",
    });
    const other = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "other",
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    await withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
      withRlsContext(
        client!.db,
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        async (db) =>
          expect(
            await writeSubscriptionSessionBinding(db, {
              accountId: org.accountId,
              workspaceId: org.sharedWorkspaceId,
              sessionId: turn.identity.sessionId,
              provider: "codex",
              connectionId: pinned,
              modelId: MODEL,
              choice: "explicit",
              onlyThisModel: false,
              lastModelCallAt: null,
              lastSwitchReason: "explicit_choice",
            }),
          ).toBe(1),
      ),
    );
    expect(await place(turn)).toMatchObject({
      kind: "run",
      connectionId: pinned,
      switch: "pinned",
      explicit: true,
    });
    await withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
      withRlsContext(
        client!.db,
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        (db) =>
          releaseSubscriptionTurnLease(db, {
            ...turn.identity,
            provider: "codex",
            ...leaseOf(turn, pinned),
          }),
      ),
    );

    // The pinned account is exhausted until a known reset: wait, never move to `other`.
    const resetAt = Date.now() + 3_600_000;
    await shared!.admin`
      insert into subscription_connection_quota (account_id, connection_id, quota, observed_refresh_generation)
      values (${org.accountId}::uuid, ${pinned}::uuid, ${shared!.admin.json({
        windows: [],
        modelCooldowns: {},
        exhaustedUntil: resetAt,
        exhaustedKind: "quota",
        source: "refusal",
      })}::jsonb, 1)`;
    expect(await place(turn)).toEqual({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: new Date(resetAt),
      healthRetryAt: null,
      explicitConnectionId: pinned,
    });
    expect(await leaseRows(org, turn)).toEqual([]);

    // An unhealthy pin still waits for that account (D-24)...
    await shared!.admin`
      update subscription_connections set status = 'needs_relogin' where id = ${pinned}::uuid`;
    expect(await place(turn)).toMatchObject({
      kind: "wait",
      reason: "pinned_account_unavailable",
    });
    // ...and a pin that can never serve this work says so. (An organization-
    // scope connection without an assignment row in a workspace keeps its
    // management classification since M3 PR 3b, so the pin is made
    // permanently ineligible through this workspace's assignment model
    // policy instead.)
    await shared!.admin`
      update subscription_connections set status = 'active' where id = ${pinned}::uuid`;
    await shared!.admin`
      update subscription_connection_assignment_policies set allowed_model_ids = array['codex/other']
      where connection_id = ${pinned}::uuid and workspace_id = ${org.sharedWorkspaceId}::uuid`;
    expect(await place(turn)).toMatchObject({
      kind: "wait",
      reason: "pinned_account_ineligible",
    });
    const binding = await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      (db) => readSubscriptionSessionBinding(db, turn.identity),
    );
    expect(binding).toMatchObject({ connectionId: pinned, choice: "explicit" });
    expect(
      (
        await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
          disconnectSubscriptionCoreCodexConnection(client!.db, {
            accountId: org.accountId,
            workspaceId: null,
            subjectId: org.ownerSubjectId,
            connectionId: pinned,
          }),
        )
      ).outcome,
    ).toBe("removed");
    expect(await place(turn)).toMatchObject({ kind: "wait", explicitConnectionId: pinned });
    expect(await leaseRows(org, turn)).toEqual([]);
    void other;
  });

  test("a disconnected automatic source re-places the continuation, then waits when none remain", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    await sharedConnection(org, { workspaceId: org.sharedWorkspaceId, label: "drain-first" });
    await sharedConnection(org, { workspaceId: org.sharedWorkspaceId, label: "drain-second" });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const initial = await place(turn);
    if (initial.kind !== "run") throw new Error("initial placement failed");
    const remove = (connectionId: string) =>
      withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
        disconnectSubscriptionCoreCodexConnection(client!.db, {
          accountId: org.accountId,
          workspaceId: null,
          subjectId: org.ownerSubjectId,
          connectionId,
        }),
      );
    expect((await remove(initial.connectionId)).outcome).toBe("removed");
    // Retaining the original turn lease protects its response writer, but is
    // not permission for another request to reuse this disconnected source.
    const next = await place(turn);
    if (next.kind !== "run") throw new Error("continuation did not re-place");
    expect(next.connectionId).not.toBe(initial.connectionId);
    expect((await remove(next.connectionId)).outcome).toBe("removed");
    expect(await place(turn)).toMatchObject({ kind: "wait" });
    expect(await leaseRows(org, turn)).toEqual([]);
  });

  test("a personal connection serves only its owner's own work with a matching v2 entry", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const personal = await personalConnection(org, "mine");

    // Owner's own turn in their Personal workspace with the frozen v2 entry.
    const own = await runningTurn(org, {
      workspaceId: org.personalWorkspaceId,
      personalAuthority: true,
    });
    expect(own.identity.acceptedAuthorityV2.personal).toEqual([
      { provider: "codex", ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
    ]);
    expect(await place(own)).toMatchObject({ kind: "run", connectionId: personal, personal: true });
    const loaded = await loadSubscriptionCoreCodexCredential(
      client!.db,
      settings,
      own.identity,
      leaseOf(own, personal),
    );
    expect(loaded).toMatchObject({
      kind: "loaded",
      credential: {
        ownership: "personal",
        chatgptAccountId: "chatgpt-mine",
        isFedramp: true,
        tokens: { accessToken: "access-mine" },
      },
    });

    // Same session owner, but a service acceptance freezes empty personal authority.
    const unfrozen = await runningTurn(org, {
      workspaceId: org.personalWorkspaceId,
      initiator: { kind: "service" },
    });
    expect(await place(unfrozen)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });

    // The owner's shared-workspace session with a v2 entry is not their own work.
    const sharedSession = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      personalAuthority: true,
    });
    expect(await place(sharedSession)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
    });
    // ...and the database refuses a direct lease on it even from a buggy caller.
    await expect(
      withSessionRlsActorContext(subscriptionCoreTurnActor(sharedSession.identity), () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          (db) =>
            acquireSubscriptionTurnLease(db, {
              ...sharedSession.identity,
              provider: "codex",
              ...leaseOf(sharedSession, personal),
              ttlMs: TTL,
            }),
        ),
      ),
    ).rejects.toThrow();

    // A private session of the owner in a shared workspace is their own work.
    const privateTurn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      visibility: "user_private",
      personalAuthority: true,
    });
    expect(await place(privateTurn)).toMatchObject({ kind: "run", connectionId: personal });

    // A service turn in the owner's Personal workspace has no personal authority.
    const service = await runningTurn(org, {
      workspaceId: org.personalWorkspaceId,
      initiator: { kind: "service" },
      personalAuthority: true,
    });
    expect(service.identity.initiatingHumanSubjectId).toBeNull();
    // The core actor shows the owner as initiating human only for session
    // visibility; personal access follows the stored NULL turn human.
    expect(subscriptionCoreTurnActor(service.identity)).toEqual({
      subjectId: "service:subscription-core",
      initiatingHumanSubjectId: org.ownerSubjectId,
    });
    expect(await place(service)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    await expect(
      withSessionRlsActorContext(subscriptionCoreTurnActor(service.identity), () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
          (db) =>
            acquireSubscriptionTurnLease(db, {
              ...service.identity,
              provider: "codex",
              ...leaseOf(service, personal),
              ttlMs: TTL,
            }),
        ),
      ),
    ).rejects.toThrow();
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        service.identity,
        leaseOf(service, personal),
      ),
    ).toEqual({ kind: "lease_lost" });

    // Before the drained cutover the v2 entry grants nothing.
    await enableCodexCutover(org.accountId, false);
    const afterSwitchOff = await runningTurn(org, {
      workspaceId: org.personalWorkspaceId,
      personalAuthority: true,
    });
    expect(await place(afterSwitchOff)).toEqual({ kind: "cutover_not_enabled" });
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        own.identity,
        leaseOf(own, personal),
      ),
    ).toEqual({ kind: "not_visible" });
  });

  test("a co-member's turn never uses the owner's personal connection", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const personal = await personalConnection(org, "owner-only");
    const coMemberSubjectId = `user:core-codex-co-member-${crypto.randomUUID()}`;
    const [coWorkspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${org.accountId}::uuid, 'Co-member Personal') returning id::text as id`;
    await shared!.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${org.accountId}::uuid, ${coMemberSubjectId}, 'member', 'active', ${coWorkspace!.id}::uuid
      )`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${coMemberSubjectId}, 'member')`;
    const turn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      initiator: { kind: "subject", subjectId: coMemberSubjectId },
      personalAuthority: true,
    });
    expect(turn.identity).toMatchObject({
      sessionOwnerSubjectId: org.ownerSubjectId,
      initiatingHumanSubjectId: coMemberSubjectId,
    });
    expect(await place(turn)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    await expect(
      withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          (db) =>
            acquireSubscriptionTurnLease(db, {
              ...turn.identity,
              provider: "codex",
              ...leaseOf(turn, personal),
              ttlMs: TTL,
            }),
        ),
      ),
    ).rejects.toThrow();
  });

  test("an ownerless turn is shared-only and never writes a binding", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const personal = await personalConnection(org, "not-for-service");
    const turn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      owner: "none",
      initiator: { kind: "service" },
    });
    expect(turn.identity).toMatchObject({
      sessionOwnerSubjectId: null,
      sessionOwnerMembershipId: null,
      initiatingHumanSubjectId: null,
    });
    expect(await place(turn)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    const sharedId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "ownerless",
    });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId: sharedId });
    const binding = await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      (db) => readSubscriptionSessionBinding(db, turn.identity),
    );
    expect(binding).toBeNull();
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, personal),
      ),
    ).toEqual({ kind: "lease_lost" });
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, sharedId),
      ),
    ).toMatchObject({ kind: "loaded", credential: { connectionId: sharedId } });
  });

  test("ownerless authorization cleans only its own lifecycle capability and preserves the caller transaction", async () => {
    const org = await organization();
    const unrelated = await organization();
    const turn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      owner: "none",
      initiator: { kind: "service" },
    });
    for (const preexisting of [false, true]) {
      for (const validTurn of [false, true]) {
        let transaction: { pid: number; xid: string } | undefined;
        try {
          await withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
            withRlsContext(
              client!.db,
              { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
              async (tx) => {
                const [identity] = await rawRows<{
                  pid: number;
                  xid: string;
                  role: string;
                  privileged: boolean;
                }>(
                  tx,
                  sql`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid,
                current_user as role, (rolsuper or rolbypassrls) as privileged
                from pg_roles where rolname = current_user`,
                );
                transaction = identity;
                expect(identity!.role).toBe("opengeni_app");
                expect(identity!.privileged).toBe(false);
                await tx.execute(
                  sql`select set_config('opengeni.pr4_cleanup_probe', 'retained', true)`,
                );
                // Administrative fixture setup only: the restricted connection has
                // no grant to forge/read capabilities. Seed its exact pid/xid so
                // the real SECURITY DEFINER helper observes prior transaction state.
                for (const accountId of [
                  unrelated.accountId,
                  ...(preexisting ? [org.accountId] : []),
                ]) {
                  await shared!.admin`insert into opengeni_private.subscription_runtime_capabilities
                (backend_pid, transaction_id, capability_kind, account_id)
                values (${identity!.pid}, ${identity!.xid}::xid8, 'lifecycle', ${accountId})`;
                }
                const [result] = await rawRows<{ authorized: boolean }>(
                  tx,
                  sql`select opengeni_private.authorize_subscription_ownerless_session_access(
                  ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid,
                  ${turn.identity.sessionId}::uuid,
                  ${validTurn ? turn.identity.turnId : crypto.randomUUID()}::uuid) as authorized`,
                );
                expect(result!.authorized).toBe(validTurn);
                const [after] = await rawRows<{
                  xid: string;
                  probe: string;
                  account_id: string;
                  workspace_id: string;
                  subject_id: string;
                }>(
                  tx,
                  sql`select pg_current_xact_id()::text as xid,
                  current_setting('opengeni.pr4_cleanup_probe') as probe,
                  current_setting('opengeni.account_id') as account_id,
                  current_setting('opengeni.workspace_id') as workspace_id,
                  current_setting('opengeni.subject_id') as subject_id`,
                );
                expect(after).toEqual({
                  xid: identity!.xid,
                  probe: "retained",
                  account_id: org.accountId,
                  workspace_id: org.sharedWorkspaceId,
                  subject_id: "service:subscription-core",
                });
              },
            ),
          );
          // Observe AFTER commit: another connection cannot see the helper's
          // uncommitted insert/delete, so an in-transaction read is insufficient.
          const retained = await shared!.admin<{ account_id: string }[]>`
          select account_id::text from opengeni_private.subscription_runtime_capabilities
          where backend_pid = ${transaction!.pid} and transaction_id = ${transaction!.xid}::xid8
            and capability_kind = 'lifecycle' order by account_id`;
          expect(retained.map((row) => row.account_id).sort()).toEqual(
            [unrelated.accountId, ...(preexisting ? [org.accountId] : [])].sort(),
          );
        } finally {
          if (transaction)
            await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
            where backend_pid = ${transaction.pid} and transaction_id = ${transaction.xid}::xid8`;
        }
      }
    }
  });

  test("a person's turn in an ownerless session places shared-only, like a scheduled run", async () => {
    // A scheduled task that opens a new session per run creates the session
    // without an owner, while its turn still records the person it runs for.
    // That turn must place on shared capacity, never on personal capacity.
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const personal = await personalConnection(org, "not-for-ownerless");
    const turn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      owner: "none",
      initiator: { kind: "subject", subjectId: org.ownerSubjectId },
    });
    expect(turn.identity).toMatchObject({
      sessionOwnerSubjectId: null,
      sessionOwnerMembershipId: null,
      initiatingHumanSubjectId: org.ownerSubjectId,
    });
    expect(await place(turn)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    const sharedId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "ownerless-person",
    });
    expect(await place(turn)).toMatchObject({
      kind: "run",
      connectionId: sharedId,
      personal: false,
    });
    const binding = await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      (db) => readSubscriptionSessionBinding(db, turn.identity),
    );
    expect(binding).toBeNull();
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, personal),
      ),
    ).toEqual({ kind: "lease_lost" });
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, sharedId),
      ),
    ).toMatchObject({ kind: "loaded", credential: { connectionId: sharedId } });
    // The turn can also admit its model requests on the shared lease.
    expect(
      await reserveSubscriptionCoreCodexRequest(
        client!.db,
        turn.identity,
        leaseOf(turn, sharedId),
        {
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
          attemptId: turn.attemptId,
          executionGeneration: turn.executionGeneration,
        },
      ),
    ).toMatchObject({ operationId: expect.any(String) });
  });

  test("concurrent refreshes of one generation persist one rotation and call the provider once", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "stale",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const resolver = buildSubscriptionCoreCodexTokenResolver(
      client!.db,
      settings,
      turn.identity,
      leaseOf(turn, connectionId),
      {
        refresh: async (refreshToken) => {
          seen.push(refreshToken);
          await gate;
          return { accessToken: "access-rotated", refreshToken: "refresh-rotated" };
        },
      },
    );
    const first = resolver.getToken();
    const second = resolver.getToken();
    // Let both callers load the stale credential before the provider returns.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(seen).toEqual(["refresh-stale"]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ accessToken: "access-rotated", credentialVersion: 2 });
    const [row] = await shared!.admin<
      { credential_encrypted: string; refresh_generation: string; last_refresh_at: Date | null }[]
    >`select credential_encrypted, refresh_generation::text as refresh_generation, last_refresh_at
      from subscription_connections where id = ${connectionId}::uuid`;
    expect(row!.refresh_generation).toBe("2");
    expect(row!.last_refresh_at).not.toBeNull();
    expect(JSON.parse(decryptEnvironmentValue(key, row!.credential_encrypted))).toEqual({
      access_token: "access-rotated",
      refresh_token: "refresh-rotated",
      id_token: "id-stale",
    });
    // A refresh started from the superseded generation does not call the provider.
    let calls = 0;
    expect(
      await refreshSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, connectionId),
        1,
        {
          refresh: async () => {
            calls += 1;
            return {};
          },
        },
      ),
    ).toEqual({ kind: "superseded" });
    expect(calls).toBe(0);
  });

  test("a permanent OAuth refusal marks only the current generation as needing sign-in", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "revoked",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    const resolver = buildSubscriptionCoreCodexTokenResolver(
      client!.db,
      settings,
      turn.identity,
      leaseOf(turn, connectionId),
      {
        refresh: async () => {
          throw new CodexReloginRequired("Codex sign-in was revoked");
        },
      },
    );
    await expect(resolver.getToken()).rejects.toBeInstanceOf(CodexReloginRequired);
    const [row] = await shared!.admin<
      { status: string; last_error: string | null; refresh_generation: string }[]
    >`
      select status, last_error, refresh_generation::text as refresh_generation
      from subscription_connections where id = ${connectionId}::uuid`;
    expect(row).toEqual({
      status: "needs_relogin",
      last_error: "Codex sign-in was revoked",
      refresh_generation: "1",
    });
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, connectionId),
      ),
    ).toEqual({ kind: "needs_relogin" });

    // The relogin writer cannot be called without begin's one-shot authorization.
    const [direct] = await withSessionRlsActorContext(
      subscriptionCoreTurnActor(turn.identity),
      () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          (db) =>
            rawRows<{ marked: boolean }>(
              db,
              sql`select opengeni_private.fail_subscription_codex_refresh(
                ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid,
                ${turn.identity.sessionId}::uuid, ${turn.identity.turnId}::uuid,
                ${connectionId}::uuid, 1, 'forged') as marked`,
            ),
        ),
    );
    expect(direct!.marked).toBe(false);
  });

  // Two adapter shapes of a credential that never renews: no refresher at all
  // (an API key), and a refresher the credential's format does not use (a
  // setup token next to renewable OAuth credentials of the same provider).
  test.each(["no refresher", "format does not renew"] as const)(
    "a credential that never renews is not rotated: its refresh marks the connection needs-relogin (%s)",
    async (shape) => {
      const org = await organization();
      await enableCodexCutover(org.accountId);
      const connectionId = await sharedConnection(org, {
        workspaceId: org.sharedWorkspaceId,
        label: "non-renewing",
        expiresAt: new Date(Date.now() - 60_000),
      });
      const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
      expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
      // A binding of the registered provider whose adapter declares no refresh,
      // the shape of a setup token or an API key.
      const codex = subscriptionCoreCodexProvider();
      let rotations = 0;
      const nonRenewing =
        shape === "no refresher"
          ? { ...codex, adapter: { ...codex.adapter, refresh: null } }
          : {
              ...codex,
              adapter: {
                ...codex.adapter,
                capabilitiesFor: (format: string) => ({
                  ...codex.adapter.capabilitiesFor(format),
                  autoRenews: false,
                }),
                refresh: {
                  ...codex.adapter.refresh!,
                  rotate: async () => {
                    rotations += 1;
                    throw new Error("a non-renewing format must not be rotated");
                  },
                },
              },
            };
      const turns = subscriptionCoreTurns(nonRenewing);
      // A superseded generation is reported before anything is written.
      expect(
        await turns.refreshSubscriptionCoreCredential(
          client!.db,
          settings,
          turn.identity,
          leaseOf(turn, connectionId),
          2,
        ),
      ).toEqual({ kind: "superseded" });
      const message = codex.adapter.reloginText("");
      expect(
        await turns.refreshSubscriptionCoreCredential(
          client!.db,
          settings,
          turn.identity,
          leaseOf(turn, connectionId),
          1,
        ),
      ).toEqual({ kind: "relogin", message, marked: true });
      const [row] = await shared!.admin<
        { status: string; last_error: string | null; refresh_generation: string }[]
      >`
      select status, last_error, refresh_generation::text as refresh_generation
      from subscription_connections where id = ${connectionId}::uuid`;
      expect(row).toEqual({
        status: "needs_relogin",
        last_error: message,
        refresh_generation: "1",
      });
      expect(rotations).toBe(0);
      expect(
        await loadSubscriptionCoreCodexCredential(
          client!.db,
          settings,
          turn.identity,
          leaseOf(turn, connectionId),
        ),
      ).toEqual({ kind: "needs_relogin" });
    },
  );

  test("quota observations and failure receipts are fenced to the leased connection", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "quota",
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    const resetAt = Date.now() + 7_200_000;
    const refusal = {
      windows: [],
      modelCooldowns: {},
      exhaustedUntil: resetAt,
      exhaustedKind: "quota" as const,
      revision: 0,
      observedAt: Date.now(),
      observedRefreshGeneration: 1,
      source: "refusal" as const,
    };
    expect(
      await recordSubscriptionCoreCodexQuotaObservation(
        client!.db,
        turn.identity,
        leaseOf(turn, connectionId),
        refusal,
      ),
    ).toBe(true);
    // An observation made with an older token family cannot quarantine anew.
    expect(
      await recordSubscriptionCoreCodexQuotaObservation(
        client!.db,
        turn.identity,
        leaseOf(turn, connectionId),
        { ...refusal, observedRefreshGeneration: 0, exhaustedUntil: resetAt + 10_000_000 },
      ),
    ).toBe(false);
    expect(
      await recordSubscriptionCoreCodexTurnFailure(
        client!.db,
        turn.identity,
        leaseOf(turn, connectionId),
        { kind: "quota", evidence: { refreshGeneration: 1 } },
      ),
    ).toBe(true);
    const [quota] = await shared!.admin<{ quota: { exhaustedUntil: number }; revision: string }[]>`
      select quota, revision::text as revision from subscription_connection_quota
      where connection_id = ${connectionId}::uuid`;
    expect(quota!.quota.exhaustedUntil).toBe(resetAt);
    const [failure] = await shared!.admin<{ failure_kind: string }[]>`
      select failure_kind from subscription_turn_failures
      where turn_id = ${turn.identity.turnId}::uuid and connection_id = ${connectionId}::uuid`;
    expect(failure!.failure_kind).toBe("quota");

    // The next placement sees the exhausted connection and waits until its reset.
    await withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
      withRlsContext(
        client!.db,
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        (db) =>
          releaseSubscriptionTurnLease(db, {
            ...turn.identity,
            provider: "codex",
            ...leaseOf(turn, connectionId),
          }),
      ),
    );
    expect(await place(turn)).toEqual({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: new Date(resetAt),
      healthRetryAt: null,
      explicitConnectionId: null,
    });
    // Without the lease, no observation or failure receipt is accepted.
    expect(
      await recordSubscriptionCoreCodexQuotaObservation(
        client!.db,
        turn.identity,
        leaseOf(turn, connectionId),
        { ...refusal, observedAt: Date.now() + 1_000 },
      ),
    ).toBe(false);
    expect(
      await recordSubscriptionCoreCodexTurnFailure(
        client!.db,
        turn.identity,
        leaseOf(turn, connectionId),
        { kind: "auth" },
      ),
    ).toBe(false);
  });

  test("a core credential that cannot be decoded fails with fixed text and no cause", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "garbled",
    });
    // Plaintext that is not the token JSON: the error must not echo it.
    await shared!.admin`
      update subscription_connections
      set credential_encrypted = ${encryptEnvironmentValue(key, "secret-token-not-json")}
      where id = ${connectionId}::uuid`;
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    const caught = await loadSubscriptionCoreCodexCredential(
      client!.db,
      settings,
      turn.identity,
      leaseOf(turn, connectionId),
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("A core Codex credential could not be decrypted");
    expect((caught as Error).cause).toBeUndefined();
    expect(Bun.inspect(caught)).not.toContain("secret-token");
  });

  test("failure receipts also require the enabled gate", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "receipt-gate",
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId });
    await enableCodexCutover(org.accountId, false);
    expect(
      await recordSubscriptionCoreCodexTurnFailure(
        client!.db,
        turn.identity,
        leaseOf(turn, connectionId),
        { kind: "forbidden" },
      ),
    ).toBe(false);
    const failures = await shared!.admin`
      select 1 from subscription_turn_failures where turn_id = ${turn.identity.turnId}::uuid`;
    expect(failures.length).toBe(0);
  });

  test("this attempt's own expired lease is never reused; placement acquires it afresh", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "own-expired",
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    expect(await place(turn)).toMatchObject({ kind: "run", reusedLease: false });
    expect(await place(turn)).toMatchObject({ kind: "run", reusedLease: true });
    await shared!.admin`
      update subscription_leases set leased_until = clock_timestamp() - interval '1 second'
      where turn_id = ${turn.identity.turnId}::uuid`;
    expect(
      await loadSubscriptionCoreCodexCredential(
        client!.db,
        settings,
        turn.identity,
        leaseOf(turn, connectionId),
      ),
    ).toEqual({ kind: "lease_lost" });
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId, reusedLease: false });
    const [live] = await shared!.admin<{ live: boolean }[]>`
      select leased_until > clock_timestamp() as live from subscription_leases
      where turn_id = ${turn.identity.turnId}::uuid`;
    expect(live!.live).toBe(true);
  });

  test("personal access reads only the v2 entry, behind an enabled Codex cutover row (v1 snapshots grant nothing)", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "v1-only");
    const turn = await runningTurn(org, { workspaceId: org.personalWorkspaceId });
    await shared!.admin.begin(async (owner) => {
      // The v1 snapshot is immutable to every writer; seed this fixture once.
      await owner`set local session_replication_role = replica`;
      await owner`
        update session_turns set codex_provider_account_authority_snapshot = ${owner.json({
          version: 1,
          scope: "user",
          authorityGeneration: 1,
        })}::jsonb
        where id = ${turn.identity.turnId}::uuid`;
    });
    const authorize = () =>
      withSessionRlsActorContext(subscriptionCoreTurnActor(turn.identity), () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
          async (db) => {
            const [row] = await rawRows<{ authorized: boolean }>(
              db,
              sql`select opengeni_private.authorize_subscription_personal_access(
                  ${org.accountId}::uuid, ${org.personalWorkspaceId}::uuid,
                  ${turn.identity.sessionId}::uuid, ${turn.identity.turnId}::uuid,
                  ${personal}::uuid, 'codex', ${org.ownerSubjectId}, ${org.ownerSubjectId}
                ) as authorized`,
            );
            return row!.authorized;
          },
        ),
      );
    // Migration 0712 replaced 0668's legacy-generation branch: without a
    // cutover row (unreachable for Codex after 0689) the v1 snapshot no
    // longer authorizes anything.
    expect(await authorize()).toBe(false);
    await enableCodexCutover(org.accountId, false);
    expect(await authorize()).toBe(false);
    // Enabled: only the v2 entry counts, and this turn has none.
    await enableCodexCutover(org.accountId, true);
    expect(await authorize()).toBe(false);
    await shared!.admin`
      update session_turns set subscription_authority = ${shared!.admin.json({
        version: 2,
        personal: [
          { provider: "codex", ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
        ],
      })}::jsonb
      where account_id = ${org.accountId}::uuid and id = ${turn.identity.turnId}::uuid`;
    expect(await authorize()).toBe(true);
    // A disabled row grants nothing, even with the v2 entry.
    await enableCodexCutover(org.accountId, false);
    expect(await authorize()).toBe(false);
    await enableCodexCutover(org.accountId, true);
    expect(await authorize()).toBe(true);
    // The same grant for a provider without a cutover receipt (SuperGrok,
    // Claude) is refused: an enabled switch row, a v2 entry, the exact owner
    // and the current generation are not enough before that provider's
    // receipt, so its personal access stays decided by its v1 path alone.
    for (const provider of ["claude", "xai"]) {
      await shared!.admin.begin(async (owner) => {
        // Fixture only: move this connection and its v2 entry to the provider
        // and give it an enabled switch row, bypassing the guards that keep
        // such rows from appearing.
        await owner`set local session_replication_role = replica`;
        await owner`update subscription_connections set provider = ${provider}
          where id = ${personal}::uuid`;
        await owner`insert into subscription_provider_cutovers (account_id, provider, enabled)
          values (${org.accountId}::uuid, ${provider}, true)
          on conflict (account_id, provider) do update set enabled = true`;
        await owner`update session_turns set subscription_authority = ${owner.json({
          version: 2,
          personal: [
            { provider, ownerMembershipId: org.ownerMembershipId, authorityGeneration: 1 },
          ],
        })}::jsonb
          where account_id = ${org.accountId}::uuid and id = ${turn.identity.turnId}::uuid`;
      });
      const [granted] = await withSessionRlsActorContext(
        subscriptionCoreTurnActor(turn.identity),
        () =>
          withRlsContext(
            client!.db,
            { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
            (db) =>
              rawRows<{ authorized: boolean }>(
                db,
                sql`select opengeni_private.authorize_subscription_personal_access(
                  ${org.accountId}::uuid, ${org.personalWorkspaceId}::uuid,
                  ${turn.identity.sessionId}::uuid, ${turn.identity.turnId}::uuid,
                  ${personal}::uuid, ${provider}, ${org.ownerSubjectId}, ${org.ownerSubjectId}
                ) as authorized`,
              ),
          ),
      );
      expect(granted!.authorized).toBe(false);
    }
  });

  test("turn recovery stores the shared-core lease-busy chain on the turn", async () => {
    const org = await organization();
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const recovery = await requestSessionTurnRecovery(client!.db, org.sharedWorkspaceId, {
      sessionId: turn.identity.sessionId,
      turnId: turn.identity.turnId,
      triggerEventId: (
        await shared!.admin<{ trigger_event_id: string }[]>`
          select trigger_event_id::text as trigger_event_id from session_turns
          where id = ${turn.identity.turnId}::uuid`
      )[0]!.trigger_event_id,
      attemptId: turn.attemptId,
      reason: "subscription_lease_busy",
      subscriptionLeaseBusy: { startedAt, executionGeneration: turn.executionGeneration },
    });
    expect(recovery.action).toBe("recovering");
    const [row] = await shared!.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from session_turns where id = ${turn.identity.turnId}::uuid`;
    expect(row!.metadata.subscriptionLeaseBusy).toEqual({
      startedAt,
      executionGeneration: turn.executionGeneration,
    });
  });

  test("a completed model call advances the binding cache clock", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const first = await sharedConnection(org, { workspaceId: org.sharedWorkspaceId, label: "a" });
    await sharedConnection(org, { workspaceId: org.sharedWorkspaceId, label: "b" });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    const placed = await place(turn);
    if (placed.kind !== "run") throw new Error("expected a run placement");
    const touchedAt = new Date();
    expect(
      await touchSubscriptionCoreCodexBinding(
        client!.db,
        turn.identity,
        leaseOf(turn, placed.connectionId),
        touchedAt,
      ),
    ).toBe(true);
    const binding = await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      (db) => readSubscriptionSessionBinding(db, turn.identity),
    );
    expect(binding?.lastModelCallAt?.getTime()).toBe(touchedAt.getTime());
    void first;
  });

  test("an older attempt's live lease makes the redispatched attempt wait for its expiry", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const connectionId = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "busy",
    });
    const turn = await runningTurn(org, { workspaceId: org.sharedWorkspaceId });
    // The previous attempt of this turn still holds its live lease.
    const previous = await withSessionRlsActorContext(
      subscriptionCoreTurnActor(turn.identity),
      () =>
        withRlsContext(
          client!.db,
          { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
          (db) =>
            acquireSubscriptionTurnLease(db, {
              ...turn.identity,
              provider: "codex",
              connectionId,
              holderId: "codex-turn:previous",
              generation: turn.executionGeneration,
              ttlMs: 60_000,
            }),
        ),
    );
    expect(previous).not.toBeNull();
    // Same generation, other holder: not this attempt's lease.
    expect(await place(turn)).toEqual({ kind: "attempt_fenced" });
    // The redispatched attempt has the next execution generation.
    await shared!.admin`
      update session_turns set execution_generation = execution_generation + 1
      where id = ${turn.identity.turnId}::uuid`;
    const redispatched = { ...turn, executionGeneration: turn.executionGeneration + 1 };
    expect(await place(redispatched)).toMatchObject({ kind: "lease_busy" });
    await shared!.admin`
      update subscription_leases set leased_until = clock_timestamp() - interval '1 second'
      where turn_id = ${turn.identity.turnId}::uuid`;
    expect(await place(redispatched)).toMatchObject({ kind: "run", connectionId });
    expect(await leaseRows(org, turn)).toEqual([
      {
        connection_id: connectionId,
        holder_id: turn.holderId,
        generation: String(turn.executionGeneration + 1),
      },
    ]);
  });
});

describe("core Codex resolver single-flight", () => {
  const baseIdentity: SubscriptionCoreTurnIdentity = {
    accountId: "00000000-0000-4000-8000-0000000000a1",
    workspaceId: "00000000-0000-4000-8000-0000000000b1",
    sessionId: "00000000-0000-4000-8000-0000000000c1",
    turnId: "00000000-0000-4000-8000-0000000000d1",
    sessionOwnerSubjectId: "user:owner",
    sessionOwnerMembershipId: null,
    initiatingHumanSubjectId: "user:owner",
    acceptedAuthorityV2: { version: 2, personal: [] },
  };
  function staleCredential(connectionId: string) {
    return {
      kind: "loaded" as const,
      credential: {
        connectionId,
        ownership: "shared" as const,
        refreshGeneration: 4,
        tokens: { accessToken: "access-old", refreshToken: "refresh-old", idToken: "id-old" },
        chatgptAccountId: "chatgpt-1",
        isFedramp: false,
        planType: "pro",
        expiresAt: new Date(Date.now() - 60_000),
        lastRefreshAt: null,
      },
    };
  }

  test("concurrent callers of one turn share one provider refresh", async () => {
    const connectionId = crypto.randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const resolver = buildSubscriptionCoreCodexTokenResolver(
      {} as DbClient["db"],
      settings,
      baseIdentity,
      { connectionId, holderId: "holder-a", generation: 1 },
      {
        load: async () => staleCredential(connectionId),
        refreshCredential: async () => {
          calls += 1;
          await gate;
          return {
            kind: "refreshed",
            accessToken: "access-new",
            refreshGeneration: 5,
            planType: null,
          };
        },
      },
    );
    const first = resolver.getToken();
    const second = resolver.getToken();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect(await first).toMatchObject({ accessToken: "access-new", credentialVersion: 5 });
    expect(await second).toMatchObject({ accessToken: "access-new", credentialVersion: 5 });
    expect(calls).toBe(1);
  });

  test("another turn's lost lease is not shared: the joiner refreshes under its own lease", async () => {
    const connectionId = crypto.randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const turnB = { ...baseIdentity, turnId: "00000000-0000-4000-8000-0000000000d2" };
    let ownRefreshesByB = 0;
    const resolverA = buildSubscriptionCoreCodexTokenResolver(
      {} as DbClient["db"],
      settings,
      baseIdentity,
      { connectionId, holderId: "holder-a", generation: 1 },
      {
        load: async () => staleCredential(connectionId),
        refreshCredential: async () => {
          await gate;
          return { kind: "lease_lost" };
        },
      },
    );
    const resolverB = buildSubscriptionCoreCodexTokenResolver(
      {} as DbClient["db"],
      settings,
      turnB,
      { connectionId, holderId: "holder-b", generation: 1 },
      {
        load: async () => staleCredential(connectionId),
        refreshCredential: async () => {
          ownRefreshesByB += 1;
          return {
            kind: "refreshed",
            accessToken: "access-b",
            refreshGeneration: 5,
            planType: null,
          };
        },
      },
    );
    const a = resolverA.getToken();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = resolverB.getToken();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const [outcomeA, outcomeB] = await Promise.all([
      a.catch((error: unknown) => error),
      b.catch((error: unknown) => error),
    ]);
    expect(outcomeA).toBeInstanceOf(SubscriptionCoreCodexLeaseLostError);
    expect(outcomeB).toMatchObject({ accessToken: "access-b", credentialVersion: 5 });
    expect(ownRefreshesByB).toBe(1);
  });

  test("a connection-level outcome is shared with another turn", async () => {
    const connectionId = crypto.randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let refreshesByB = 0;
    const resolverA = buildSubscriptionCoreCodexTokenResolver(
      {} as DbClient["db"],
      settings,
      baseIdentity,
      { connectionId, holderId: "holder-a", generation: 1 },
      {
        load: async () => staleCredential(connectionId),
        refreshCredential: async () => {
          await gate;
          return { kind: "relogin", message: "revoked", marked: true };
        },
      },
    );
    const resolverB = buildSubscriptionCoreCodexTokenResolver(
      {} as DbClient["db"],
      settings,
      { ...baseIdentity, turnId: "00000000-0000-4000-8000-0000000000d3" },
      { connectionId, holderId: "holder-b", generation: 1 },
      {
        load: async () => staleCredential(connectionId),
        refreshCredential: async () => {
          refreshesByB += 1;
          return { kind: "refreshed", accessToken: "unused", refreshGeneration: 5, planType: null };
        },
      },
    );
    const a = resolverA.getToken();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = resolverB.getToken();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const [outcomeA, outcomeB] = await Promise.all([
      a.catch((error: unknown) => error),
      b.catch((error: unknown) => error),
    ]);
    expect(outcomeA).toBeInstanceOf(CodexReloginRequired);
    expect(outcomeB).toBeInstanceOf(CodexReloginRequired);
    expect(refreshesByB).toBe(0);
  });

  test("losing access mid-turn is a typed access loss, not a revoked sign-in", async () => {
    const connectionId = crypto.randomUUID();
    for (const kind of ["not_visible", "unavailable"] as const) {
      const resolver = buildSubscriptionCoreCodexTokenResolver(
        {} as DbClient["db"],
        settings,
        baseIdentity,
        { connectionId, holderId: "holder-a", generation: 1 },
        { load: async () => ({ kind }) },
      );
      await expect(resolver.getToken()).rejects.toBeInstanceOf(
        SubscriptionCoreCodexAccessLostError,
      );
    }
    const refused = buildSubscriptionCoreCodexTokenResolver(
      {} as DbClient["db"],
      settings,
      baseIdentity,
      { connectionId, holderId: "holder-a", generation: 1 },
      {
        load: async () => staleCredential(connectionId),
        refreshCredential: async () => ({ kind: "refused" }),
      },
    );
    await expect(refused.getToken()).rejects.toBeInstanceOf(SubscriptionCoreCodexAccessLostError);
    const revoked = buildSubscriptionCoreCodexTokenResolver(
      {} as DbClient["db"],
      settings,
      baseIdentity,
      { connectionId, holderId: "holder-a", generation: 1 },
      { load: async () => ({ kind: "needs_relogin" }) },
    );
    await expect(revoked.getToken()).rejects.toBeInstanceOf(CodexReloginRequired);
  });
});

describe.skipIf(!realDb)("durable model catalog observations", () => {
  test("placement, wait reconciliation and credit admission share exact accepted model facts", async () => {
    const org = await organization();
    await enableCodexCutover(org.accountId);
    const a = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "catalog-a",
    });
    const b = await sharedConnection(org, {
      workspaceId: org.sharedWorkspaceId,
      label: "catalog-b",
    });
    // This upstream slug deliberately differs from the product id and need not
    // occur in today's picker: retained accepted turns must keep working.
    const upstream = "retained-upstream-model";
    const turn = await runningTurn(org, {
      workspaceId: org.sharedWorkspaceId,
      upstreamModelId: upstream,
    });
    const scope = {
      kind: "workspace" as const,
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      subjectId: org.ownerSubjectId,
    };
    const observe = (
      connectionId: string,
      slugs: string[],
      generation = 1,
      observedAt = Date.now(),
    ) =>
      recordSubscriptionCoreCodexModelCatalog(client!.db, scope, connectionId, {
        slugs,
        refreshGeneration: generation,
        observedAt,
      });
    const evaluate = (now = new Date()) =>
      evaluateSubscriptionCoreCodexPlacement(client!.db, {
        identity: turn.identity,
        productModelId: MODEL,
        reasoningLevel: "medium",
        now,
      });
    expect(await observe(a, [])).toBe(true);
    expect(await observe(b, ["other-model", upstream])).toBe(true);
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId: b });
    expect(await evaluate()).toMatchObject({ kind: "run", connectionId: b });
    expect(await observe(b, [])).toBe(true);
    expect(await place(turn)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    // The same evaluator used immediately after arming a waiter must not wake
    // the turn on the model-ineligible account it just rejected.
    const parked = await evaluate();
    expect(parked).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    if (parked.kind !== "wait") throw Error("expected wait");
    expect(parked.healthRetryAt).toBeInstanceOf(Date);
    expect(await evaluate(new Date(Date.now() + 61_000))).toMatchObject({ kind: "run" });

    expect(await observe(a, [upstream])).toBe(true);
    // An older response cannot replace the newer catalog.
    expect(await observe(a, [], 1, Date.now() - 5_000)).toBe(false);
    await shared!
      .admin`update subscription_connections set extra_credits_enabled=true where id=${a}::uuid`;
    await shared!.admin`update subscription_connection_quota set quota=${shared!.admin.json({
      windows: [
        { id: "primary", usedPercent: 100, status: "exhausted", resetsAt: Date.now() + 3600_000 },
      ],
      modelCooldowns: {},
      exhaustedUntil: null,
      exhaustedKind: null,
    })}::jsonb, observed_refresh_generation=1 where connection_id=${a}::uuid`;
    expect(await place(turn)).toMatchObject({ kind: "run", connectionId: a });
    expect(
      await canSpendSubscriptionCoreCodexExtraCredits(client!.db, {
        ...turn,
        connectionId: a,
        productModelId: MODEL,
        reasoningLevel: "medium",
        leaseTtlMs: TTL,
      }),
    ).toBe(true);
    // Refresh invalidates observations immediately, without waiting for TTL.
    await shared!
      .admin`update subscription_connections set refresh_generation=2 where id=${b}::uuid`;
    expect(await observe(b, [], 1)).toBe(false);
    expect(await evaluate()).toMatchObject({ kind: "run", connectionId: b });
    const stranger = await organization();
    expect(
      await recordSubscriptionCoreCodexModelCatalog(
        client!.db,
        {
          kind: "workspace",
          accountId: stranger.accountId,
          workspaceId: stranger.sharedWorkspaceId,
          subjectId: stranger.ownerSubjectId,
        },
        a,
        { slugs: [], refreshGeneration: 1, observedAt: Date.now() },
      ),
    ).toBe(false);
  });
});
