import { connectionModelAllowed } from "@opengeni/db";
import {
  getSessionGoal,
  acquireXaiCredentialLease,
  getXaiSessionAccountPin,
  setXaiSessionAccountPin,
  recordXaiSessionLastAccount,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  armXaiCapacityWait,
  acquireClaudeCredentialLease,
  getClaudeSessionAccountPin,
  setClaudeSessionAccountPin,
  recordClaudeSessionLastAccount,
  CLAUDE_CREDENTIAL_LEASE_TTL_MS,
  armClaudeCapacityWait,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";

import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import { refreshExhaustedXaiQuota } from "../xai-quota";

async function selectScopedSubscriptionTurnCapacity(
  deps: CapacityPhaseDeps,
  provider: "xai" | "claude",
): Promise<CapacityPhaseOutcome> {
  const {
    input,
    db,
    bus,
    dispatchId,
    control,
    billingState,
    eventing,
    providerTurn,
    leases,
    claimedResult,
    turn,
  } = deps;

  const claude = provider === "claude";
  const name = claude ? "Claude" : "SuperGrok";
  const acquireLease = claude ? acquireClaudeCredentialLease : acquireXaiCredentialLease;
  const getPin = claude ? getClaudeSessionAccountPin : getXaiSessionAccountPin;
  const setPin = claude ? setClaudeSessionAccountPin : setXaiSessionAccountPin;
  const recordLastAccount = claude ? recordClaudeSessionLastAccount : recordXaiSessionLastAccount;
  const armWait = claude ? armClaudeCapacityWait : armXaiCapacityWait;
  const lease = claude ? leases.claude : leases.xai;
  const credentialKey = claude ? "effectiveClaudeCredentialId" : "effectiveXaiCredentialId";
  const rotationKey = claude ? "claudeRotationEnabled" : "xaiRotationEnabled";
  const authorityKey = claude ? "claudeAuthoritySnapshot" : "xaiAuthoritySnapshot";
  if (claude ? billingState.isClaudeTurn : billingState.isXaiTurn) {
    const authoritySnapshot = claude
      ? turn.claudeProviderAccountAuthoritySnapshot
      : turn.xaiProviderAccountAuthoritySnapshot;
    providerTurn[authorityKey] = authoritySnapshot;
    if (claude) providerTurn.claudeUpstreamModelId = deps.turnExecutionPolicy.upstreamModelId;
    const subjectId =
      authoritySnapshot.scope === "user"
        ? turn.initiatingHumanSubjectId
        : "worker:" + provider + "-workspace";
    if (!subjectId) {
      throw new Error("User-scoped " + name + " work has no frozen initiating human");
    }
    const sessionPin = await getPin(db, {
      workspaceId: input.workspaceId,
      subjectId,
      sessionId: input.sessionId,
      authoritySnapshot,
    });
    if (!claude)
      await refreshExhaustedXaiQuota({
        db,
        settings: deps.settings,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId,
        sessionId: input.sessionId,
        turnId: turn.id,
        authoritySnapshot,
      });
    const leaseStartedAtMs = performance.now();
    const leased = await acquireLease(db, {
      upstreamModelId: deps.turnExecutionPolicy.upstreamModelId,
      modelId: deps.turnExecutionPolicy.productModelId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId,
      sessionId: input.sessionId,
      turnId: turn.id,
      holderId: dispatchId,
      authoritySnapshot,
      pinnedCredentialId: sessionPin?.pinnedCredentialId ?? null,
      pinSource:
        sessionPin?.pinSource === "manual" || sessionPin?.pinSource === "policy"
          ? sessionPin.pinSource
          : null,
    });
    providerTurn[credentialKey] = leased.credentialId;
    providerTurn[rotationKey] = leased.rotationEnabled;
    lease.subjectId = subjectId;
    lease.holderId = leased.holderId;
    lease.generation = leased.generation;
    lease.confirmedUntilMs = leased.leasedUntil
      ? leaseStartedAtMs + (claude ? CLAUDE_CREDENTIAL_LEASE_TTL_MS : XAI_CREDENTIAL_LEASE_TTL_MS)
      : null;
    lease.held =
      providerTurn[credentialKey] !== null &&
      leased.holderId !== null &&
      leased.generation !== null &&
      lease.confirmedUntilMs !== null;
    if (!providerTurn[credentialKey]) {
      const relevant =
        sessionPin?.pinnedCredentialId && sessionPin.pinSource !== "policy"
          ? leased.accounts.filter((account) => account.id === sessionPin.pinnedCredentialId)
          : leased.accounts;
      if (
        relevant.length > 0 &&
        relevant.every(
          (account) =>
            !connectionModelAllowed(
              account.allowedModelIds,
              deps.turnExecutionPolicy.productModelId,
            ),
        )
      )
        throw new Error("This model is disabled for the selected " + name + " subscription");
      const connected = leased.accounts.length;
      const allocatorEnabled = leased.accounts.filter((account) => account.allocatorEnabled).length;
      if (connected === 0) {
        throw Object.assign(
          new Error("No " + name + " subscription account is connected for this authority scope"),
          { code: provider + "_not_connected" },
        );
      }
      if (turn.source === "compaction") {
        if (
          !(await eventing.settle!({
            events: [
              {
                type: "turn.cancelled",
                payload: {
                  maintenance: "context_compaction",
                  reason: provider + "_capacity_unavailable",
                  requestPreserved: true,
                },
              },
              {
                type: "session.status.changed",
                payload: { status: "idle" },
              },
            ],
            turnStatus: "cancelled",
            sessionStatus: "idle",
            activeTurnId: null,
          }))
        ) {
          return { exit: claimedResult({ status: "cancelled" }) };
        }
        control.turnMetricOutcome = "cancelled";
        control.activityStatus = "idle";
        return { exit: claimedResult({ status: "idle", deferredUntilWake: true }) };
      }
      const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
      const activeGoal = goal?.status === "active" ? goal : null;
      const now = new Date();
      const futureResets = leased.accounts
        .map((account) => account.exhaustedUntil)
        .filter((date): date is Date => date !== null && date > now);
      const earliestResetAt = claude
        ? (leased.nextCheckAt ?? null)
        : futureResets.length
          ? new Date(Math.min(...futureResets.map((date) => date.getTime())))
          : null;
      const error =
        allocatorEnabled === 0
          ? "All connected " + name + " subscription accounts are disabled for allocation"
          : "All connected " + name + " subscription accounts are temporarily unavailable";
      const armed = await armWait(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId,
        sessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        authoritySnapshot,
        goalId: activeGoal?.id ?? null,
        goalVersion: activeGoal?.version ?? null,
        earliestResetAt,
        failurePayload: {
          error,
          code:
            allocatorEnabled === 0
              ? provider + "_allocator_disabled"
              : provider + "_capacity_unavailable",
          detail: "waiting for an eligible account, reconnect, pin change, or quota reset",
        },
      });
      if (armed.action === "waiting") {
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, armed.events);
        control.turnMetricOutcome = "recovering";
        control.activityStatus = "waiting_capacity";
        return {
          exit: claimedResult({
            status: "waiting_capacity",
            capacityWait: {
              provider,
              waiterId: armed.waiter.id,
              generation: armed.waiter.generation,
              nextCheckAt: armed.waiter.nextCheckAt.toISOString(),
              wakeRevision: armed.waiter.wakeRevision,
            },
          }),
        };
      }
      if (
        !(await eventing.settle!({
          events: [
            {
              type: "turn.failed",
              payload: {
                error,
                code: provider + "_capacity_wait_stale",
                retryable: false,
                recovery: "user_message",
              },
            },
            { type: "session.status.changed", payload: { status: "idle" } },
          ],
          turnStatus: "failed",
          sessionStatus: "idle",
          activeTurnId: null,
        }))
      ) {
        return { exit: claimedResult({ status: "cancelled" }) };
      }
      control.turnMetricOutcome = "failed";
      control.activityStatus = "idle";
      return { exit: claimedResult({ status: "idle" }) };
    }
    if (lease.held) lease.startHeartbeat();
    if (
      leased.rotationEnabled &&
      sessionPin?.pinSource !== "manual" &&
      (sessionPin?.pinnedCredentialId !== providerTurn[credentialKey] ||
        sessionPin?.pinSource !== "policy")
    ) {
      await setPin(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId,
        sessionId: input.sessionId,
        authoritySnapshot,
        credentialId: providerTurn[credentialKey],
        pinSource: "policy",
        expectedVersion: sessionPin?.version ?? null,
      }).catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === (claude ? "Claude" : "xAI") + " session pin changed"
        )
          return;
        throw error;
      });
    } else if (!leased.rotationEnabled && sessionPin?.pinSource === "policy") {
      await setPin(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId,
        sessionId: input.sessionId,
        authoritySnapshot,
        credentialId: null,
        pinSource: null,
        expectedVersion: sessionPin.version,
      }).catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === (claude ? "Claude" : "xAI") + " session pin changed"
        )
          return;
        throw error;
      });
    }
    await recordLastAccount(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId,
      sessionId: input.sessionId,
      authoritySnapshot,
      credentialId: providerTurn[credentialKey],
    });
  }

  return { ok: true };
}

export const selectXaiTurnCapacity = (deps: CapacityPhaseDeps) =>
  selectScopedSubscriptionTurnCapacity(deps, "xai");
export const selectClaudeTurnCapacity = (deps: CapacityPhaseDeps) =>
  selectScopedSubscriptionTurnCapacity(deps, "claude");
