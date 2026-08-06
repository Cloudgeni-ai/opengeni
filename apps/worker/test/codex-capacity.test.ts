import { describe, expect, mock, test } from "bun:test";
import type { CodexCapacitySelectionContext, CodexLeaseAccountStatus } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  codexCapacityDecision,
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
      leaseRotationEnabled: true,
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

    expect(
      codexCapacityDecision(
        context,
        testSettings({
          codexCredentialLeasingEnabled: true,
        }),
      ),
    ).toMatchObject({
      kind: "available",
      credentialId: "healthy",
      diagnostic: { connectedCount: 3, eligibleCount: 1 },
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
      leaseRotationEnabled: false,
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

    expect(
      codexCapacityDecision(
        context,
        testSettings({
          codexCredentialLeasingEnabled: true,
        }),
      ),
    ).toMatchObject({
      kind: "unavailable",
      earliestResetAt: resetAt,
      resetKind: "authoritative",
      diagnostic: { connectedCount: 2, allocatorEnabledCount: 2 },
    });
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
});
