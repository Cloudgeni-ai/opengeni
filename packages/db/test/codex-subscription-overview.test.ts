import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  abandonCodexResetRedemptionBeforeProvider,
  adoptCodexResetRedemptionAttempt,
  claimCodexResetRedemption,
  completeCodexResetRedemption,
  createDb,
  disconnectAllCodexAccounts,
  disconnectCodexAccount,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  fetchCodexUsageForAccount,
  fenceCodexResetRedemptionSend,
  getCodexResetRedemptionAttempt,
  listCodexAccountStatuses,
  listCodexResetRedemptionRecoveries,
  loadCodexCredentialForRun,
  recordCodexAccountUsage,
  recordCodexTokenRefresh,
  releaseCodexResetRedemptionClaim,
  setCodexCredentialExhausted,
  updateCodexAllocatorEligibility,
  upsertCodexSubscriptionCredential,
  type Database,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let clientA: DbClient;
let clientB: DbClient;
let dbA: Database;
let dbB: Database;
let available = true;

const settings = testSettings({
  environmentsEncryptionKey: Buffer.alloc(32, 24).toString("base64"),
  codexSubscriptionEnabled: true,
});

type Workspace = { accountId: string; workspaceId: string };

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_OPE24_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_OPE24_POSTGRES_APP_URL;
  if (!adminUrl || !appUrl) return await acquireSharedTestDatabase("codex-subscription-overview");
  await migrate(adminUrl);
  const nativeAdmin = postgres(adminUrl, { max: 8 });
  await nativeAdmin.unsafe(`
    GRANT USAGE ON SCHEMA public TO opengeni_app;
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
  `);
  return {
    admin: nativeAdmin,
    adminUrl,
    appUrl,
    release: async () => await nativeAdmin.end().catch(() => undefined),
  };
}

async function freshWorkspace(name: string): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`ope24-${name}`}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`ope24-${name}`}) returning id`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function connectCredential(
  ws: Workspace,
  externalId: string,
  connectedBySubjectId: string | null = "user:owner",
): Promise<string> {
  const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
  const row = await upsertCodexSubscriptionCredential(dbA, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        id_token: "id",
      }),
    ),
    chatgptAccountId: externalId,
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    lastRefreshAt: new Date(),
    connectedBySubjectId,
  });
  await ensureCodexRotationSettings(dbA, ws.accountId, ws.workspaceId);
  return row.id;
}

async function seedCapacityWaiter(ws: Workspace): Promise<{
  id: string;
  sessionId: string;
  workflowId: string;
  wakeRevision: number;
}> {
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  await admin.begin(async (tx) => {
    await tx`
      insert into sessions (
        id, account_id, workspace_id, initial_message, model,
        sandbox_backend, sandbox_group_id, status, temporal_workflow_id
      ) values (
        ${sessionId}, ${ws.accountId}, ${ws.workspaceId}, 'OPE-24 capacity wake',
        'codex/gpt-5.6-sol', 'modal', ${sessionId}, 'idle', ${workflowId}
      )`;
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, resources, tools, metadata
      ) values (
        ${turnId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${crypto.randomUUID()},
        ${workflowId}, 'failed', 1, 'OPE-24 capacity wake', 'codex/gpt-5.6-sol',
        'xhigh', 'modal', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb
      )`;
    await tx`
      insert into session_goals (
        id, account_id, workspace_id, session_id, status, text,
        success_criteria, version, max_auto_continuations
      ) values (
        ${goalId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, 'active',
        'wait for real Codex capacity', 'resume only after durable capacity changes', 1, 20
      )`;
  });
  const [waiter] = await admin<{ id: string; wake_revision: number }[]>`
    insert into codex_capacity_waiters (
      account_id, workspace_id, session_id, goal_id, blocked_turn_id,
      workflow_id, goal_version, next_check_at, reset_kind,
      wake_revision, observed_wake_revision
    ) values (
      ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${goalId}, ${turnId},
      ${workflowId}, 1, now() + interval '5 minutes', 'bounded_refresh', 1, 1
    ) returning id, wake_revision`;
  if (!waiter) throw new Error("failed to seed OPE-24 capacity waiter");
  return {
    id: waiter.id,
    sessionId,
    workflowId,
    wakeRevision: waiter.wake_revision,
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_OPE24_POSTGRES === "1") {
      throw new Error("OPE-24 requires real PostgreSQL; no harness was available");
    }
    console.warn("[codex-subscription-overview] postgres unavailable, skipping");
    return;
  }
  admin = shared.admin;
  clientA = createDb(shared.appUrl, { max: 16 });
  clientB = createDb(shared.appUrl, { max: 16 });
  dbA = clientA.db;
  dbB = clientB.db;
}, 180_000);

afterAll(async () => {
  await clientA?.close().catch(() => undefined);
  await clientB?.close().catch(() => undefined);
  await shared?.release();
});

describe("OPE-24 Codex overview and irreversible reset state", () => {
  test("0065 is FORCE-RLS, secret-free on metadata reads, and keeps caches/ownership independent", async () => {
    if (!available) return;
    const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [table] = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity
      from pg_class where oid = 'codex_reset_redemption_attempts'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const columns = await admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'codex_subscription_credentials'
        and column_name in (
          'allocator_version', 'allocator_updated_by_subject_id', 'allocator_updated_at',
          'reset_credit_available_count', 'reset_credits_checked_at', 'connected_by_subject_id'
        ) order by column_name`;
    expect(columns).toHaveLength(6);

    const ws = await freshWorkspace("metadata");
    const credentialId = await connectCredential(ws, "metadata-provider");
    const before = await loadCodexCredentialForRun(dbA, settings, ws.workspaceId, credentialId);
    const metadata = (await listCodexAccountStatuses(dbA, ws.workspaceId))[0]!;
    expect(metadata.connectedBySubjectId).toBe("user:owner");
    expect(metadata.allocatorVersion).toBe(1);
    expect("credentialEncrypted" in metadata).toBe(false);
    expect("tokens" in metadata).toBe(false);

    await recordCodexAccountUsage(dbA, ws.workspaceId, credentialId, {
      primaryUsedPercent: 12,
      primaryResetAt: new Date(Date.now() + 60_000),
      secondaryUsedPercent: 34,
      secondaryResetAt: new Date(Date.now() + 120_000),
      checkedAt: new Date(),
      resetCreditAvailableCount: 3,
      resetCreditsCheckedAt: new Date(),
    });
    const cached = (await listCodexAccountStatuses(dbA, ws.workspaceId))[0]!;
    expect(cached.resetCreditAvailableCount).toBe(3);
    expect(cached.resetCreditsCheckedAt).not.toBeNull();
    expect(
      (await loadCodexCredentialForRun(dbA, settings, ws.workspaceId, credentialId))?.version,
    ).toBe(before?.version);

    // Ownership is the most recent connector, not historical authority. A
    // delegated/nonhuman reconnect makes the row view-only; a later direct
    // managed-cookie human reconnect becomes the new owner.
    await connectCredential(ws, "metadata-provider", null);
    expect((await listCodexAccountStatuses(dbA, ws.workspaceId))[0]?.connectedBySubjectId).toBe(
      null,
    );
    await connectCredential(ws, "metadata-provider", "user:new-owner");
    expect((await listCodexAccountStatuses(dbA, ws.workspaceId))[0]?.connectedBySubjectId).toBe(
      "user:new-owner",
    );
  });

  test("allocator OCC is same-state idempotent, conflict-safe, exactly audited, and token-CAS independent", async () => {
    if (!available) return;
    const ws = await freshWorkspace("allocator");
    const credentialId = await connectCredential(ws, "allocator-provider");
    const tokenBefore = await loadCodexCredentialForRun(
      dbA,
      settings,
      ws.workspaceId,
      credentialId,
    );

    const disabled = (
      await updateCodexAllocatorEligibility(dbA, {
        ...ws,
        credentialId,
        subjectId: "user:owner",
        enabled: false,
        expectedVersion: 1,
      })
    ).result;
    expect(disabled).toMatchObject({
      kind: "updated",
      allocatorEnabled: false,
      allocatorVersion: 2,
    });
    const staleSame = (
      await updateCodexAllocatorEligibility(dbB, {
        ...ws,
        credentialId,
        subjectId: "user:owner",
        enabled: false,
        expectedVersion: 1,
      })
    ).result;
    expect(staleSame).toMatchObject({ kind: "unchanged", allocatorVersion: 2 });
    expect(
      (await loadCodexCredentialForRun(dbA, settings, ws.workspaceId, credentialId))?.version,
    ).toBe(tokenBefore?.version);

    const waiter = await seedCapacityWaiter(ws);
    const enabledMutations = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        updateCodexAllocatorEligibility(index % 2 === 0 ? dbA : dbB, {
          ...ws,
          credentialId,
          subjectId: "user:owner",
          enabled: true,
          expectedVersion: 2,
        }),
      ),
    );
    const enabled = enabledMutations.map((mutation) => mutation.result);
    expect(enabled.filter((result) => result.kind === "updated")).toHaveLength(1);
    expect(
      enabled.every((result) => result.kind === "updated" || result.kind === "unchanged"),
    ).toBe(true);
    const allocatorWakes = enabledMutations.flatMap((mutation) => mutation.wakeTargets);
    expect(allocatorWakes).toHaveLength(1);
    expect(allocatorWakes[0]).toMatchObject({
      waiterId: waiter.id,
      sessionId: waiter.sessionId,
      workflowId: waiter.workflowId,
      wakeRevision: waiter.wakeRevision + 1,
    });
    const [allocatorWakeState] = await admin<
      { wake_revision: number; last_wake_reason: string; outbox_revision: number }[]
    >`
      select w.wake_revision, w.last_wake_reason,
             o.wake_revision::int as outbox_revision
      from codex_capacity_waiters w
      join session_workflow_wake_outbox o on o.session_id = w.session_id
      where w.id = ${waiter.id}`;
    expect(allocatorWakeState).toEqual({
      wake_revision: waiter.wakeRevision + 1,
      last_wake_reason: "codex_allocator_eligibility_changed",
      outbox_revision: 1,
    });
    const conflict = (
      await updateCodexAllocatorEligibility(dbA, {
        ...ws,
        credentialId,
        subjectId: "user:owner",
        enabled: false,
        expectedVersion: 2,
      })
    ).result;
    expect(conflict).toMatchObject({
      kind: "conflict",
      allocatorEnabled: true,
      allocatorVersion: 3,
    });
    const [audit] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where workspace_id = ${ws.workspaceId}
        and target_id = ${credentialId}
        and action = 'codex.allocator.updated'`;
    expect(audit?.count).toBe(2);

    const loaded = await loadCodexCredentialForRun(dbA, settings, ws.workspaceId, credentialId);
    expect(loaded).not.toBeNull();
    const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
    expect(
      await recordCodexTokenRefresh(dbA, {
        id: credentialId,
        version: loaded!.version,
        workspaceId: ws.workspaceId,
        credentialEncrypted: encryptEnvironmentValue(
          key,
          JSON.stringify({
            access_token: "next",
            refresh_token: "next",
            id_token: "next",
          }),
        ),
        expiresAt: new Date(Date.now() + 120_000),
        lastRefreshAt: new Date(),
      }),
    ).toBe(true);
    expect((await listCodexAccountStatuses(dbA, ws.workspaceId))[0]?.allocatorVersion).toBe(3);
  });

  test("processing/provider_started claims fence concurrency and ambiguity with one upstream key", async () => {
    if (!available) return;
    const ws = await freshWorkspace("ambiguity");
    const credentialId = await connectCredential(ws, "ambiguity-provider");
    await setCodexCredentialExhausted(
      dbA,
      ws.workspaceId,
      credentialId,
      new Date(Date.now() + 60_000),
    );
    const id = crypto.randomUUID();
    const common = {
      id,
      ...ws,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "session-hash",
      creditId: "provider-credit-id",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
    };
    const claims = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        claimCodexResetRedemption(index % 2 === 0 ? dbA : dbB, {
          ...common,
          claimHolderId: crypto.randomUUID(),
        }),
      ),
    );
    const claimed = claims.find((result) => result.kind === "claimed") ?? null;
    expect(claimed).not.toBeNull();
    expect(claims.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((result) => result.kind === "in_progress")).toHaveLength(99);

    // Separate browser tabs generate separate UUIDs. The provider credit itself
    // is still one irreversible object and therefore one logical attempt.
    const crossTabCredit = "provider-credit-cross-tab";
    const crossTab = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        claimCodexResetRedemption(index % 2 === 0 ? dbA : dbB, {
          ...common,
          id: crypto.randomUUID(),
          creditId: crossTabCredit,
          claimHolderId: crypto.randomUUID(),
        }),
      ),
    );
    expect(crossTab.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(crossTab.filter((result) => result.kind === "conflict")).toHaveLength(19);
    const upstreamKey = claimed!.attempt.upstreamIdempotencyKey;
    const holder = claimed!.attempt.claimHolderId!;
    expect(claimed!.attempt.status).toBe("processing");
    expect(
      await fenceCodexResetRedemptionSend(dbA, {
        ...ws,
        attemptId: id,
        claimHolderId: holder,
        credentialId,
        subjectId: common.subjectId,
        browserSessionHash: common.browserSessionHash,
      }),
    ).toMatchObject({ kind: "ready" });
    await releaseCodexResetRedemptionClaim(dbA, {
      ...ws,
      attemptId: id,
      claimHolderId: holder,
      failureKind: "provider_timeout",
    });
    const retried = await claimCodexResetRedemption(dbB, {
      ...common,
      claimHolderId: crypto.randomUUID(),
    });
    expect(retried.kind).toBe("claimed");
    if (retried.kind !== "claimed") throw new Error("expected ambiguity retry claim");
    expect(retried.attempt.status).toBe("provider_started");
    expect(retried.attempt.upstreamIdempotencyKey).toBe(upstreamKey);
    const waiter = await seedCapacityWaiter(ws);

    // Completion and an HTTP retry can arrive together on different replicas.
    // They serialize without lock inversion; the retry sees live or completed
    // durable truth and never obtains a second claim.
    const [completion, racingRetry] = await Promise.all([
      completeCodexResetRedemption(dbB, {
        ...ws,
        attemptId: id,
        claimHolderId: retried.attempt.claimHolderId!,
        outcome: "alreadyRedeemed",
      }),
      claimCodexResetRedemption(dbA, {
        ...common,
        claimHolderId: crypto.randomUUID(),
      }),
    ]);
    const completed = completion.result;
    expect(completed?.outcome).toBe("alreadyRedeemed");
    expect(completion.wakeTargets).toHaveLength(1);
    expect(completion.wakeTargets[0]).toMatchObject({
      waiterId: waiter.id,
      sessionId: waiter.sessionId,
      workflowId: waiter.workflowId,
      wakeRevision: waiter.wakeRevision + 1,
    });
    expect(["in_progress", "completed"]).toContain(racingRetry.kind);
    expect((await listCodexAccountStatuses(dbA, ws.workspaceId))[0]?.exhaustedUntil).toBeNull();
    const replay = await claimCodexResetRedemption(dbA, {
      ...common,
      claimHolderId: crypto.randomUUID(),
    });
    expect(replay.kind).toBe("completed");
    const [audit] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where workspace_id = ${ws.workspaceId}
        and target_id = ${id}
        and action = 'codex.reset_credit.redemption.completed'`;
    expect(audit?.count).toBe(1);
  });

  test("persists and exactly-once audits every provider outcome without over-clearing cooldown", async () => {
    if (!available) return;
    for (const outcome of ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"] as const) {
      const ws = await freshWorkspace(`outcome-${outcome}`);
      const credentialId = await connectCredential(ws, `outcome-provider-${outcome}`);
      const exhaustedUntil = new Date(Date.now() + 60_000);
      await setCodexCredentialExhausted(dbA, ws.workspaceId, credentialId, exhaustedUntil);
      const id = crypto.randomUUID();
      const claim = await claimCodexResetRedemption(dbA, {
        id,
        ...ws,
        credentialId,
        subjectId: "user:owner",
        browserSessionHash: `session-${outcome}`,
        creditId: `credit-${outcome}`,
        confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
        claimHolderId: crypto.randomUUID(),
      });
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") throw new Error(`expected ${outcome} claim`);
      expect(
        await fenceCodexResetRedemptionSend(dbA, {
          ...ws,
          attemptId: id,
          claimHolderId: claim.attempt.claimHolderId!,
          credentialId,
          subjectId: "user:owner",
          browserSessionHash: `session-${outcome}`,
        }),
      ).toMatchObject({ kind: "ready" });
      const completed = (
        await completeCodexResetRedemption(dbA, {
          ...ws,
          attemptId: id,
          claimHolderId: claim.attempt.claimHolderId!,
          outcome,
        })
      ).result;
      expect(completed?.outcome).toBe(outcome);
      const replay = (
        await completeCodexResetRedemption(dbB, {
          ...ws,
          attemptId: id,
          claimHolderId: crypto.randomUUID(),
          outcome,
        })
      ).result;
      expect(replay?.outcome).toBe(outcome);
      const laterLogicalAttempt = await claimCodexResetRedemption(dbB, {
        id: crypto.randomUUID(),
        ...ws,
        credentialId,
        subjectId: "user:owner",
        browserSessionHash: `session-${outcome}`,
        creditId: `credit-${outcome}`,
        confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
        claimHolderId: crypto.randomUUID(),
      });
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        expect(laterLogicalAttempt.kind).toBe("conflict");
      } else {
        expect(laterLogicalAttempt.kind).toBe("claimed");
      }
      await admin`
        update codex_subscription_credentials
        set status = 'needs_relogin', last_error = 'injected after completion'
        where workspace_id = ${ws.workspaceId} and id = ${credentialId}`;
      const completedAfterHealthChange = await claimCodexResetRedemption(dbB, {
        id,
        ...ws,
        credentialId,
        subjectId: "user:owner",
        browserSessionHash: `session-${outcome}`,
        creditId: `credit-${outcome}`,
        confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
        claimHolderId: crypto.randomUUID(),
      });
      expect(completedAfterHealthChange.kind).toBe("completed");
      const row = (await listCodexAccountStatuses(dbA, ws.workspaceId))[0]!;
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        expect(row.exhaustedUntil).toBeNull();
      } else {
        expect(row.exhaustedUntil?.getTime()).toBe(exhaustedUntil.getTime());
      }
      const [audit] = await admin<{ count: number }[]>`
        select count(*)::int as count from audit_events
        where workspace_id = ${ws.workspaceId}
          and target_id = ${id}
          and action = 'codex.reset_credit.redemption.completed'`;
      expect(audit?.count).toBe(1);
    }
  });

  test("crash before provider_started reclaims as processing and RLS/owner/session mismatches fail closed", async () => {
    if (!available) return;
    const wsA = await freshWorkspace("preflight-a");
    const wsB = await freshWorkspace("preflight-b");
    const credentialId = await connectCredential(wsA, "preflight-provider");
    const id = crypto.randomUUID();
    const first = await claimCodexResetRedemption(dbA, {
      id,
      ...wsA,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "session-a",
      creditId: "credit-a",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("expected processing claim");
    await releaseCodexResetRedemptionClaim(dbA, {
      ...wsA,
      attemptId: id,
      claimHolderId: first.attempt.claimHolderId!,
      failureKind: "worker_crash_before_post",
    });
    const reclaimed = await claimCodexResetRedemption(dbB, {
      id,
      ...wsA,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "session-a",
      creditId: "credit-a",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(reclaimed.kind === "claimed" && reclaimed.attempt.status).toBe("processing");
    expect(await getCodexResetRedemptionAttempt(dbB, wsB.workspaceId, id)).toBeNull();
    const wrongOwner = await claimCodexResetRedemption(dbA, {
      id: crypto.randomUUID(),
      ...wsA,
      credentialId,
      subjectId: "user:other",
      browserSessionHash: "session-a",
      creditId: "credit-a",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(wrongOwner.kind).toBe("forbidden");
    const expiredConfirmation = await claimCodexResetRedemption(dbA, {
      id: crypto.randomUUID(),
      ...wsA,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "session-a",
      creditId: "credit-expired-confirmation",
      confirmationExpiresAt: new Date(Date.now() - 1),
      claimHolderId: crypto.randomUUID(),
    });
    expect(expiredConfirmation.kind).toBe("forbidden");
    if (reclaimed.kind === "claimed") {
      await releaseCodexResetRedemptionClaim(dbB, {
        ...wsA,
        attemptId: id,
        claimHolderId: reclaimed.attempt.claimHolderId!,
        failureKind: "test_release",
      });
    }
    const wrongSession = await claimCodexResetRedemption(dbA, {
      id,
      ...wsA,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "session-b",
      creditId: "credit-a",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(wrongSession.kind).toBe("conflict");
  });

  test("final send fence rechecks DB-time expiry, identity, health, and extends both fresh and resumed sends", async () => {
    if (!available) return;
    const ws = await freshWorkspace("final-send-fence");
    const credentialId = await connectCredential(ws, "final-send-provider");
    const claim = async (suffix: string, claimTtlMs = 60_000) => {
      const result = await claimCodexResetRedemption(dbA, {
        id: crypto.randomUUID(),
        ...ws,
        credentialId,
        subjectId: "user:owner",
        browserSessionHash: "session-final-send",
        creditId: `credit-${suffix}`,
        confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
        claimHolderId: crypto.randomUUID(),
        claimTtlMs,
      });
      if (result.kind !== "claimed") throw new Error(`expected ${suffix} claim`);
      return result.attempt;
    };
    const fence = async (attempt: Awaited<ReturnType<typeof claim>>) =>
      await fenceCodexResetRedemptionSend(dbA, {
        ...ws,
        attemptId: attempt.id,
        claimHolderId: attempt.claimHolderId!,
        credentialId,
        subjectId: "user:owner",
        browserSessionHash: "session-final-send",
        sendLeaseMs: 11_000,
      });

    const expiredConfirmation = await claim("confirmation-expiry");
    await admin`
      update codex_reset_redemption_attempts
      set confirmation_expires_at = now() - interval '1 second'
      where id = ${expiredConfirmation.id}`;
    expect(await fence(expiredConfirmation)).toEqual({
      kind: "not_ready",
      reason: "confirmation_expired",
    });
    expect(
      await getCodexResetRedemptionAttempt(dbA, ws.workspaceId, expiredConfirmation.id),
    ).toBeNull();

    const expiredClaim = await claim("claim-expiry");
    await admin`
      update codex_reset_redemption_attempts
      set claim_expires_at = now() - interval '1 second'
      where id = ${expiredClaim.id}`;
    expect(await fence(expiredClaim)).toEqual({ kind: "not_ready", reason: "claim_expired" });
    expect(await getCodexResetRedemptionAttempt(dbA, ws.workspaceId, expiredClaim.id)).toBeNull();

    const wrongIdentity = await claim("wrong-identity");
    expect(
      await fenceCodexResetRedemptionSend(dbA, {
        ...ws,
        attemptId: wrongIdentity.id,
        claimHolderId: wrongIdentity.claimHolderId!,
        credentialId,
        subjectId: "user:owner",
        browserSessionHash: "session-other",
      }),
    ).toEqual({ kind: "not_ready", reason: "identity_mismatch" });
    expect(
      await abandonCodexResetRedemptionBeforeProvider(dbA, {
        ...ws,
        attemptId: wrongIdentity.id,
        claimHolderId: wrongIdentity.claimHolderId!,
      }),
    ).toBe(true);

    const unhealthy = await claim("unhealthy");
    await admin`
      update codex_subscription_credentials set status = 'needs_relogin'
      where id = ${credentialId}`;
    expect(await fence(unhealthy)).toEqual({
      kind: "not_ready",
      reason: "credential_unavailable",
    });
    expect(await getCodexResetRedemptionAttempt(dbA, ws.workspaceId, unhealthy.id)).toBeNull();
    await admin`
      update codex_subscription_credentials set status = 'active', last_error = null
      where id = ${credentialId}`;

    const fresh = await claim("fresh");
    const ready = await fence(fresh);
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") throw new Error("expected fresh final-send fence");
    expect(ready.attempt.status).toBe("provider_started");
    expect(ready.attempt.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 9_000);
    const originalProviderKey = ready.attempt.upstreamIdempotencyKey;
    await releaseCodexResetRedemptionClaim(dbA, {
      ...ws,
      attemptId: ready.attempt.id,
      claimHolderId: ready.attempt.claimHolderId!,
      failureKind: "provider_timeout",
    });
    const resumed = await claimCodexResetRedemption(dbB, {
      id: ready.attempt.id,
      ...ws,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "session-final-send",
      creditId: ready.attempt.creditId,
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(resumed.kind).toBe("claimed");
    if (resumed.kind !== "claimed") throw new Error("expected resumed final-send claim");
    const resumedFence = await fence(resumed.attempt);
    expect(resumedFence.kind).toBe("ready");
    if (resumedFence.kind !== "ready") throw new Error("expected resumed final-send fence");
    expect(resumedFence.attempt.status).toBe("provider_started");
    expect(resumedFence.attempt.upstreamIdempotencyKey).toBe(originalProviderKey);
  });

  test("malformed quota preserves the last valid windows while a valid reset summary advances independently", async () => {
    if (!available) return;
    const ws = await freshWorkspace("independent-freshness");
    const credentialId = await connectCredential(ws, "independent-freshness-provider");
    const usageCheckedAt = new Date(Date.now() - 60_000);
    const primaryResetAt = new Date(Date.now() + 60 * 60_000);
    const secondaryResetAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    expect(
      await recordCodexAccountUsage(dbA, ws.workspaceId, credentialId, {
        primaryUsedPercent: 41,
        primaryResetAt,
        secondaryUsedPercent: 17,
        secondaryResetAt,
        checkedAt: usageCheckedAt,
        resetCreditAvailableCount: 2,
        resetCreditsCheckedAt: usageCheckedAt,
      }),
    ).toBe(true);

    const result = await fetchCodexUsageForAccount(
      dbA,
      settings,
      ws.workspaceId,
      credentialId,
      async () =>
        new Response(
          JSON.stringify({
            // This invalid shape makes quota parsing fail closed, while the
            // reset summary remains independently valid provider truth.
            rate_limit: "malformed",
            rate_limit_reset_credits: { available_count: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(result.status).toBe("error");
    expect(result.rateLimitResetCredits).toEqual({ availableCount: 7, credits: null });
    const [after] = await listCodexAccountStatuses(dbA, ws.workspaceId);
    expect(after?.primaryUsedPercent).toBe(41);
    expect(after?.primaryResetAt?.getTime()).toBe(primaryResetAt.getTime());
    expect(after?.secondaryUsedPercent).toBe(17);
    expect(after?.secondaryResetAt?.getTime()).toBe(secondaryResetAt.getTime());
    expect(after?.usageCheckedAt?.getTime()).toBe(usageCheckedAt.getTime());
    expect(after?.resetCreditAvailableCount).toBe(7);
    expect(after?.resetCreditsCheckedAt?.getTime()).toBeGreaterThan(usageCheckedAt.getTime());
  });

  test("owner-scoped server discovery adopts released ambiguity across browser sessions without changing its provider key", async () => {
    if (!available) return;
    const ws = await freshWorkspace("server-recovery");
    const otherWs = await freshWorkspace("server-recovery-other");
    const credentialId = await connectCredential(ws, "server-recovery-provider");
    const attemptId = crypto.randomUUID();
    const claimed = await claimCodexResetRedemption(dbA, {
      id: attemptId,
      ...ws,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "browser-session-old",
      creditId: "server-recovery-credit",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("expected server recovery claim");
    const ready = await fenceCodexResetRedemptionSend(dbA, {
      ...ws,
      attemptId,
      claimHolderId: claimed.attempt.claimHolderId!,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "browser-session-old",
    });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") throw new Error("expected server recovery send fence");
    const providerKey = ready.attempt.upstreamIdempotencyKey;
    await releaseCodexResetRedemptionClaim(dbA, {
      ...ws,
      attemptId,
      claimHolderId: ready.attempt.claimHolderId!,
      failureKind: "lost_http_response",
    });

    expect(
      await listCodexResetRedemptionRecoveries(dbA, { ...ws, subjectId: "user:owner" }),
    ).toMatchObject([
      {
        attemptId,
        credentialId,
        creditId: "server-recovery-credit",
        status: "provider_started",
        outcome: null,
      },
    ]);
    expect(
      await listCodexResetRedemptionRecoveries(dbA, { ...ws, subjectId: "user:other" }),
    ).toEqual([]);
    expect(
      await listCodexResetRedemptionRecoveries(dbA, {
        ...otherWs,
        subjectId: "user:owner",
      }),
    ).toEqual([]);

    const adopted = await adoptCodexResetRedemptionAttempt(dbB, {
      ...ws,
      attemptId,
      credentialId,
      creditId: "server-recovery-credit",
      subjectId: "user:owner",
      browserSessionHash: "browser-session-new",
    });
    expect(adopted.kind).toBe("adopted");
    if (adopted.kind !== "adopted") throw new Error("expected server recovery adoption");
    expect(adopted.attempt.browserSessionHash).toBe("browser-session-new");
    expect(adopted.attempt.upstreamIdempotencyKey).toBe(providerKey);
    const resumed = await claimCodexResetRedemption(dbB, {
      id: attemptId,
      ...ws,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "browser-session-new",
      creditId: "server-recovery-credit",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(resumed.kind).toBe("claimed");
    if (resumed.kind !== "claimed") throw new Error("expected adopted recovery claim");
    expect(resumed.attempt.upstreamIdempotencyKey).toBe(providerKey);
    const oldBrowser = await claimCodexResetRedemption(dbA, {
      id: attemptId,
      ...ws,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "browser-session-old",
      creditId: "server-recovery-credit",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(oldBrowser.kind).toBe("conflict");
  });

  test("disconnect and ownership transfer serialize with final send and durable ambiguity survives credential deletion", async () => {
    if (!available) return;
    const raceWs = await freshWorkspace("disconnect-send-race");
    const raceCredentialId = await connectCredential(raceWs, "disconnect-send-race-provider");
    const raceClaim = await claimCodexResetRedemption(dbA, {
      id: crypto.randomUUID(),
      ...raceWs,
      credentialId: raceCredentialId,
      subjectId: "user:owner",
      browserSessionHash: "browser-race",
      creditId: "credit-race",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(raceClaim.kind).toBe("claimed");
    if (raceClaim.kind !== "claimed") throw new Error("expected disconnect race claim");
    const [raceFence, raceDisconnect] = await Promise.all([
      fenceCodexResetRedemptionSend(dbA, {
        ...raceWs,
        attemptId: raceClaim.attempt.id,
        claimHolderId: raceClaim.attempt.claimHolderId!,
        credentialId: raceCredentialId,
        subjectId: "user:owner",
        browserSessionHash: "browser-race",
      }),
      disconnectCodexAccount(dbB, raceWs.workspaceId, raceCredentialId),
    ]);
    if (raceFence.kind === "ready") {
      expect(raceDisconnect).toMatchObject({
        removed: false,
        blockedByUnresolvedRedemption: true,
      });
    } else {
      expect(raceDisconnect.removed).toBe(true);
      expect(["not_found", "credential_unavailable"]).toContain(raceFence.reason);
    }
    expect(raceFence.kind === "ready" && raceDisconnect.removed).toBe(false);

    const ws = await freshWorkspace("disconnect-blocked");
    const credentialId = await connectCredential(ws, "disconnect-blocked-provider");
    const secondCredentialId = await connectCredential(ws, "disconnect-unblocked-provider");
    const claim = await claimCodexResetRedemption(dbA, {
      id: crypto.randomUUID(),
      ...ws,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "browser-blocked",
      creditId: "credit-blocked",
      confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimHolderId: crypto.randomUUID(),
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("expected blocked disconnect claim");
    const fenced = await fenceCodexResetRedemptionSend(dbA, {
      ...ws,
      attemptId: claim.attempt.id,
      claimHolderId: claim.attempt.claimHolderId!,
      credentialId,
      subjectId: "user:owner",
      browserSessionHash: "browser-blocked",
    });
    expect(fenced.kind).toBe("ready");
    if (fenced.kind !== "ready") throw new Error("expected blocked disconnect fence");
    await releaseCodexResetRedemptionClaim(dbA, {
      ...ws,
      attemptId: claim.attempt.id,
      claimHolderId: fenced.attempt.claimHolderId!,
      failureKind: "provider_timeout",
    });

    expect(await disconnectCodexAccount(dbB, ws.workspaceId, credentialId)).toMatchObject({
      removed: false,
      blockedByUnresolvedRedemption: true,
    });
    expect(await disconnectAllCodexAccounts(dbB, ws.workspaceId)).toEqual({
      removed: 0,
      blockedCredentialIds: [credentialId],
    });
    expect(
      (await listCodexAccountStatuses(dbA, ws.workspaceId)).map((row) => row.id).sort(),
    ).toEqual([credentialId, secondCredentialId].sort());

    const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
    const reconnect = async (subjectId: string) =>
      await upsertCodexSubscriptionCredential(dbB, {
        ...ws,
        credentialEncrypted: encryptEnvironmentValue(
          key,
          JSON.stringify({ access_token: "next", refresh_token: "next", id_token: "next" }),
        ),
        chatgptAccountId: "disconnect-blocked-provider",
        scopes: null,
        planType: "pro",
        isFedramp: false,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        lastRefreshAt: new Date(),
        connectedBySubjectId: subjectId,
      });
    expect(await reconnect("user:owner")).toMatchObject({
      kind: "upserted",
      id: credentialId,
      isNew: false,
    });
    expect(await reconnect("user:other")).toEqual({
      kind: "unresolved_redemption",
      id: credentialId,
      isNew: false,
    });

    const [deleted] = await admin<{ id: string }[]>`
      delete from codex_subscription_credentials where id = ${credentialId} returning id`;
    expect(deleted?.id).toBe(credentialId);
    const [durableAttempt] = await admin<{ count: number }[]>`
      select count(*)::int as count from codex_reset_redemption_attempts
      where id = ${claim.attempt.id}`;
    expect(durableAttempt?.count).toBe(1);
  });
});
