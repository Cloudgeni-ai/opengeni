import {
  getSessionGoal,
  acquireCodexCredentialLease,
  armCodexCapacityWait,
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  getCodexRotationSettings,
  listCodexAccountStatuses,
  getSessionCodexState,
  recordSessionActiveCodexCredential,
  setSessionCodexPinInTransaction,
  setActiveCodexCredential,
  withSessionCodexCapacityMutation,
  type CodexCredentialLeaseResult,
  type CodexCredentialLeaseSelectionContext,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { type Settings } from "@opengeni/config";
import {
  authoritativeCodexCapacityResetAt,
  classifyCodexPin,
  computeIdleDelayMs,
  isCodexCredentialEligible,
  selectCodexCredentialLeaseForTurn,
  type CodexRotationStrategy,
  type RotationDecision,
} from "../codex-rotation";
import {
  codexFleetShadowDecisionMetricLabelsV1,
  codexFleetShadowErrorMetricLabelsV1,
  publishCodexFleetShadowDecisionV1,
} from "../codex-fleet-shadow";
import { signalCodexCapacityWakeTargets } from "../codex-capacity";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import { recordTurnStartupPhase } from "../../observability-metrics";
import { createTurnCredentialLeases } from "./credential-leases";
import { randomUUID } from "node:crypto";

import { refreshCappedCodexUsageRows } from "./codex";
import { codexUsageLimitFailurePayload, CODEX_USAGE_LIMIT_MAX_RESUME_MS } from "./errors";
import type { ClaimTurnOk } from "./claim";
import type {
  AttemptIdentityState,
  BillingState,
  ClaimedResult,
  EventingState,
  ProviderTurnState,
  TurnControlState,
} from "./turn-context";

export type CapacityPhaseDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
  signalCodexCapacityWorkflow: ActivityServices["signalCodexCapacityWorkflow"];
  cancellationSignal: AbortSignal | undefined;
  dispatchId: string;
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  eventing: EventingState & {
    publish: NonNullable<EventingState["publish"]>;
    settle: NonNullable<EventingState["settle"]>;
  };
  providerTurn: ProviderTurnState;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  claimedResult: ClaimedResult;
  acknowledgeLostAttemptOwnership: () => void;
  acknowledgeRecoveryQuiescence: () => void;
  setLastInputTokensFenced: (lastInputTokens: number | null) => Promise<void>;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  trigger: ClaimTurnOk["trigger"];
  codexWorkspaceKey: string;
};

export type CapacityPhaseOutcome = { exit: RunAgentTurnResult } | { ok: true };

export async function selectCodexTurnCapacity(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  const {
    input,
    settings,
    db,
    bus,
    observability,
    wakeSessionWorkflow,
    signalCodexCapacityWorkflow,
    control,
    attempt,
    billingState,
    eventing,
    providerTurn,
    leases,
    claimedResult,
    turn,
    codexWorkspaceKey,
  } = deps;
  const turnId = attempt.turnId;
  const holderId = leases.codex.holderId;
  if (!turnId) {
    throw new Error("Turn id was not initialized");
  }
  if (!holderId) {
    throw new Error("Codex lease holder was not initialized");
  }

  if (billingState.isCodexTurn) {
    const credentialSelectionStartedAt = performance.now();
    let credentialSelectionOutcome: "completed" | "failed" = "completed";
    try {
      const sessionCodex = await getSessionCodexState(db, input.workspaceId, input.sessionId);
      const sessionPin = sessionCodex?.pinnedCredentialId ?? null;
      const sessionPinSource = sessionCodex?.pinSource ?? null;
      const selectForTurn = (context: CodexCredentialLeaseSelectionContext) =>
        selectCodexCredentialLeaseForTurn({
          context,
          leasingEnabled: settings.codexCredentialLeasingEnabled,
          sessionId: input.sessionId,
          sessionPinnedCredentialId: sessionPin,
          sessionPinSource,
          sessionLastCredentialId: sessionCodex?.lastCredentialId ?? null,
          now: new Date(),
        });

      // Rollout/rollback path is intentionally table-inert. With the flag off,
      // old and new workers both use legacy pin > active-pointer selection and
      // neither reads nor writes the additive lease/cursor schema.
      let leased: CodexCredentialLeaseResult<RotationDecision>;
      let leaseAcquisitionStartedAtMs: number | null = null;
      if (settings.codexCredentialLeasingEnabled) {
        leaseAcquisitionStartedAtMs = performance.now();
        leased = await acquireCodexCredentialLease(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            turnId,
            holderId,
            advanceActivePointer: sessionPin === null,
          },
          selectForTurn,
        );
      } else {
        const [rotation, accounts] = await Promise.all([
          getCodexRotationSettings(db, input.workspaceId),
          listCodexAccountStatuses(db, input.workspaceId),
        ]);
        const leaseAccounts = accounts.map((account) => ({
          ...account,
          activeLeaseCount: 0,
          selectionCount: 0,
          lastSelectedAt: null,
        }));
        const activeCredentialId = rotation?.activeCredentialId ?? null;
        const selected = selectForTurn({
          accounts: leaseAccounts,
          activeCredentialId,
          rotationEnabled: rotation?.rotationEnabled ?? false,
          leaseRotationEnabled: false,
          rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
          existingCredentialId: null,
          policyScope: null,
          unavailableDiagnostics: [],
        });
        leased = {
          ...selected,
          accounts: leaseAccounts,
          activeCredentialId,
          rotationEnabled: rotation?.rotationEnabled ?? false,
          rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
          reused: false,
          holderId: null,
          generation: null,
          leasedUntil: null,
          unavailableDiagnostics: [],
          advanceActivePointer: selected.advanceActivePointer !== false,
        };
      }
      if (leased.decision.kind === "allCapped") {
        // Bounded self-heal of stale usage cache, then ONE new atomic selection.
        await refreshCappedCodexUsageRows(db, settings, input.workspaceId, leased.accounts, {
          signalCodexCapacityWorkflow,
          wakeSessionWorkflow,
        });
        if (settings.codexCredentialLeasingEnabled) {
          leaseAcquisitionStartedAtMs = performance.now();
          leased = await acquireCodexCredentialLease(
            db,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              turnId,
              holderId,
              advanceActivePointer: sessionPin === null,
            },
            selectForTurn,
          );
        } else {
          const [rotation, accounts] = await Promise.all([
            getCodexRotationSettings(db, input.workspaceId),
            listCodexAccountStatuses(db, input.workspaceId),
          ]);
          const leaseAccounts = accounts.map((account) => ({
            ...account,
            activeLeaseCount: 0,
            selectionCount: 0,
            lastSelectedAt: null,
          }));
          const selected = selectForTurn({
            accounts: leaseAccounts,
            activeCredentialId: rotation?.activeCredentialId ?? null,
            rotationEnabled: rotation?.rotationEnabled ?? false,
            leaseRotationEnabled: false,
            rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
            existingCredentialId: null,
            policyScope: null,
            unavailableDiagnostics: [],
          });
          leased = {
            ...selected,
            accounts: leaseAccounts,
            activeCredentialId: rotation?.activeCredentialId ?? null,
            rotationEnabled: rotation?.rotationEnabled ?? false,
            rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
            reused: false,
            holderId: null,
            generation: null,
            leasedUntil: null,
            unavailableDiagnostics: [],
            advanceActivePointer: selected.advanceActivePointer !== false,
          };
        }
      }
      const rotationDecision = leased.decision;
      const selectedPinDisposition = classifyCodexPin({
        pinnedCredentialId: sessionPin,
        pinSource: sessionPinSource,
        strategy: leased.rotationStrategy as CodexRotationStrategy,
        rotationEnabled: leased.rotationEnabled,
      });
      // pin policy pin persistence follows the atomic credential allocator selection. The selector
      // already ran exact-turn reuse before policy filtering and vetoed pointer
      // movement for manual/policy homes; this write only records the NEXT turn's
      // policy home (or clears a policy pin whose strategy is no longer active).
      if (
        selectedPinDisposition === "sharded" &&
        leased.credentialId !== null &&
        (sessionPinSource !== "policy" || sessionPin !== leased.credentialId)
      ) {
        const pinMutation = await withSessionCodexCapacityMutation(
          db,
          {
            workspaceId: input.workspaceId,
            reason: "codex_policy_pin_changed",
          },
          async (tx) => {
            const changed = await setSessionCodexPinInTransaction(
              tx,
              input.workspaceId,
              input.sessionId,
              leased.credentialId,
              "policy",
              {
                expected: {
                  pinnedCredentialId: sessionPin,
                  pinSource: sessionPinSource,
                },
              },
            );
            return { result: changed, changed };
          },
        );
        await signalCodexCapacityWakeTargets(
          { signalCodexCapacityWorkflow, wakeSessionWorkflow },
          pinMutation.wakeTargets,
        );
      } else if (selectedPinDisposition === "clearStale") {
        const pinMutation = await withSessionCodexCapacityMutation(
          db,
          {
            workspaceId: input.workspaceId,
            reason: "codex_stale_policy_pin_cleared",
          },
          async (tx) => {
            const changed = await setSessionCodexPinInTransaction(
              tx,
              input.workspaceId,
              input.sessionId,
              null,
              "policy",
              {
                expected: {
                  pinnedCredentialId: sessionPin,
                  pinSource: sessionPinSource,
                },
              },
            );
            return { result: changed, changed };
          },
        );
        await signalCodexCapacityWakeTargets(
          { signalCodexCapacityWorkflow, wakeSessionWorkflow },
          pinMutation.wakeTargets,
        );
      }
      if (
        !settings.codexCredentialLeasingEnabled &&
        leased.advanceActivePointer &&
        sessionPin === null &&
        rotationDecision.kind === "active" &&
        rotationDecision.moved
      ) {
        await setActiveCodexCredential(db, input.workspaceId, rotationDecision.credentialId);
      }
      providerTurn.effectiveCodexCredentialId = leased.credentialId;
      leases.codex.generation = leased.generation;
      leases.codex.confirmedUntilMs =
        leased.leasedUntil && leaseAcquisitionStartedAtMs !== null
          ? leaseAcquisitionStartedAtMs + CODEX_CREDENTIAL_LEASE_TTL_MS
          : null;
      leases.codex.held =
        providerTurn.effectiveCodexCredentialId !== null &&
        leased.holderId !== null &&
        leased.generation !== null &&
        leases.codex.confirmedUntilMs !== null;
      if (leases.codex.held) leases.codex.startHeartbeat();

      const actualOutcome = providerTurn.effectiveCodexCredentialId
        ? "selected"
        : rotationDecision.kind === "allCapped"
          ? "waiting"
          : "none";
      const actualReason = providerTurn.effectiveCodexCredentialId
        ? leased.reused
          ? "lease_reused"
          : sessionPin === providerTurn.effectiveCodexCredentialId
            ? "pin"
            : rotationDecision.kind === "active" && rotationDecision.moved
              ? "rotation"
              : "active"
        : rotationDecision.kind === "allCapped"
          ? "all_capped"
          : "none";
      const fencedInFlight = leased.reused;
      const shadowResult = await publishCodexFleetShadowDecisionV1({
        enabled: settings.codexFleetPolicyShadowEnabled,
        decision: {
          accounts: leased.accounts,
          actualCredentialId: providerTurn.effectiveCodexCredentialId,
          actualOutcome,
          actualReason,
          affinityCredentialId: fencedInFlight
            ? providerTurn.effectiveCodexCredentialId
            : (sessionPin ?? sessionCodex?.lastCredentialId ?? null),
          fencedInFlight,
          nearExhaustionPct: settings.codexRotationNearExhaustionPct,
          now: new Date(),
          aliasSeed: randomUUID(),
        },
        publish: eventing.publish,
      });
      if (shadowResult.outcome === "published") {
        const shadowPayload = shadowResult.payload;
        observability.incrementCounter({
          name: "opengeni_codex_fleet_shadow_decisions_total",
          help: "Shadow decisions by bounded actual/shadow outcome and comparison.",
          labels: codexFleetShadowDecisionMetricLabelsV1(shadowPayload),
        });
        observability.info("Codex adaptive fleet shadow decision", {
          workspaceId: input.workspaceId,
          policyVersion: shadowPayload.replay.policyVersion,
          inputFingerprint: shadowPayload.replay.inputFingerprint,
          decisionFingerprint: shadowPayload.replay.decisionFingerprint,
          actualOutcome: shadowPayload.actual.outcome,
          shadowOutcome: shadowPayload.replay.decision.outcome,
          comparison: shadowPayload.comparison,
          candidateCount: shadowPayload.replay.input.candidates.length,
          truncatedCandidateCount: shadowPayload.replay.truncatedCandidateCount,
          payloadBytes: shadowResult.payloadBytes,
        });
      } else if (shadowResult.outcome === "failed") {
        // Shadow observability is explicitly non-authoritative. A malformed
        // snapshot or event-write fault must never change the authoritative lease,
        // capacity wait, failover, or the account serving this fenced turn.
        observability.incrementCounter({
          name: "opengeni_codex_fleet_shadow_errors_total",
          help: "Shadow decision build/publication failures.",
          labels: codexFleetShadowErrorMetricLabelsV1(shadowResult),
        });
        observability.warn("Codex adaptive fleet shadow decision failed open", {
          stage: shadowResult.stage,
          reason: shadowResult.reason,
          errorClass: "CodexFleetShadowOperationError",
          errorCode: "codex_fleet_shadow_failed",
          origin: "worker",
          payloadBytes: shadowResult.payloadBytes,
        });
      }

      const eligibleCount = leased.accounts.filter((account) =>
        isCodexCredentialEligible(account, new Date()),
      ).length;
      const poolDepth = eligibleCount === 0 ? "zero" : eligibleCount === 1 ? "one" : "many";
      observability.incrementCounter({
        name: "opengeni_codex_pool_observations_total",
        help: "Observed eligible Codex pool depth buckets at turn selection.",
        labels: { workspace_key: codexWorkspaceKey, depth: poolDepth },
      });
      if (eligibleCount <= 1) {
        observability.incrementCounter({
          name: "opengeni_codex_pool_low_total",
          help: "Alert signal emitted when the eligible Codex pool is zero or one.",
          labels: { workspace_key: codexWorkspaceKey, depth: poolDepth },
        });
        observability.warn("Codex eligible credential pool is low", {
          workspaceId: input.workspaceId,
          eligibleCount,
          connectedCount: leased.accounts.length,
          depth: poolDepth,
        });
      }

      if (
        providerTurn.effectiveCodexCredentialId === null &&
        leased.accounts.length > 0 &&
        leased.accounts.every((account) => !account.allocatorEnabled) &&
        turnId
      ) {
        if (turn.source === "compaction") {
          if (
            !(await eventing.settle!({
              events: [
                {
                  type: "turn.cancelled",
                  payload: {
                    maintenance: "context_compaction",
                    reason: "codex_allocator_disabled",
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
        const armed = await armCodexCapacityWait(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          attemptId: input.attemptId,
          workflowId: input.workflowId,
          goalId: activeGoal?.id ?? null,
          goalVersion: activeGoal?.version ?? null,
          earliestResetAt: null,
          resetKind: "bounded_refresh",
          failurePayload: {
            error: "All connected Codex subscriptions are disabled for new allocations.",
            code: "codex_allocator_disabled",
            detail: "waiting for a credential to be re-enabled, reconnected, or added",
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
                  error: "All connected Codex subscriptions are disabled for new allocations.",
                  code: "codex_allocator_disabled",
                  retryable: false,
                  recovery: "user_message",
                },
              },
              {
                type: "session.status.changed",
                payload: { status: "idle" },
              },
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

      if (rotationDecision.kind === "allCapped" && turnId) {
        if (turn.source === "compaction") {
          if (
            !(await eventing.settle!({
              events: [
                {
                  type: "turn.cancelled",
                  payload: {
                    maintenance: "context_compaction",
                    reason: "codex_capacity_unavailable",
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
        // Every eligible account is capped/cooling (and a usage refresh did NOT
        // surface a reset): idle the turn AT THE BOUNDARY (no wasted model/sandbox
        // build) until the EARLIEST reset across all accounts — the multi-account
        // generalization of #143's single-account idle-until-reset. No saveRunState:
        // no model ran, nothing to freeze.
        const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
        const goalActive = Boolean(goal && goal.status === "active");
        // BOUNDED + POSITIVE: clamp to [MIN_IDLE_MS, max] so a null/elapsed/unknown
        // reset can never yield a 0 (which session.ts would treat as "continue now",
        // re-entering this path in a tight CPU/DB-hammering loop).
        const resumeMs = computeIdleDelayMs(
          rotationDecision.earliestResetAt,
          new Date(),
          CODEX_USAGE_LIMIT_MAX_RESUME_MS,
        );
        const failurePayload = codexUsageLimitFailurePayload(
          { resetsInSeconds: Math.ceil(resumeMs / 1000) },
          "all connected Codex subscriptions are rate-limited",
          { allAccounts: true },
        );
        const authoritativeResetAt = authoritativeCodexCapacityResetAt(leased.accounts, new Date());
        const armed = await armCodexCapacityWait(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          attemptId: input.attemptId,
          workflowId: input.workflowId,
          goalId: goalActive && goal ? goal.id : null,
          goalVersion: goalActive && goal ? goal.version : null,
          earliestResetAt: authoritativeResetAt,
          resetKind: authoritativeResetAt ? "authoritative" : "bounded_refresh",
          failurePayload,
        });
        if (armed.action === "waiting") {
          await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, armed.events);
          control.turnMetricOutcome = "recovering";
          control.activityStatus = "waiting_capacity";
          return {
            exit: claimedResult({
              status: "waiting_capacity",
              capacityWait: {
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
              // `rotated:true` (Finding 2): the proactive all-capped wait is the SAME
              // rotation-wait state as the reactive all-capped path, so it must freeze
              // autoContinuations identically (evaluateGoalContinuation reads this marker)
              // — a goal waiting out a long reset must not burn its continuation budget on
              // the proactive path while the reactive path spares it.
              {
                type: "turn.failed",
                payload: {
                  ...failurePayload,
                  recovery: goalActive ? "goal_continuation" : "user_message",
                  rotated: true,
                },
              },
              {
                type: "session.status.changed",
                payload: { status: "idle" },
              },
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
        // idleUntilReset marks this a MANDATORY hold: session.ts must wait the full
        // resumeMs even if a future change made it 0 — never a tight re-dispatch.
        return {
          exit: claimedResult(
            goalActive
              ? {
                  status: "idle",
                  continueDelayMs: resumeMs,
                  idleUntilReset: true,
                }
              : { status: "idle" },
          ),
        };
      }
      if (providerTurn.effectiveCodexCredentialId) {
        const priorAccountId = sessionCodex?.lastCredentialId ?? null;
        if (priorAccountId !== providerTurn.effectiveCodexCredentialId) {
          await recordSessionActiveCodexCredential(
            db,
            input.workspaceId,
            input.sessionId,
            providerTurn.effectiveCodexCredentialId,
          );
          const rotated = rotationDecision.kind === "active" && rotationDecision.moved;
          await eventing.publish([
            {
              type: "codex.account.switched",
              payload: {
                fromAccountId: priorAccountId,
                toAccountId: providerTurn.effectiveCodexCredentialId,
                reason: rotated ? "rotation" : "manual",
              },
            },
          ]);
        }

        const selectionReason = leased.reused
          ? "lease_reused"
          : sessionPin === providerTurn.effectiveCodexCredentialId
            ? "pin"
            : rotationDecision.kind === "active" && rotationDecision.moved
              ? "rotation"
              : "active";
        observability.incrementCounter({
          name: "opengeni_codex_credential_selections_total",
          help: "Codex credential selections by strategy and reason.",
          labels: {
            workspace_key: codexWorkspaceKey,
            strategy: leased.rotationStrategy,
            reason: selectionReason,
          },
        });
        await eventing.publish([
          {
            type: "codex.credential.selected",
            payload: {
              credentialId: providerTurn.effectiveCodexCredentialId,
              strategy: leased.rotationStrategy,
              reason: selectionReason,
              eligibleCount,
              connectedCount: leased.accounts.length,
              reused: leased.reused,
            },
          },
        ]);
      }
    } catch (error) {
      credentialSelectionOutcome = "failed";
      throw error;
    } finally {
      recordTurnStartupPhase(observability, {
        phase: "credential_selection",
        provider: "codex-subscription",
        backend: turn.sandboxBackend,
        outcome: credentialSelectionOutcome,
        durationSeconds: (performance.now() - credentialSelectionStartedAt) / 1_000,
      });
    }
  }

  return { ok: true };
}
