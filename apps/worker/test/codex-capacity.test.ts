import { describe, expect, mock, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { CodexCapacitySelectionContext, CodexLeaseAccountStatus } from "@opengeni/db";
import {
  codexCapacityDecision,
  createCodexCapacityActivities,
  refreshCodexUsageAndRepairCapacityWaiters,
  signalCodexCapacityWakeTargets,
} from "../src/activities/codex-capacity";

function account(
  id: string,
  overrides: Partial<CodexLeaseAccountStatus> = {},
): CodexLeaseAccountStatus {
  return {
    id,
    chatgptAccountId: `chatgpt-${id}`,
    label: id,
    accountEmail: null,
    planType: "pro",
    status: "active",
    allocatorEnabled: true,
    isActive: false,
    expiresAt: null,
    lastRefreshAt: null,
    lastError: null,
    primaryUsedPercent: 0,
    primaryResetAt: null,
    secondaryUsedPercent: 0,
    secondaryResetAt: null,
    usageCheckedAt: null,
    exhaustedUntil: null,
    exhaustedKind: null,
    activeLeaseCount: 0,
    selectionCount: 0,
    lastSelectedAt: null,
    ...overrides,
  };
}

describe("Codex capacity availability diagnostics", () => {
  test("eligibleCount uses the allocator's full health predicate", () => {
    const future = new Date("2100-01-01T00:00:00.000Z");
    const context: CodexCapacitySelectionContext = {
      accounts: [
        account("healthy"),
        account("cooling", { exhaustedUntil: future }),
        account("capped", { primaryUsedPercent: 100, primaryResetAt: future }),
      ],
      activeCredentialId: null,
      rotationEnabled: true,
      rotationStrategy: "most_remaining",
      existingCredentialId: null,
      policyScope: null,
      unavailableDiagnostics: [],
      sessionId: "session-1",
      sessionPinnedCredentialId: null,
      sessionPinSource: null,
      sessionLastCredentialId: null,
      policyHash: null,
    };

    expect(codexCapacityDecision(context)).toMatchObject({
      kind: "available",
      credentialId: "healthy",
      diagnostic: { connectedCount: 3, eligibleCount: 1 },
    });
  });

  test("typed quota cooldowns use bounded live reconciliation", () => {
    const resetAt = new Date("2100-01-01T00:00:00.000Z");
    const base: CodexCapacitySelectionContext = {
      accounts: [
        account("cooling", {
          exhaustedUntil: resetAt,
          exhaustedKind: "quota",
        }),
      ],
      activeCredentialId: "cooling",
      rotationEnabled: true,
      rotationStrategy: "most_remaining",
      existingCredentialId: null,
      policyScope: null,
      unavailableDiagnostics: [],
      sessionId: "session-quota-reconcile",
      sessionPinnedCredentialId: null,
      sessionPinSource: null,
      sessionLastCredentialId: null,
      policyHash: null,
    };

    expect(codexCapacityDecision(base)).toMatchObject({
      kind: "unavailable",
      earliestResetAt: resetAt,
      resetKind: "bounded_refresh",
    });
    expect(
      codexCapacityDecision({
        ...base,
        accounts: [account("cooling", { exhaustedUntil: resetAt, exhaustedKind: "rate_limit" })],
      }),
    ).toMatchObject({
      kind: "unavailable",
      earliestResetAt: resetAt,
      resetKind: "authoritative",
    });
  });

  test("rotation-off capped active account stays unavailable despite a healthy alternate", () => {
    const resetAt = new Date("2100-01-01T00:00:00.000Z");
    const context: CodexCapacitySelectionContext = {
      accounts: [
        account("active-capped", { primaryUsedPercent: 100, primaryResetAt: resetAt }),
        account("healthy-alternate"),
      ],
      activeCredentialId: "active-capped",
      rotationEnabled: false,
      rotationStrategy: "sharded",
      existingCredentialId: null,
      policyScope: null,
      unavailableDiagnostics: [],
      sessionId: "session-rotation-off",
      sessionPinnedCredentialId: null,
      sessionPinSource: null,
      sessionLastCredentialId: null,
      policyHash: null,
    };

    expect(codexCapacityDecision(context)).toMatchObject({
      kind: "unavailable",
      earliestResetAt: resetAt,
      resetKind: "authoritative",
      diagnostic: { connectedCount: 2, allocatorEnabledCount: 2 },
    });
  });

  test("allocator-disabled policy selections stay unavailable despite a healthy alternate", () => {
    const accounts = [
      account("selected-disabled", { allocatorEnabled: false }),
      account("healthy-alternate"),
    ];
    const base: CodexCapacitySelectionContext = {
      accounts,
      activeCredentialId: "selected-disabled",
      rotationEnabled: false,
      rotationStrategy: "sharded",
      existingCredentialId: null,
      policyScope: null,
      unavailableDiagnostics: [],
      sessionId: "session-disabled-selection",
      sessionPinnedCredentialId: null,
      sessionPinSource: null,
      sessionLastCredentialId: "healthy-alternate",
      policyHash: null,
    };

    expect(codexCapacityDecision(base)).toMatchObject({
      kind: "unavailable",
      earliestResetAt: null,
      resetKind: "mutation_only",
      diagnostic: { connectedCount: 2, allocatorEnabledCount: 1 },
    });
    expect(
      codexCapacityDecision({
        ...base,
        rotationEnabled: true,
        sessionPinnedCredentialId: "selected-disabled",
        sessionPinSource: "manual",
      }),
    ).toMatchObject({
      kind: "unavailable",
      earliestResetAt: null,
      resetKind: "mutation_only",
      diagnostic: { connectedCount: 2, allocatorEnabledCount: 1 },
    });
  });

  test("policy-selected auth failures remain mutation-only while quota-unknown stays bounded", () => {
    const context: CodexCapacitySelectionContext = {
      accounts: [
        account("selected-auth", { status: "needs_relogin" }),
        account("healthy-alternate"),
      ],
      activeCredentialId: "selected-auth",
      rotationEnabled: false,
      rotationStrategy: "sharded",
      existingCredentialId: null,
      policyScope: null,
      unavailableDiagnostics: [],
      sessionId: "session-auth-selection",
      sessionPinnedCredentialId: null,
      sessionPinSource: null,
      sessionLastCredentialId: null,
      policyHash: null,
    };
    expect(codexCapacityDecision(context)).toMatchObject({
      kind: "unavailable",
      resetKind: "mutation_only",
    });
    expect(
      codexCapacityDecision({
        ...context,
        accounts: [
          account("selected-auth", { primaryUsedPercent: 100, primaryResetAt: null }),
          account("healthy-alternate"),
        ],
      }),
    ).toMatchObject({ kind: "unavailable", resetKind: "bounded_refresh" });
  });

  test("committed capacity targets prefer typed signals and retain generic outbox delivery", async () => {
    const target = {
      accountId: "account",
      workspaceId: "workspace",
      sessionId: "session",
      workflowId: "session-session",
      waiterId: "waiter",
      generation: 3,
      wakeRevision: 9,
      workflowWakeRevision: 11,
    };
    const revisioned = mock(async () => undefined);
    const queueWake = mock(async () => undefined);
    await signalCodexCapacityWakeTargets(
      { signalCodexCapacityWorkflow: revisioned, wakeSessionWorkflow: queueWake },
      [target],
    );
    expect(revisioned).toHaveBeenCalledWith({
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      wakeRevision: target.wakeRevision,
    });
    expect(queueWake).not.toHaveBeenCalled();

    await signalCodexCapacityWakeTargets(
      { signalCodexCapacityWorkflow: null, wakeSessionWorkflow: queueWake },
      [target],
    );
    expect(queueWake).toHaveBeenCalledWith({
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      wakeRevision: target.workflowWakeRevision,
    });
  });

  test("worker usage refresh always repairs committed waiter revisions", async () => {
    const order: string[] = [];
    const firstRefresh = mock(async () => {
      order.push("refresh-1");
    });
    const failedRefresh = mock(async () => {
      order.push("refresh-2");
      throw new Error("provider unavailable");
    });
    const repair = mock(async () => {
      order.push("repair");
    });

    await refreshCodexUsageAndRepairCapacityWaiters([firstRefresh, failedRefresh], repair);

    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(failedRefresh).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(order.at(-1)).toBe("repair");
  });

  test("a due mutation-only waiter re-evaluates status without provider quota polling", async () => {
    const waiter = {
      id: "waiter-mutation-only",
      generation: 2,
      resetKind: "mutation_only",
      nextCheckAt: new Date("2026-09-03T00:00:00.000Z"),
      wakeRevision: 4,
      observedWakeRevision: 4,
    };
    const getWait = spyOn(opengeniDb, "getCodexCapacityWaitForSession").mockResolvedValue(
      waiter as never,
    );
    const refresh = spyOn(opengeniDb, "fetchCodexUsageForAccount");
    const reconcile = spyOn(opengeniDb, "reconcileCodexCapacityWait").mockResolvedValue({
      action: "waiting",
      waiter,
      events: [],
    } as never);
    const activities = createCodexCapacityActivities(
      async () =>
        ({
          db: {},
          bus: { publish: async () => undefined },
          wakeSessionWorkflow: async () => undefined,
          signalCodexCapacityWorkflow: async () => undefined,
        }) as never,
    );

    try {
      const result = await activities.reconcileCodexCapacityWait({
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        waiterId: waiter.id,
        generation: waiter.generation,
        cause: "timer",
      });
      expect(result.action).toBe("waiting");
      expect(refresh).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ boundedRefreshAttempted: false }),
        expect.any(Function),
      );
    } finally {
      getWait.mockRestore();
      refresh.mockRestore();
      reconcile.mockRestore();
    }
  });
});
