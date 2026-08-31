import {
  getSessionGoal,
  acquireXaiCredentialLease,
  getXaiSessionAccountPin,
  setXaiSessionAccountPin,
  recordXaiSessionLastAccount,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  armXaiCapacityWait,
} from "@opengeni/db";

import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";

export async function selectXaiTurnCapacity(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  const {
    input,
    db,
    dispatchId,
    control,
    billingState,
    eventing,
    providerTurn,
    leases,
    claimedResult,
    turn,
  } = deps;

  if (billingState.isXaiTurn) {
    const authoritySnapshot = turn.xaiProviderAccountAuthoritySnapshot;
    providerTurn.xaiAuthoritySnapshot = authoritySnapshot;
    const subjectId =
      authoritySnapshot.scope === "user" ? turn.initiatingHumanSubjectId : "worker:xai-workspace";
    if (!subjectId) {
      throw new Error("User-scoped SuperGrok work has no frozen initiating human");
    }
    const sessionPin = await getXaiSessionAccountPin(db, {
      workspaceId: input.workspaceId,
      subjectId,
      sessionId: input.sessionId,
      authoritySnapshot,
    });
    const leaseStartedAtMs = performance.now();
    const leased = await acquireXaiCredentialLease(db, {
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
    providerTurn.effectiveXaiCredentialId = leased.credentialId;
    providerTurn.xaiRotationEnabled = leased.rotationEnabled;
    leases.xai.subjectId = subjectId;
    leases.xai.holderId = leased.holderId;
    leases.xai.generation = leased.generation;
    leases.xai.confirmedUntilMs = leased.leasedUntil
      ? leaseStartedAtMs + XAI_CREDENTIAL_LEASE_TTL_MS
      : null;
    leases.xai.held =
      providerTurn.effectiveXaiCredentialId !== null &&
      leased.holderId !== null &&
      leased.generation !== null &&
      leases.xai.confirmedUntilMs !== null;
    if (!providerTurn.effectiveXaiCredentialId) {
      const connected = leased.accounts.length;
      const allocatorEnabled = leased.accounts.filter((account) => account.allocatorEnabled).length;
      if (connected === 0) {
        throw Object.assign(
          new Error("No SuperGrok subscription account is connected for this authority scope"),
          { code: "xai_not_connected" },
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
                  reason: "xai_capacity_unavailable",
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
      const earliestResetAt = futureResets.length
        ? new Date(Math.min(...futureResets.map((date) => date.getTime())))
        : null;
      const error =
        allocatorEnabled === 0
          ? "All connected SuperGrok subscription accounts are disabled for allocation"
          : "All connected SuperGrok subscription accounts are temporarily unavailable";
      const armed = await armXaiCapacityWait(db, {
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
          code: allocatorEnabled === 0 ? "xai_allocator_disabled" : "xai_capacity_unavailable",
          detail: "waiting for an eligible account, reconnect, pin change, or quota reset",
        },
      });
      if (armed.action === "waiting") {
        await eventing.publishDurable(armed.events);
        control.turnMetricOutcome = "recovering";
        control.activityStatus = "waiting_capacity";
        return {
          exit: claimedResult({
            status: "waiting_capacity",
            capacityWait: {
              provider: "xai",
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
                code: "xai_capacity_wait_stale",
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
    if (leases.xai.held) leases.xai.startHeartbeat();
    if (
      leased.rotationEnabled &&
      sessionPin?.pinSource !== "manual" &&
      (sessionPin?.pinnedCredentialId !== providerTurn.effectiveXaiCredentialId ||
        sessionPin?.pinSource !== "policy")
    ) {
      await setXaiSessionAccountPin(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId,
        sessionId: input.sessionId,
        authoritySnapshot,
        credentialId: providerTurn.effectiveXaiCredentialId,
        pinSource: "policy",
        expectedVersion: sessionPin?.version ?? null,
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === "xAI session pin changed") return;
        throw error;
      });
    } else if (!leased.rotationEnabled && sessionPin?.pinSource === "policy") {
      await setXaiSessionAccountPin(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId,
        sessionId: input.sessionId,
        authoritySnapshot,
        credentialId: null,
        pinSource: null,
        expectedVersion: sessionPin.version,
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === "xAI session pin changed") return;
        throw error;
      });
    }
    await recordXaiSessionLastAccount(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId,
      sessionId: input.sessionId,
      authoritySnapshot,
      credentialId: providerTurn.effectiveXaiCredentialId,
    });
  }

  return { ok: true };
}
