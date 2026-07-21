import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  chooseRotationActive,
  selectCodexCredentialLeaseForTurn,
  type RotationDecision,
} from "../../../apps/worker/src/activities/codex-rotation";
import * as schema from "../src/schema";
import {
  acquireCodexCredentialLease,
  createDb,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  heartbeatCodexCredentialLease,
  heartbeatCodexCredentialLeaseUntil,
  listCodexAccountStatuses,
  loadCodexCredentialForRun,
  mutateSessionControlInTransaction,
  quarantineCodexCredentialForLease,
  recordCodexAccountUsage,
  recordCodexTokenRefresh,
  settleCodexCredentialLeaseLoss,
  settleCodexCredentialFailover,
  releaseCodexCredentialLease,
  setCodexCredentialExhausted,
  setCodexCredentialStatus,
  setCodexCredentialStatusById,
  setActiveCodexCredential,
  updateCodexRotationSettings,
  upsertCodexSubscriptionCredential,
  withCodexCredentialRefreshLock,
  withRlsContext,
  workspaceCodexSubscriptionActive,
  type CodexCredentialLeaseSelectionContext,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let clientA: DbClient;
let clientB: DbClient;
let dbA: Database;
let dbB: Database;

const settings = testSettings({
  codexSubscriptionEnabled: true,
  codexCredentialLeasingEnabled: true,
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});

type Workspace = { accountId: string; workspaceId: string };

async function freshAccount(workspaceCount = 1): Promise<Workspace[]> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('codex lease account') returning id`;
  const result: Workspace[] = [];
  for (let i = 0; i < workspaceCount; i += 1) {
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, ${`codex-ws-${i}`}) returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
    result.push({ accountId: account!.id, workspaceId: workspace!.id });
  }
  return result;
}

async function connectCredential(ws: Workspace, externalId: string): Promise<string> {
  const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
  const result = await upsertCodexSubscriptionCredential(dbA, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({ access_token: "test", refresh_token: "test", id_token: "test" }),
    ),
    chatgptAccountId: externalId,
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60_000),
    lastRefreshAt: new Date(),
  });
  await ensureCodexRotationSettings(dbA, ws.accountId, ws.workspaceId);
  await updateCodexRotationSettings(dbA, ws.workspaceId, { rotationEnabled: true });
  return result.id;
}

async function seedTurn(ws: Workspace, position = 1): Promise<string> {
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await admin`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, status
    ) values (
      ${sessionId}, ${ws.accountId}, ${ws.workspaceId}, 'test',
      'codex/gpt-5.6-sol', 'modal', ${sessionId}, 'running'
    )`;
  await admin.begin(async (transaction) => {
    await transaction`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, active_attempt_id
      ) values (
        ${turnId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${crypto.randomUUID()},
        'wf', 'running', ${position}, 'test', 'codex/gpt-5.6-sol', 'low', 'modal', ${attemptId}
      )`;
    await transaction`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision
      ) values (
        ${attemptId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${turnId}, 0,
        'running', 'wf', ${`run:${attemptId}`}, ${`activity:${attemptId}`}, 0
      )`;
    await transaction`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;
  });
  return turnId;
}

async function activeAttemptIdForTurn(turnId: string): Promise<string> {
  const [turn] = await admin<{ active_attempt_id: string | null }[]>`
    select active_attempt_id from session_turns where id = ${turnId}`;
  if (!turn?.active_attempt_id) throw new Error(`Turn ${turnId} has no active attempt`);
  return turn.active_attempt_id;
}

function selector(context: CodexCredentialLeaseSelectionContext): {
  credentialId: string | null;
  decision: RotationDecision;
} {
  if (context.existingCredentialId) {
    const existing = context.accounts.find(
      (account) => account.id === context.existingCredentialId,
    );
    if (existing?.status === "active") {
      return {
        credentialId: existing.id,
        decision: { kind: "active", credentialId: existing.id, moved: false },
      };
    }
  }
  const decision = chooseRotationActive({
    rotationStrategy: context.rotationStrategy as "most_remaining",
    activeCredentialId: context.activeCredentialId,
    priorCredentialId: context.activeCredentialId,
    accounts: context.accounts,
    now: new Date(),
  });
  return {
    credentialId: decision.kind === "active" ? decision.credentialId : null,
    decision,
  };
}

async function acquire(
  db: Database,
  ws: Workspace,
  turnId: string,
  leaseTtlMs = 300_000,
  holderId = `holder:${turnId}`,
) {
  return await acquireCodexCredentialLease(
    db,
    {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      turnId,
      holderId,
      advanceActivePointer: true,
      leaseTtlMs,
    },
    selector,
  );
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codex-credential-leases");
  if (!shared) {
    available = false;
    console.warn("[codex-credential-leases] postgres unavailable, skipping");
    return;
  }
  admin = shared.admin;
  clientA = createDb(shared.appUrl, { max: 12 });
  clientB = createDb(shared.appUrl, { max: 12 });
  dbA = clientA.db;
  dbB = clientB.db;
}, 180_000);

afterAll(async () => {
  await clientA?.close().catch(() => undefined);
  await clientB?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("OPE-21 atomic Codex credential allocation", () => {
  test("legacy and lease defaults stay off until an explicit settings cutover", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await ensureCodexRotationSettings(dbA, ws!.accountId, ws!.workspaceId);
    const [row] = await admin<{ rotation_enabled: boolean; lease_rotation_enabled: boolean }[]>`
      select rotation_enabled, lease_rotation_enabled
      from codex_rotation_settings where workspace_id = ${ws!.workspaceId}`;
    expect(row).toEqual({ rotation_enabled: false, lease_rotation_enabled: false });
    await ensureCodexRotationSettings(dbA, ws!.accountId, ws!.workspaceId);
    const [preserved] = await admin<
      { rotation_enabled: boolean; lease_rotation_enabled: boolean }[]
    >`
      select rotation_enabled, lease_rotation_enabled
      from codex_rotation_settings where workspace_id = ${ws!.workspaceId}`;
    expect(preserved).toEqual({ rotation_enabled: false, lease_rotation_enabled: false });
    await updateCodexRotationSettings(dbA, ws!.workspaceId, { rotationEnabled: true });
    const [cutOver] = await admin<{ rotation_enabled: boolean; lease_rotation_enabled: boolean }[]>`
      select rotation_enabled, lease_rotation_enabled
      from codex_rotation_settings where workspace_id = ${ws!.workspaceId}`;
    expect(cutOver).toEqual({ rotation_enabled: true, lease_rotation_enabled: true });
  });

  test("40 concurrent turns across two replica pools spread evenly over four credentials", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    for (const id of ["external-a", "external-b", "external-c", "external-d"]) {
      await connectCredential(ws!, id);
    }
    const turns = await Promise.all(Array.from({ length: 40 }, (_, i) => seedTurn(ws!, i + 1)));
    const allocations = await Promise.all(
      turns.map((turnId, i) => acquire(i % 2 === 0 ? dbA : dbB, ws!, turnId)),
    );
    const counts = new Map<string, number>();
    for (const allocation of allocations) {
      expect(allocation.credentialId).not.toBeNull();
      counts.set(allocation.credentialId!, (counts.get(allocation.credentialId!) ?? 0) + 1);
    }
    expect([...counts.values()].sort((a, b) => a - b)).toEqual([10, 10, 10, 10]);
  }, 60_000);

  test("the same external subscription remains concurrently usable in separate workspaces", async () => {
    if (!available) return;
    const [wsA, wsB] = await freshAccount(2);
    const credentialA = await connectCredential(wsA!, "same-provider-id");
    const credentialB = await connectCredential(wsB!, "same-provider-id");
    const [allocationA, allocationB] = await Promise.all([
      acquire(dbA, wsA!, await seedTurn(wsA!, 1)),
      acquire(dbB, wsB!, await seedTurn(wsB!, 1)),
    ]);
    expect(allocationA.credentialId).toBe(credentialA);
    expect(allocationB.credentialId).toBe(credentialB);
    expect(allocationA.accounts[0]?.activeLeaseCount).toBe(0);
    expect(allocationB.accounts[0]?.activeLeaseCount).toBe(0);
  }, 60_000);

  test("usage and cooldown never propagate across workspace boundaries", async () => {
    if (!available) return;
    const [wsA, wsB] = await freshAccount(2);
    const credentialA = await connectCredential(wsA!, "shared-quota");
    await connectCredential(wsB!, "shared-quota");
    const reset = new Date(Date.now() + 5 * 60 * 60_000);
    await recordCodexAccountUsage(dbA, wsA!.workspaceId, credentialA, {
      primaryUsedPercent: 100,
      primaryResetAt: reset,
      secondaryUsedPercent: 10,
      secondaryResetAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      checkedAt: new Date(),
    });
    const statusesAfterUsage = await listCodexAccountStatuses(dbB, wsB!.workspaceId);
    expect(statusesAfterUsage[0]?.primaryUsedPercent).toBeNull();
    await setCodexCredentialExhausted(dbA, wsA!.workspaceId, credentialA, reset);
    const statusesAfterCooldown = await listCodexAccountStatuses(dbB, wsB!.workspaceId);
    expect(statusesAfterCooldown[0]?.exhaustedUntil).toBeNull();
  });

  test("pool-aware admission stays active when only a non-pointer credential is healthy", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    const activeCredential = await connectCredential(ws!, "pointer-broken");
    await connectCredential(ws!, "healthy-alternate");
    expect(await setActiveCodexCredential(dbA, ws!.workspaceId, activeCredential)).toBe(true);
    await setCodexCredentialStatusById(
      dbA,
      ws!.workspaceId,
      activeCredential,
      "needs_relogin",
      "injected auth failure",
    );
    expect(await workspaceCodexSubscriptionActive(dbB, settings, ws!.workspaceId)).toBe(true);
    expect(
      await workspaceCodexSubscriptionActive(
        dbB,
        { ...settings, codexCredentialLeasingEnabled: false },
        ws!.workspaceId,
      ),
    ).toBe(false);

    // The deployment flag alone must not change admission during a rolling
    // update. An existing rotation-enabled row with its lease bit still false
    // uses the exact legacy pointer predicate and therefore remains false here.
    await admin`
      update codex_rotation_settings
      set rotation_enabled = true, lease_rotation_enabled = false
      where workspace_id = ${ws!.workspaceId}`;
    expect(await workspaceCodexSubscriptionActive(dbB, settings, ws!.workspaceId)).toBe(false);
    await updateCodexRotationSettings(dbA, ws!.workspaceId, { rotationEnabled: true });
    expect(await workspaceCodexSubscriptionActive(dbB, settings, ws!.workspaceId)).toBe(true);
  });

  test("temporary disable affects only new leases and re-enable still honors account health", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    const toggledCredential = await connectCredential(ws!, "temporary-toggle");
    const alternateCredential = await connectCredential(ws!, "temporary-alternate");
    expect(await setActiveCodexCredential(dbA, ws!.workspaceId, toggledCredential)).toBe(true);

    // Start a real holder before the future OPE-24 allocator transition. Temporary
    // disable is an eligibility-only state: it must not delete credentials or
    // revoke/terminate a turn that already owns a fenced lease.
    const inFlightTurn = await seedTurn(ws!, 1);
    const inFlight = await acquire(dbA, ws!, inFlightTurn);
    expect(inFlight.credentialId).toBe(toggledCredential);
    const [beforeDisable] = await admin<
      {
        status: string;
        allocator_enabled: boolean;
        version: number;
        has_secret: boolean;
        holder_id: string;
        generation: number;
      }[]
    >`
      select c.status, c.allocator_enabled, c.version,
             c.credential_encrypted is not null as has_secret,
             l.holder_id, l.generation
      from codex_subscription_credentials c
      join codex_credential_leases l
        on l.workspace_id = c.workspace_id and l.credential_id = c.id
      where c.id = ${toggledCredential} and l.turn_id = ${inFlightTurn}`;
    expect(beforeDisable?.has_secret).toBe(true);
    expect(beforeDisable?.status).toBe("active");
    expect(beforeDisable?.allocator_enabled).toBe(true);

    // OPE-24 owns the eventual OCC/audit write/API. OPE-21 owns only this
    // additive field and allocator behavior; health status remains active.
    await admin`
      update codex_subscription_credentials
      set allocator_enabled = false
      where workspace_id = ${ws!.workspaceId} and id = ${toggledCredential}`;
    expect(
      await heartbeatCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        inFlightTurn,
        inFlight.holderId!,
        inFlight.generation!,
      ),
    ).toBe(true);
    const [afterDisable] = await admin<
      {
        status: string;
        allocator_enabled: boolean;
        version: number;
        has_secret: boolean;
        holder_id: string;
        generation: number;
      }[]
    >`
      select c.status, c.allocator_enabled, c.version,
             c.credential_encrypted is not null as has_secret,
             l.holder_id, l.generation
      from codex_subscription_credentials c
      join codex_credential_leases l
        on l.workspace_id = c.workspace_id and l.credential_id = c.id
      where c.id = ${toggledCredential} and l.turn_id = ${inFlightTurn}`;
    expect(afterDisable).toEqual({
      status: "active",
      allocator_enabled: false,
      version: beforeDisable!.version,
      has_secret: true,
      holder_id: beforeDisable!.holder_id,
      generation: beforeDisable!.generation,
    });

    // Refresh is health/token maintenance, not allocator policy. It succeeds
    // while disabled, leaves status active, and cannot re-enable new allocation.
    const loaded = await loadCodexCredentialForRun(
      dbA,
      settings,
      ws!.workspaceId,
      toggledCredential,
    );
    expect(loaded?.status).toBe("active");
    expect(
      await recordCodexTokenRefresh(dbA, {
        id: toggledCredential,
        version: loaded!.version,
        workspaceId: ws!.workspaceId,
        credentialEncrypted: encryptEnvironmentValue(
          Buffer.alloc(32, 7),
          JSON.stringify({ access_token: "next-a", refresh_token: "next-r", id_token: "next-i" }),
        ),
        expiresAt: null,
        lastRefreshAt: new Date(),
      }),
    ).toBe(true);
    const [afterRefresh] = await admin<
      { status: string; allocator_enabled: boolean; version: number }[]
    >`
      select status, allocator_enabled, version
      from codex_subscription_credentials where id = ${toggledCredential}`;
    expect(afterRefresh).toEqual({
      status: "active",
      allocator_enabled: false,
      version: loaded!.version + 1,
    });

    // A redispatch of the same still-live durable turn keeps its exact
    // credential even though the row is no longer available to new turns. The
    // downstream scope is intentionally private/opaque to OPE-21, and its
    // candidate filter excludes the live credential. The filter must never run:
    // exact live holder reuse is structurally resolved first.
    await admin`
      update session_turns
      set metadata = jsonb_build_object(
        'codexCredentialPolicyHash', 'policy-v1',
        'privateAcceptedScope', jsonb_build_object(
          'primaryPoolId', 'pool-a',
          'fallbackPoolIds', jsonb_build_array('pool-b')
        )
      )
      where id = ${inFlightTurn}`;
    type PrivateAcceptedScope = {
      primaryPoolId: string;
      fallbackPoolIds: string[];
      policyHash: string;
    };
    const resolvePrivateAcceptedScope = (
      metadata: Readonly<Record<string, unknown>>,
    ): PrivateAcceptedScope | null => {
      const scope = metadata.privateAcceptedScope as
        | { primaryPoolId?: unknown; fallbackPoolIds?: unknown }
        | undefined;
      const policyHash = metadata.codexCredentialPolicyHash;
      return typeof scope?.primaryPoolId === "string" &&
        Array.isArray(scope.fallbackPoolIds) &&
        scope.fallbackPoolIds.every((id): id is string => typeof id === "string") &&
        typeof policyHash === "string"
        ? {
            primaryPoolId: scope.primaryPoolId,
            fallbackPoolIds: scope.fallbackPoolIds,
            policyHash,
          }
        : null;
    };
    const observedScopes: PrivateAcceptedScope[] = [];
    let membershipFilterCalls = 0;
    const resumedInFlight = await acquireCodexCredentialLease<
      RotationDecision,
      PrivateAcceptedScope
    >(
      dbB,
      {
        accountId: ws!.accountId,
        workspaceId: ws!.workspaceId,
        turnId: inFlightTurn,
        holderId: "temporary-disable-live-resume",
        advanceActivePointer: true,
        resolvePolicyScope: resolvePrivateAcceptedScope,
        filterNewAllocationCandidates: ({ accounts, policyScope }) => {
          membershipFilterCalls += 1;
          if (policyScope) observedScopes.push(policyScope);
          return accounts.filter((account) => account.id === alternateCredential);
        },
      },
      (context) => {
        if (context.policyScope) observedScopes.push(context.policyScope);
        return selector({ ...context, policyScope: null });
      },
    );
    expect(resumedInFlight.credentialId).toBe(toggledCredential);
    expect(resumedInFlight.reused).toBe(true);
    expect(resumedInFlight.generation).toBeGreaterThan(inFlight.generation!);
    expect(observedScopes).toEqual([
      {
        primaryPoolId: "pool-a",
        fallbackPoolIds: ["pool-b"],
        policyHash: "policy-v1",
      },
    ]);
    expect(membershipFilterCalls).toBe(0);
    expect(
      await releaseCodexCredentialLease(
        dbB,
        ws!.accountId,
        ws!.workspaceId,
        inFlightTurn,
        resumedInFlight.holderId!,
        resumedInFlight.generation!,
      ),
    ).toBe(true);

    // A NEW acquisition may select one primary/fallback scope and return
    // downstream-owned per-pool diagnostics. The selector sees only the chosen
    // pool's candidates, so primary and fallback memberships are never union-ranked.
    const scopedTurn = await seedTurn(ws!, 20);
    await admin`
      update session_turns
      set metadata = jsonb_build_object(
        'codexCredentialPolicyHash', 'policy-v3',
        'privateAcceptedScope', jsonb_build_object(
          'primaryPoolId', 'pool-empty',
          'fallbackPoolIds', jsonb_build_array('pool-b')
        )
      )
      where id = ${scopedTurn}`;
    type PrivatePoolDiagnostic = {
      poolId: string;
      reason: "unavailable";
      earliestResetAt: string | null;
      resetKnown: boolean;
    };
    const scoped = await acquireCodexCredentialLease<
      RotationDecision,
      PrivateAcceptedScope,
      PrivatePoolDiagnostic
    >(
      dbA,
      {
        accountId: ws!.accountId,
        workspaceId: ws!.workspaceId,
        turnId: scopedTurn,
        holderId: "private-scope-new-acquisition",
        advanceActivePointer: true,
        resolvePolicyScope: resolvePrivateAcceptedScope,
        filterNewAllocationCandidates: ({ accounts, policyScope }) => ({
          // OPE-32 privately resolves primary then fallbacks; OPE-21 receives
          // only the chosen scope's rows and does not understand pool ids.
          accounts: accounts.filter((account) => account.id === alternateCredential),
          unavailableDiagnostics: [
            {
              poolId: policyScope?.primaryPoolId ?? "unknown",
              reason: "unavailable",
              earliestResetAt: null,
              resetKnown: false,
            },
          ],
        }),
      },
      (context) =>
        selector({
          ...context,
          policyScope: null,
          unavailableDiagnostics: [],
        }),
    );
    expect(scoped.credentialId).toBe(alternateCredential);
    expect(scoped.unavailableDiagnostics).toEqual([
      {
        poolId: "pool-empty",
        reason: "unavailable",
        earliestResetAt: null,
        resetKnown: false,
      },
    ]);
    expect(
      await releaseCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        scopedTurn,
        scoped.holderId!,
        scoped.generation!,
      ),
    ).toBe(true);

    const disabledTurn = await seedTurn(ws!, 2);
    const disabledSelection = await acquire(dbB, ws!, disabledTurn);
    expect(disabledSelection.credentialId).toBe(alternateCredential);
    expect(
      await releaseCodexCredentialLease(
        dbB,
        ws!.accountId,
        ws!.workspaceId,
        disabledTurn,
        disabledSelection.holderId!,
        disabledSelection.generation!,
      ),
    ).toBe(true);

    // Approval/preemption checkpoints release their live lease between worker
    // activities. The exact frozen credential is still a same-turn continuation
    // exception, not a new automatic allocation. An unpersisted caller claim is
    // rejected before the durable checkpoint is present.
    const frozenTurn = await seedTurn(ws!, 3);
    await expect(
      acquireCodexCredentialLease(
        dbA,
        {
          accountId: ws!.accountId,
          workspaceId: ws!.workspaceId,
          turnId: frozenTurn,
          holderId: "unpersisted-continuation-must-fail",
          advanceActivePointer: true,
          continuationCredentialId: toggledCredential,
        },
        () => ({
          credentialId: toggledCredential,
          decision: {
            kind: "active" as const,
            credentialId: toggledCredential,
            moved: false,
          },
        }),
      ),
    ).rejects.toThrow("disabled for new allocations");
    await admin`
      insert into agent_run_states (
        account_id, workspace_id, session_id, turn_id, state_version,
        serialized_run_state, pending_approvals, frozen_codex_credential_id
      )
      select account_id, workspace_id, session_id, id, 1,
             '{}', '[]'::jsonb, ${toggledCredential}
      from session_turns where id = ${frozenTurn}`;
    await admin`
      update session_turns
      set metadata = jsonb_build_object(
        'codexCredentialPolicyHash', 'policy-v2',
        'privateAcceptedScope', jsonb_build_object(
          'primaryPoolId', 'pool-b',
          'fallbackPoolIds', jsonb_build_array()
        )
      )
      where id = ${frozenTurn}`;
    let frozenFilterCalls = 0;
    const frozen = await acquireCodexCredentialLease<RotationDecision, PrivateAcceptedScope>(
      dbA,
      {
        accountId: ws!.accountId,
        workspaceId: ws!.workspaceId,
        turnId: frozenTurn,
        holderId: "temporary-disable-frozen-resume",
        advanceActivePointer: true,
        continuationCredentialId: toggledCredential,
        resolvePolicyScope: resolvePrivateAcceptedScope,
        filterNewAllocationCandidates: ({ accounts }) => {
          frozenFilterCalls += 1;
          return accounts.filter((account) => account.id === alternateCredential);
        },
      },
      (context) =>
        selectCodexCredentialLeaseForTurn({
          context: { ...context, policyScope: null },
          leasingEnabled: true,
          sessionId: "session-test",
          sessionPinSource: null,
          sessionPinnedCredentialId: null,
          sessionLastCredentialId: toggledCredential,
          continuationCredentialId: toggledCredential,
          now: new Date(),
        }),
    );
    expect(frozen.credentialId).toBe(toggledCredential);
    expect(frozenFilterCalls).toBe(0);
    expect(
      await releaseCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        frozenTurn,
        frozen.holderId!,
        frozen.generation!,
      ),
    ).toBe(true);

    const chooseWhile = async (
      position: number,
      mutate: () => Promise<unknown>,
    ): Promise<string | null> => {
      await mutate();
      const turnId = await seedTurn(ws!, position);
      const selected = await acquire(dbB, ws!, turnId);
      if (selected.holderId && selected.generation !== null) {
        expect(
          await releaseCodexCredentialLease(
            dbB,
            ws!.accountId,
            ws!.workspaceId,
            turnId,
            selected.holderId,
            selected.generation,
          ),
        ).toBe(true);
      }
      return selected.credentialId;
    };

    const resetAt = new Date(Date.now() + 60 * 60_000);
    expect(
      await chooseWhile(
        4,
        () => admin`
        update codex_subscription_credentials
        set status = 'active', allocator_enabled = true, exhausted_until = ${resetAt},
            primary_used_percent = 0, primary_reset_at = null
        where id = ${toggledCredential}`,
      ),
    ).toBe(alternateCredential);
    expect(
      await chooseWhile(
        5,
        () => admin`
        update codex_subscription_credentials
        set status = 'needs_relogin', allocator_enabled = true, exhausted_until = null
        where id = ${toggledCredential}`,
      ),
    ).toBe(alternateCredential);
    expect(
      await chooseWhile(
        6,
        () => admin`
        update codex_subscription_credentials
        set status = 'active', allocator_enabled = true, primary_used_percent = 99,
            primary_reset_at = ${resetAt}
        where id = ${toggledCredential}`,
      ),
    ).toBe(alternateCredential);

    // Once re-enabled AND healthy, the row is immediately eligible again. Make
    // the alternate temporarily ineligible only to make the selected id
    // deterministic; this never consumes or activates an entitlement.
    expect(
      await chooseWhile(
        7,
        () => admin`
        update codex_subscription_credentials
        set status = 'active',
            allocator_enabled = (id = ${toggledCredential}),
            exhausted_until = null,
            primary_used_percent = 0,
            primary_reset_at = null
        where workspace_id = ${ws!.workspaceId}`,
      ),
    ).toBe(toggledCredential);
  });

  test("an in-flight refresh cannot reactivate a lease-fenced health quarantine", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    const credentialId = await connectCredential(ws!, "refresh-quarantine-race");
    const turnId = await seedTurn(ws!, 1);
    const lease = await acquire(dbA, ws!, turnId);
    const loaded = await loadCodexCredentialForRun(dbA, settings, ws!.workspaceId, credentialId);
    expect(loaded?.status).toBe("active");
    expect(
      await quarantineCodexCredentialForLease(dbB, {
        accountId: ws!.accountId,
        workspaceId: ws!.workspaceId,
        turnId,
        credentialId,
        holderId: lease.holderId!,
        generation: lease.generation!,
        quarantine: {
          kind: "status",
          status: "error",
          lastError: "injected definitive refusal",
        },
      }),
    ).toBe(true);

    // The provider refresh began from the previously-active snapshot. Its token
    // version still matches because health metadata intentionally does not rotate
    // token families, but the active-health CAS must now reject the stale write.
    expect(
      await recordCodexTokenRefresh(dbA, {
        id: credentialId,
        version: loaded!.version,
        workspaceId: ws!.workspaceId,
        credentialEncrypted: encryptEnvironmentValue(
          Buffer.alloc(32, 7),
          JSON.stringify({
            access_token: "stale-a",
            refresh_token: "stale-r",
            id_token: "stale-i",
          }),
        ),
        expiresAt: null,
        lastRefreshAt: new Date(),
      }),
    ).toBe(false);
    // The resolver turns failed stale-token persistence into a typed relogin
    // failure. Its follow-up health stamp must be fenced too, rather than
    // downgrading the already-committed definitive `error` quarantine.
    expect(
      await setCodexCredentialStatus(
        dbA,
        ws!.workspaceId,
        "needs_relogin",
        "stale refresh must not overwrite quarantine",
        { id: credentialId, version: loaded!.version },
      ),
    ).toBe(false);
    const [after] = await admin<{ status: string; allocator_enabled: boolean; version: number }[]>`
      select status, allocator_enabled, version
      from codex_subscription_credentials where id = ${credentialId}`;
    expect(after).toEqual({
      status: "error",
      allocator_enabled: true,
      version: loaded!.version,
    });
    expect(
      await releaseCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        turnId,
        lease.holderId!,
        lease.generation!,
      ),
    ).toBe(true);
  });

  test("heartbeat extends the live holder; crash expiry is reclaimed; release is idempotent", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await connectCredential(ws!, "long-turn-a");
    await connectCredential(ws!, "long-turn-b");
    const turnA = await seedTurn(ws!, 1);
    // The contract under test is lease extension, not whether a loaded CI host
    // can schedule the heartbeat query inside a sub-second test TTL. Keep the
    // initial holder comfortably live and prove the database-confirmed deadline
    // moves forward before checking cross-replica exclusion.
    const originalTtlMs = 30_000;
    const renewedTtlMs = 120_000;
    const first = await acquire(dbA, ws!, turnA, originalTtlMs);
    expect(first.credentialId).not.toBeNull();
    const renewedUntil = await heartbeatCodexCredentialLeaseUntil(
      dbA,
      ws!.accountId,
      ws!.workspaceId,
      turnA,
      first.holderId!,
      first.generation!,
      renewedTtlMs,
    );
    expect(renewedUntil).toBeInstanceOf(Date);
    expect(renewedUntil!.getTime()).toBeGreaterThan(first.leasedUntil!.getTime());
    expect(
      await heartbeatCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        turnA,
        first.holderId!,
        first.generation!,
        renewedTtlMs,
      ),
    ).toBe(true);

    // A competing replica must observe the renewed reservation and use the
    // other credential. Crash expiry below remains deterministic and sleep-free.
    const [lease] = await admin<{ leased_until: Date }[]>`
      select leased_until from codex_credential_leases where turn_id = ${turnA}`;
    expect(lease!.leased_until.getTime()).toBeGreaterThan(Date.now());
    const liveCompetitorTurn = await seedTurn(ws!, 2);
    const liveCompetitor = await acquire(dbB, ws!, liveCompetitorTurn);
    expect(liveCompetitor.credentialId).not.toBeNull();
    expect(liveCompetitor.credentialId).not.toBe(first.credentialId);
    expect(
      await releaseCodexCredentialLease(
        dbB,
        ws!.accountId,
        ws!.workspaceId,
        liveCompetitorTurn,
        liveCompetitor.holderId!,
        liveCompetitor.generation!,
      ),
    ).toBe(true);

    // Deterministic worker-crash injection: expire the workspace holder without sleeping.
    await admin`update codex_credential_leases set leased_until = now() - interval '1 second' where turn_id = ${turnA}`;
    const turnB = await seedTurn(ws!, 3);
    const second = await acquire(dbB, ws!, turnB);
    expect(second.credentialId).not.toBeNull();
    const [stale] = await admin<{ count: number }[]>`
      select count(*)::int as count from codex_credential_leases where turn_id = ${turnA}`;
    expect(stale?.count).toBe(0);
    expect(
      await releaseCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        turnB,
        second.holderId!,
        second.generation!,
      ),
    ).toBe(true);
    expect(
      await releaseCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        turnB,
        second.holderId!,
        second.generation!,
      ),
    ).toBe(false);
  });

  test("a successor attempt fences stale heartbeat and release for the same turn", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await connectCredential(ws!, "fenced-a");
    await connectCredential(ws!, "fenced-b");
    const turnId = await seedTurn(ws!, 1);
    const first = await acquire(dbA, ws!, turnId, 300_000, "attempt-a");
    const successor = await acquire(dbB, ws!, turnId, 300_000, "attempt-b");
    expect(successor.generation).toBe(first.generation! + 1);
    expect(
      await heartbeatCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        turnId,
        first.holderId!,
        first.generation!,
      ),
    ).toBe(false);
    expect(
      await releaseCodexCredentialLease(
        dbA,
        ws!.accountId,
        ws!.workspaceId,
        turnId,
        first.holderId!,
        first.generation!,
      ),
    ).toBe(false);
    expect(
      await heartbeatCodexCredentialLease(
        dbB,
        ws!.accountId,
        ws!.workspaceId,
        turnId,
        successor.holderId!,
        successor.generation!,
      ),
    ).toBe(true);

    const staleQuarantine = await quarantineCodexCredentialForLease(dbA, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      turnId,
      credentialId: first.credentialId!,
      holderId: first.holderId!,
      generation: first.generation!,
      quarantine: { kind: "cooldown", until: new Date(Date.now() + 60_000) },
    });
    expect(staleQuarantine).toBe(false);
    const [credentialAfterStaleAttempt] = await admin<
      { status: string; exhausted_until: Date | null }[]
    >`
      select status, exhausted_until from codex_subscription_credentials
      where id = ${first.credentialId}`;
    expect(credentialAfterStaleAttempt).toEqual({ status: "active", exhausted_until: null });

    const [session] = await admin<{ session_id: string }[]>`
      select session_id from session_turns where id = ${turnId}`;
    const attemptId = await activeAttemptIdForTurn(turnId);
    const staleSettlement = await settleCodexCredentialLeaseLoss(dbA, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: session!.session_id,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      checkpointDurable: true,
      recoveryPayload: { reason: "stale-holder-must-not-settle" },
      failedPayload: { error: "stale-holder-must-not-fail" },
    });
    expect(staleSettlement.action).toBe("stale");
    expect(
      await heartbeatCodexCredentialLease(
        dbB,
        ws!.accountId,
        ws!.workspaceId,
        turnId,
        successor.holderId!,
        successor.generation!,
      ),
    ).toBe(true);
  });

  test("a current attempt atomically requeues after its expired lease row is reaped", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await connectCredential(ws!, "lease-loss-a");
    const turnId = await seedTurn(ws!, 1);
    const first = await acquire(dbA, ws!, turnId);
    const attemptId = await activeAttemptIdForTurn(turnId);
    const [session] = await admin<{ session_id: string; trigger_event_id: string }[]>`
      select session_id, trigger_event_id from session_turns where id = ${turnId}`;
    await admin`delete from codex_credential_leases where turn_id = ${turnId}`;

    const settled = await settleCodexCredentialLeaseLoss(dbA, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: session!.session_id,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      checkpointDurable: true,
      recoveryPayload: { reason: "codex_lease_lost" },
      failedPayload: { error: "must-not-fail" },
    });
    expect(settled.action).toBe("recovering");
    if (settled.action !== "recovering") throw new Error("expected lease-loss requeue");
    const [row] = await admin<
      {
        turn_status: string;
        session_status: string;
        active_turn_id: string | null;
        active_attempt_id: string | null;
      }[]
    >`
      select t.status as turn_status, s.status as session_status,
             s.active_turn_id, t.active_attempt_id
      from session_turns t join sessions s on s.id = t.session_id
      where t.id = ${turnId}`;
    expect(row).toEqual({
      turn_status: "recovering",
      session_status: "recovering",
      active_turn_id: turnId,
      active_attempt_id: null,
    });
    expect(settled.events.map((event) => event.type)).toEqual([
      "turn.recovery.requested",
      "session.status.changed",
    ]);

    const duplicate = await settleCodexCredentialLeaseLoss(dbB, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: session!.session_id,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      checkpointDurable: true,
      recoveryPayload: { reason: "duplicate" },
      failedPayload: { error: "duplicate" },
    });
    expect(duplicate.action).toBe("stale");
    const [preemptions] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where turn_id = ${turnId} and type = 'turn.recovery.requested'`;
    expect(preemptions!.count).toBe(1);
  });

  test("lease loss fails closed exactly once when its conversation checkpoint is not durable", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await connectCredential(ws!, "lease-loss-checkpoint-a");
    const turnId = await seedTurn(ws!, 1);
    const first = await acquire(dbA, ws!, turnId);
    const attemptId = await activeAttemptIdForTurn(turnId);
    const [session] = await admin<{ session_id: string; trigger_event_id: string }[]>`
      select session_id, trigger_event_id from session_turns where id = ${turnId}`;
    await admin`delete from codex_credential_leases where turn_id = ${turnId}`;

    const settled = await settleCodexCredentialLeaseLoss(dbA, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: session!.session_id,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      checkpointDurable: false,
      recoveryPayload: { reason: "must-not-recover" },
      failedPayload: {
        error: "checkpoint failed; replay refused",
        code: "codex_lease_checkpoint_failed",
      },
    });
    expect(settled.action).toBe("failed");
    if (settled.action !== "failed") throw new Error("expected fail-closed settlement");
    expect(settled.events.map((event) => event.type)).toEqual([
      "turn.failed",
      "session.status.changed",
    ]);
    const [row] = await admin<
      {
        turn_status: string;
        session_status: string;
        active_turn_id: string | null;
        active_attempt_id: string | null;
      }[]
    >`
      select t.status as turn_status, s.status as session_status,
             s.active_turn_id, t.active_attempt_id
      from session_turns t join sessions s on s.id = t.session_id
      where t.id = ${turnId}`;
    expect(row).toEqual({
      turn_status: "failed",
      session_status: "failed",
      active_turn_id: null,
      active_attempt_id: null,
    });

    const duplicate = await settleCodexCredentialLeaseLoss(dbB, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: session!.session_id,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      checkpointDurable: false,
      recoveryPayload: { reason: "duplicate" },
      failedPayload: { error: "duplicate" },
    });
    expect(duplicate.action).toBe("stale");
    const [failures] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where turn_id = ${turnId} and type = 'turn.failed'`;
    expect(failures!.count).toBe(1);
  });

  test("one atomic failover settlement accepts the exact holder across lease expiry", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await connectCredential(ws!, "expiry-gap-a");
    await connectCredential(ws!, "expiry-gap-b");
    const turnId = await seedTurn(ws!, 1);
    const first = await acquire(dbA, ws!, turnId);
    const attemptId = await activeAttemptIdForTurn(turnId);
    const [turn] = await admin<{ session_id: string; trigger_event_id: string }[]>`
      select session_id, trigger_event_id from session_turns where id = ${turnId}`;

    expect(
      await quarantineCodexCredentialForLease(dbA, {
        accountId: ws!.accountId,
        workspaceId: ws!.workspaceId,
        turnId,
        credentialId: first.credentialId!,
        holderId: first.holderId!,
        generation: first.generation!,
        quarantine: { kind: "cooldown", until: new Date(Date.now() + 60_000) },
      }),
    ).toBe(true);
    // Force the narrow race: the holder was live for quarantine, then crossed
    // expiry before the same-turn failover transaction acquired its locks.
    await admin`
      update codex_credential_leases
      set leased_until = now() - interval '1 second'
      where workspace_id = ${ws!.workspaceId} and turn_id = ${turnId}`;
    const failover = await settleCodexCredentialFailover(dbA, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: turn!.session_id,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      maxFailovers: 2,
      recoveryPayload: { reason: "expiry-gap-failover" },
    });
    expect(failover.action).toBe("recovering");
    expect(failover.events.map((event) => event.type)).toEqual([
      "turn.recovery.requested",
      "session.status.changed",
    ]);
    const [row] = await admin<
      { turn_status: string; session_status: string; active_turn_id: string | null }[]
    >`
      select t.status as turn_status, s.status as session_status, s.active_turn_id
      from session_turns t join sessions s on s.id = t.session_id
      where t.id = ${turnId}`;
    expect(row).toEqual({
      turn_status: "recovering",
      session_status: "recovering",
      active_turn_id: turnId,
    });
    const [preemptions] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where turn_id = ${turnId} and type = 'turn.recovery.requested'`;
    expect(preemptions?.count).toBe(1);
  });

  test("Pause closes both Codex lease settlement gates without mutating the turn", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await connectCredential(ws!, "paused-lease-a");
    await connectCredential(ws!, "paused-lease-b");
    const turnId = await seedTurn(ws!, 1);
    const lease = await acquire(dbA, ws!, turnId);
    const attemptId = await activeAttemptIdForTurn(turnId);
    const [turn] = await admin<{ session_id: string }[]>`
      select session_id from session_turns where id = ${turnId}`;
    await withRlsContext(
      dbA,
      { accountId: ws!.accountId, workspaceId: ws!.workspaceId },
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          await mutateSessionControlInTransaction(tx as unknown as Database, {
            accountId: ws!.accountId,
            workspaceId: ws!.workspaceId,
            sessionId: turn!.session_id,
            actor: { type: "human", subjectId: "lease-pause-test" },
            operationKey: crypto.randomUUID(),
            action: "pause",
            reason: "lease settlement gate test",
          });
        }),
    );

    expect(
      await settleCodexCredentialFailover(dbA, {
        accountId: ws!.accountId,
        workspaceId: ws!.workspaceId,
        sessionId: turn!.session_id,
        turnId,
        attemptId,
        holderId: lease.holderId!,
        generation: lease.generation!,
        expectedRedispatches: 0,
        maxFailovers: 2,
        recoveryPayload: { reason: "must-not-cross-pause" },
      }),
    ).toMatchObject({ action: "stale", events: [] });
    expect(
      await settleCodexCredentialLeaseLoss(dbB, {
        accountId: ws!.accountId,
        workspaceId: ws!.workspaceId,
        sessionId: turn!.session_id,
        turnId,
        attemptId,
        holderId: lease.holderId!,
        generation: lease.generation!,
        expectedRedispatches: 0,
        checkpointDurable: true,
        recoveryPayload: { reason: "must-not-cross-pause" },
        failedPayload: { error: "must-not-cross-pause" },
      }),
    ).toMatchObject({ action: "stale", events: [] });

    const [state] = await admin<
      {
        turn_status: string;
        session_status: string;
        active_turn_id: string | null;
        recoveries: number;
      }[]
    >`
      select t.status as turn_status, s.status as session_status,
             s.active_turn_id,
             (select count(*)::int from session_events e
              where e.turn_id = t.id and e.type = 'turn.recovery.requested') as recoveries
      from session_turns t join sessions s on s.id = t.session_id
      where t.id = ${turnId}`;
    expect(state).toEqual({
      turn_status: "running",
      session_status: "running",
      active_turn_id: turnId,
      recoveries: 0,
    });
  });

  test("lease rows remain RLS-isolated across workspaces and managed accounts", async () => {
    if (!available) return;
    const [wsA] = await freshAccount();
    const [wsB] = await freshAccount();
    const credentialA = await connectCredential(wsA!, "same-provider-id");
    const credentialB = await connectCredential(wsB!, "same-provider-id");
    await acquire(dbA, wsA!, await seedTurn(wsA!, 1));
    await acquire(dbB, wsB!, await seedTurn(wsB!, 1));

    const seenAsA = await withRlsContext(
      dbA,
      { accountId: wsA!.accountId, workspaceId: wsA!.workspaceId },
      async (scoped) => await scoped.select().from(schema.codexCredentialLeases),
    );
    expect(seenAsA.every((row) => row.accountId === wsA!.accountId)).toBe(true);
    expect(seenAsA.map((row) => row.credentialId)).toEqual([credentialA]);
    expect(seenAsA.some((row) => row.credentialId === credentialB)).toBe(false);
  });

  test("workspace allocator and schema guards reject malformed foreign references", async () => {
    if (!available) return;
    const [wsA, wsB] = await freshAccount(2);
    const foreignCredential = await connectCredential(wsA!, "foreign-a");
    await connectCredential(wsB!, "local-b");
    const turnB = await seedTurn(wsB!, 1);
    let allocatorError: unknown;
    try {
      await acquireCodexCredentialLease(
        dbB,
        {
          accountId: wsB!.accountId,
          workspaceId: wsB!.workspaceId,
          turnId: turnB,
          holderId: "foreign-selector-test",
          advanceActivePointer: true,
        },
        () => ({
          credentialId: foreignCredential,
          decision: {
            kind: "active" as const,
            credentialId: foreignCredential,
            moved: true,
          },
        }),
      );
    } catch (error) {
      allocatorError = error;
    }
    expect(String(allocatorError)).toContain("outside the workspace pool");

    const [sessionB] = await admin<{ id: string }[]>`
      select id from sessions where workspace_id = ${wsB!.workspaceId} limit 1`;
    let triggerError: unknown;
    try {
      await admin`
        update sessions set codex_pinned_credential_id = ${foreignCredential}
        where id = ${sessionB!.id}`;
    } catch (error) {
      triggerError = error;
    }
    expect(String(triggerError)).toContain(
      "Codex credential reference must remain in the row workspace",
    );

    let turnFkError: unknown;
    try {
      await admin`
        insert into codex_credential_leases (
          account_id, workspace_id, credential_id, turn_id,
          holder_id, generation, leased_until
        ) values (
          ${wsA!.accountId}, ${wsA!.workspaceId}, ${foreignCredential}, ${turnB},
          'foreign-turn', 1, now() + interval '5 minutes'
        )`;
    } catch (error) {
      turnFkError = error;
    }
    expect(turnFkError).toBeDefined();

    const [otherAccountWorkspace] = await freshAccount();
    const turnA = await seedTurn(wsA!, 2);
    let accountFkError: unknown;
    try {
      await admin`
        insert into codex_credential_leases (
          account_id, workspace_id, credential_id, turn_id,
          holder_id, generation, leased_until
        ) values (
          ${otherAccountWorkspace!.accountId}, ${wsA!.workspaceId},
          ${foreignCredential}, ${turnA}, 'foreign-account', 1,
          now() + interval '5 minutes'
        )`;
    } catch (error) {
      accountFkError = error;
    }
    expect(accountFkError).toBeDefined();
  });

  test("exhaustion reassigns the same durable turn exactly once without duplication", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    await connectCredential(ws!, "failover-a");
    await connectCredential(ws!, "failover-b");
    const turnId = await seedTurn(ws!, 1);
    const first = await acquire(dbA, ws!, turnId);
    const attemptId = await activeAttemptIdForTurn(turnId);
    expect(first.credentialId).not.toBeNull();
    await setCodexCredentialExhausted(
      dbA,
      ws!.workspaceId,
      first.credentialId!,
      new Date(Date.now() + 5 * 60 * 60_000),
    );

    const sessionRows = await admin<{ session_id: string }[]>`
      select session_id from session_turns where id = ${turnId}`;
    const sessionId = sessionRows[0]?.session_id;
    expect(sessionId).toBeDefined();
    const settled = await settleCodexCredentialFailover(dbA, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: sessionId!,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      maxFailovers: 2,
      recoveryPayload: {
        reason: "codex_credential_failover",
        credentialId: first.credentialId!,
      },
    });
    expect(settled.action).toBe("recovering");
    if (settled.action !== "recovering") throw new Error("expected requeue");
    const originalTriggerEventId = (
      await admin<{ trigger_event_id: string }[]>`
        select trigger_event_id from session_turns where id = ${turnId}`
    )[0]!.trigger_event_id;
    const resumed = await acquire(dbB, ws!, turnId);
    expect(resumed.credentialId).not.toBeNull();
    expect(resumed.credentialId).not.toBe(first.credentialId);
    const [row] = await admin<
      { id: string; status: string; trigger_event_id: string; failovers: number }[]
    >`
      select id, status, trigger_event_id,
             (metadata->>'codexCredentialFailovers')::int as failovers
      from session_turns where id = ${turnId}`;
    expect(row).toEqual({
      id: turnId,
      status: "recovering",
      trigger_event_id: originalTriggerEventId,
      failovers: 1,
    });
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_turns where id = ${turnId}`;
    expect(count?.count).toBe(1);

    const duplicate = await settleCodexCredentialFailover(dbB, {
      accountId: ws!.accountId,
      workspaceId: ws!.workspaceId,
      sessionId: sessionId!,
      turnId,
      attemptId,
      holderId: first.holderId!,
      generation: first.generation!,
      expectedRedispatches: 0,
      maxFailovers: 2,
      recoveryPayload: { reason: "duplicate" },
    });
    expect(duplicate.action).toBe("stale");
    const [stillOne] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_turns where id = ${turnId}`;
    expect(stillOne?.count).toBe(1);
    const [preemptions] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where turn_id = ${turnId} and type = 'turn.recovery.requested'`;
    expect(preemptions?.count).toBe(1);
  });

  test("cross-replica refresh lock spends one rotating refresh token", async () => {
    if (!available) return;
    const [ws] = await freshAccount();
    const credentialId = await connectCredential(ws!, "refresh-single-flight");
    const initialA = await loadCodexCredentialForRun(dbA, settings, ws!.workspaceId, credentialId);
    const initialB = await loadCodexCredentialForRun(dbB, settings, ws!.workspaceId, credentialId);
    expect(initialA?.version).toBe(initialB?.version);
    let providerRefreshes = 0;
    const refreshFromReplica = async (db: Database, loadedVersion: number) =>
      await withCodexCredentialRefreshLock(db, ws!.workspaceId, credentialId, async (lockedDb) => {
        const current = await loadCodexCredentialForRun(
          lockedDb,
          settings,
          ws!.workspaceId,
          credentialId,
        );
        if (!current) throw new Error("credential disappeared");
        if (current.version !== loadedVersion) return current.version;
        providerRefreshes += 1;
        const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
        const persisted = await recordCodexTokenRefresh(lockedDb, {
          id: credentialId,
          version: current.version,
          workspaceId: ws!.workspaceId,
          credentialEncrypted: encryptEnvironmentValue(
            key,
            JSON.stringify({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              id_token: "rotated-id",
            }),
          ),
          expiresAt: new Date(Date.now() + 60 * 60_000),
          lastRefreshAt: new Date(),
        });
        expect(persisted).toBe(true);
        return current.version + 1;
      });
    const versions = await Promise.all([
      refreshFromReplica(dbA, initialA!.version),
      refreshFromReplica(dbB, initialB!.version),
    ]);
    expect(providerRefreshes).toBe(1);
    expect(versions).toEqual([initialA!.version + 1, initialA!.version + 1]);
  });
});
