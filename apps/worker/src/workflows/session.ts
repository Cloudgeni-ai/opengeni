import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  patched,
  setHandler,
  TimeoutFailure,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
  activity,
  goalActivity,
  turnActivityForTaskQueue,
  workflowFailureMessage,
} from "./activities";

/**
 * Deterministic backstop for continueAsNew. A session workflow is long-lived
 * by design (weeks-long manager goals), so its Temporal EVENT HISTORY grows
 * without bound — every signal, activity schedule/complete and timer adds
 * events, and the server force-terminates a run at its hard history limit
 * (~51,200 events / 50MB), killing the session. The server's
 * `continueAsNewSuggested` flag is the primary trigger (it fires well before
 * the hard cap), but a turn-counter backstop guarantees a continueAsNew even
 * if the suggestion never arrives (e.g. a deployment that never raises it).
 * Conservatively low relative to the event budget: a single turn schedules a
 * handful of history events, so a few thousand turns stays far under the cap
 * while keeping continueAsNew rare enough that it is not a per-turn cost.
 */
const TURNS_PER_RUN_BACKSTOP = 2_000;
const CODEX_CAPACITY_CHECKS_PER_RUN_BACKSTOP = 512;
const HUMAN_INPUT_EXPIRY_STALE_RETRY_MS = 1_000;

/**
 * The minimum hold for a rotation all-capped idle (`idleUntilReset`). A MANDATORY
 * floor so that even a 0/elapsed continueDelayMs (a stale/unknown reset) can never
 * collapse the hold into a tight re-dispatch loop that hammers CPU/DB and never runs
 * the model (invariant 4: NO THRASH). Mirrors MIN_IDLE_MS in codex-rotation.ts; kept
 * local so the deterministic workflow bundle does not import the activities module.
 */
const ROTATION_IDLE_FLOOR_MS = 60_000; // 60s

/**
 * How long the continuation loop must hold before re-admitting the next turn. 0 ⇒ no
 * hold (re-dispatch immediately — a rotation candidate is ready, or no idle delay was
 * requested). A rotation all-capped idle (`idleUntilReset`) ALWAYS holds at least
 * `floorMs`, so a 0/elapsed continueDelayMs can never skip the hold (invariant 4).
 * Pure + exported so the boundedness contract is unit-testable without a workflow env.
 */
export function continuationHoldMs(
  result: {
    status: string;
    continueDelayMs?: number;
    idleUntilReset?: boolean;
  },
  floorMs: number,
): number {
  if (result.status !== "idle" && result.status !== "recovering") {
    return 0;
  }
  const delay = result.continueDelayMs ?? 0;
  if (result.idleUntilReset) {
    return Math.max(delay, floorMs);
  }
  return Math.max(delay, 0);
}

/**
 * A deferred activity result is terminal for this workflow run unless a new
 * non-control wake committed while the activity was in flight. Keeping this
 * predicate pure makes the compaction-convergence fence directly testable:
 * repeated identical failures cannot synthesize more work from an unchanged
 * durable state. Pause/Steer remain authoritative through the independent
 * signal-version and interruption paths in `sessionWorkflow`.
 */
export function deferredResultMayContinue(entryWakeups: number, currentWakeups: number): boolean {
  return currentWakeups !== entryWakeups;
}

/** Deterministic Temporal timer delay for a persisted structured-input deadline. */
export function humanInputDeadlineWaitMs(expiresAt: string, nowMs = Date.now()): number {
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : 0;
}

/**
 * True when an agent-turn activity failure means "the worker hosting the
 * turn died or vanished" rather than "the turn itself failed": the server
 * closed the activity with a HEARTBEAT timeout (the worker was killed before
 * the graceful recovery checkpoint could run — SIGKILL, OOM, node loss, or a
 * rollout whose grace period expired) or a SCHEDULE_TO_START timeout (no
 * worker ever picked the task up). Detection uses the SDK's typed failure
 * classes, not message-string matching: the failure converter rehydrates
 * ActivityFailure/TimeoutFailure instances deterministically from recorded
 * history on replay, so instanceof + timeoutType checks are replay-safe and
 * do not depend on server-controlled message text. START_TO_CLOSE /
 * SCHEDULE_TO_CLOSE timeouts are deliberately excluded: with the 30-day
 * startToClose they mean the turn truly overran, which stays a real failure.
 */
function workerDeathFailure(
  error: unknown,
): { timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START" } | null {
  if (!(error instanceof ActivityFailure)) {
    return null;
  }
  const cause = error.cause;
  if (
    !(cause instanceof TimeoutFailure) ||
    (cause.timeoutType !== "HEARTBEAT" && cause.timeoutType !== "SCHEDULE_TO_START")
  ) {
    return null;
  }
  return { timeoutType: cause.timeoutType };
}

/**
 * Classify only the exact turn-fence cancellation protocol used to arbitrate a
 * database control commit that reaches the activity just before its Temporal
 * signal reaches this workflow. This shape is never physical-quiescence proof:
 * only the activity's durable post-tool-fence receipt can open replacement
 * admission. @temporalio/worker 1.20 serializes the pre-request
 * CancelledFailure as an ApplicationFailure with the stable `CancelledFailure`
 * type, so accept that exact wire shape in addition to normal cancellation.
 */
export function isTurnActivityFenceCancellation(error: unknown): boolean {
  if (isCancellation(error)) return true;
  if (!(error instanceof ActivityFailure)) return false;
  if (error.cause !== undefined && isCancellation(error.cause)) return true;
  return (
    error.activityType === "runAgentTurn" &&
    error.cause instanceof ApplicationFailure &&
    error.cause.type === "CancelledFailure" &&
    error.cause.message === "TURN_ATTEMPT_FENCED"
  );
}

export const userMessage = defineSignal<[string]>("userMessage");
export const queueChanged = defineSignal("queueChanged");
export const approvalDecision = defineSignal<[string]>("approvalDecision");
export const sessionControl = defineSignal("sessionControl");
export const codexCapacityChanged = defineSignal<[number]>("codexCapacityChanged");
export const sessionAttemptQuiesced =
  defineSignal<[activities.SessionAttemptQuiescenceProof]>("sessionAttemptQuiesced");

export type SessionWorkflowInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  initialEventId?: string;
  // Per-run continueAsNew backstop, propagated across continueAsNew. Production
  // omits it (defaults to TURNS_PER_RUN_BACKSTOP); tests set it low to exercise
  // the boundary without simulating thousands of turns. Never gates correctness
  // — continueAsNewSuggested is the real-world trigger.
  maxTurnsPerRun?: number;
  // Test-only override for the durable capacity-wait continue-as-new
  // backstop. Production uses CODEX_CAPACITY_CHECKS_PER_RUN_BACKSTOP.
  maxCapacityChecksPerRun?: number;
};

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<void> {
  // Existing histories recorded the v1 WAIT_CANCELLATION_COMPLETED command
  // order and workflow-side idempotent fallback. Keep that exact replay path;
  // every new run records v2 and uses the activity-owned receipt contract.
  const receiptGatedCancellation = patched("session-attempt-quiescence-v2");
  const turnActivity = turnActivityForTaskQueue(workflowInfo().taskQueue, receiptGatedCancellation);
  let approvalWakeups = 0;
  let interruptionWakeups = 0;
  let wakeups = 0;
  let capacityWakeups = 0;
  let signalVersion = 0;
  let nonControlSignalVersion = 0;
  const pendingQuiescenceProofs = new Map<string, activities.SessionAttemptQuiescenceProof>();
  const persistedQuiescenceProofs = new Set<string>();
  // Turns dispatched on THIS run (reset to 0 by continueAsNew). The backstop
  // for the history-overflow guard below; bounded growth is what makes a
  // weeks-long session survivable.
  let turnsThisRun = 0;
  let capacityChecksThisRun = 0;

  setHandler(userMessage, () => {
    signalVersion += 1;
    nonControlSignalVersion += 1;
    wakeups += 1;
  });
  setHandler(queueChanged, () => {
    signalVersion += 1;
    nonControlSignalVersion += 1;
    wakeups += 1;
  });
  setHandler(approvalDecision, () => {
    signalVersion += 1;
    nonControlSignalVersion += 1;
    approvalWakeups += 1;
  });
  setHandler(sessionControl, () => {
    signalVersion += 1;
    interruptionWakeups += 1;
  });
  setHandler(codexCapacityChanged, () => {
    signalVersion += 1;
    nonControlSignalVersion += 1;
    capacityWakeups += 1;
  });
  setHandler(sessionAttemptQuiesced, (proof) => {
    // Temporal signals are untrusted transport payloads. Accept only the exact
    // workflow/session scope; the DB control activity additionally validates
    // the persisted attempt's account, run id, and activity id under lock.
    if (
      !isSessionAttemptQuiescenceProof(proof) ||
      proof.accountId !== input.accountId ||
      proof.workspaceId !== input.workspaceId ||
      proof.sessionId !== input.sessionId ||
      proof.workflowId !== workflowInfo().workflowId
    ) {
      return;
    }
    const key = sessionAttemptQuiescenceProofKey(proof);
    if (persistedQuiescenceProofs.has(key) || pendingQuiescenceProofs.has(key)) return;
    pendingQuiescenceProofs.set(key, proof);
    signalVersion += 1;
  });

  async function persistPendingQuiescenceProofs(): Promise<void> {
    while (pendingQuiescenceProofs.size > 0) {
      const entry = pendingQuiescenceProofs.entries().next().value;
      if (!entry) return;
      const [key, proof] = entry;
      // This DB-only activity uses an unbounded Temporal retry policy. The
      // workflow cannot peek, close, or continue-as-new until the exact
      // physical proof commits its idempotent receipt and wake transaction.
      await activity.persistSessionAttemptQuiescence(proof);
      pendingQuiescenceProofs.delete(key);
      persistedQuiescenceProofs.add(key);
    }
  }

  async function waitForCodexCapacity(
    initial: activities.CodexCapacityWaitRef,
    entryBaseline?: { wakeups: number; capacityWakeups: number },
  ): Promise<void> {
    let current = initial;
    let firstEntryBaseline = entryBaseline;
    for (;;) {
      // Signals can land after the waiter commit but before runAgentTurn returns.
      // Compare the first wait against pre-dispatch counters so they cannot be
      // baselined away; later iterations use their normal local snapshot.
      const seenWakeups = firstEntryBaseline?.wakeups ?? wakeups;
      const seenCapacityWakeups = firstEntryBaseline?.capacityWakeups ?? capacityWakeups;
      const seenInterruptionWakeups = interruptionWakeups;
      firstEntryBaseline = undefined;
      const parsedDeadline = Date.parse(current.nextCheckAt);
      const timerMs = Number.isFinite(parsedDeadline)
        ? Math.max(0, parsedDeadline - Date.now())
        : 0;
      let cause: activities.ReconcileCodexCapacityWaitInput["cause"] = "timer";
      if (wakeups !== seenWakeups) {
        cause = "queue";
      } else if (capacityWakeups !== seenCapacityWakeups) {
        cause = "signal";
      } else if (timerMs > 0) {
        await condition(
          () =>
            interruptionWakeups !== seenInterruptionWakeups ||
            wakeups !== seenWakeups ||
            capacityWakeups !== seenCapacityWakeups,
          timerMs,
        );
        if (interruptionWakeups !== seenInterruptionWakeups) {
          return;
        }
        cause =
          wakeups !== seenWakeups
            ? "queue"
            : capacityWakeups !== seenCapacityWakeups
              ? "signal"
              : "timer";
      }
      const result = await activity.reconcileCodexCapacityWait({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        waiterId: current.waiterId,
        generation: current.generation,
        cause,
      });
      if (result.action !== "waiting") {
        return;
      }
      capacityChecksThisRun += 1;
      const capacityCheckBackstop =
        input.maxCapacityChecksPerRun ?? CODEX_CAPACITY_CHECKS_PER_RUN_BACKSTOP;
      if (workflowInfo().continueAsNewSuggested || capacityChecksThisRun >= capacityCheckBackstop) {
        // The waiter/outbox is durable in Postgres. A fresh workflow run reads
        // it before goal continuation, reconstructs its timer, and turns any
        // unobserved wake revision into an immediate evaluation.
        // A quiescence proof is the one signal that is not merely a replaceable
        // wake hint. It may have arrived while the reconciliation activity was
        // running, so commit it before crossing this nested continue-as-new
        // boundary.
        await persistPendingQuiescenceProofs();
        await continueAsNew<typeof sessionWorkflow>({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          ...(input.maxTurnsPerRun !== undefined ? { maxTurnsPerRun: input.maxTurnsPerRun } : {}),
          ...(input.maxCapacityChecksPerRun !== undefined
            ? { maxCapacityChecksPerRun: input.maxCapacityChecksPerRun }
            : {}),
        });
      }
      current = result;
    }
  }

  while (true) {
    // A proof signal can signalWithStart a fresh run or arrive at any prior
    // close/continue-as-new boundary. Persist it before every ordinary workflow
    // decision so no accepted physical fact can be dropped with run history.
    await persistPendingQuiescenceProofs();
    // History-overflow guard. The top of the loop is the only safe
    // continueAsNew boundary: no turn is mid-flight (every path that reaches a
    // new iteration settled or recovered its turn first). Every interruption
    // is already durable in Postgres, so ordinary Temporal signals are
    // replaceable wake hints and none must be carried into the next workflow
    // run. A
    // buffered userMessage/queueChanged signal only
    // bumps `wakeups`, and its turn was written to Postgres BEFORE the signal
    // was sent, so the fresh run observes it on its first durable work peek
    // — losing the counter strands nothing. The queue living in Postgres is the
    // safety net: continueAsNew carries only the self-contained
    // SessionWorkflowInput (no initialEventId — the new run claims from the
    // queue, it does not replay a seed event). Quiescence-proof signals are the
    // exception: persistPendingQuiescenceProofs() immediately above commits
    // every accepted proof before this boundary.
    //
    // Approval signals are wakeups, never conversation truth. A genuinely
    // accepted decision is already persisted on the turn and is rediscovered
    // by the next durable peek, including after continue-as-new. Stale or
    // duplicate signals therefore cannot block this boundary or manufacture a
    // second approval dispatch.
    {
      const info = workflowInfo();
      const maxTurnsPerRun = input.maxTurnsPerRun ?? TURNS_PER_RUN_BACKSTOP;
      const shouldContinue = info.continueAsNewSuggested || turnsThisRun >= maxTurnsPerRun;
      if (shouldContinue) {
        await continueAsNew<typeof sessionWorkflow>({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          ...(input.maxTurnsPerRun !== undefined ? { maxTurnsPerRun: input.maxTurnsPerRun } : {}),
          ...(input.maxCapacityChecksPerRun !== undefined
            ? { maxCapacityChecksPerRun: input.maxCapacityChecksPerRun }
            : {}),
        });
      }
    }
    // Capture before the final activity chain of this cycle. Temporal may
    // accept a signal while an activity completion and workflow completion
    // race; every terminal return below must observe that arrival and loop.
    const closeSignalVersion = signalVersion;
    const closeNonControlSignalVersion = nonControlSignalVersion;
    const workflowId = workflowInfo().workflowId;
    const peek = await activity.peekSessionWork({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
    if (peek.kind === "interruption-pending") {
      const settlement = await activity.settleSessionInterruptions({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        attemptId: peek.attemptId,
        workflowId,
      });
      if (settlement.action === "paused") {
        if (pendingQuiescenceProofs.size > 0) {
          continue;
        }
        if (nonControlSignalVersion !== closeNonControlSignalVersion) {
          continue;
        }
        return;
      }
      continue;
    }
    if (peek.kind === "cancellation-wait") {
      // Logical settlement is complete, but the exact predecessor activity has
      // not yet durably proved sandbox/tool quiescence. Wait only briefly for
      // its transactional queueChanged wake. If provider/tool cancellation is
      // genuinely slow, close this workflow run rather than consuming a turn
      // slot or churning control activities; the outbox uses signalWithStart to
      // restart this exact workflow after the receipt commits.
      const seenSignalVersion = signalVersion;
      const woke = await condition(() => signalVersion !== seenSignalVersion, "5s");
      if (woke) continue;
      // Close only against the same signal snapshot. A proof signal accepted
      // at the timer/completion boundary must loop through the DB-only receipt
      // activity rather than disappearing with this workflow run.
      if (signalVersion !== seenSignalVersion || pendingQuiescenceProofs.size > 0) continue;
      return;
    }
    if (peek.kind === "capacity-wait") {
      await waitForCodexCapacity(peek.ref);
      continue;
    }
    if (peek.kind === "approval-wait") {
      const seenApprovalWakeups = approvalWakeups;
      const seenWakeups = wakeups;
      const seenInterruptionWakeups = interruptionWakeups;
      const timeoutMs =
        peek.humanInputRequestId && peek.expiresAt
          ? humanInputDeadlineWaitMs(peek.expiresAt)
          : undefined;
      const wakeCondition = () =>
        interruptionWakeups !== seenInterruptionWakeups ||
        approvalWakeups !== seenApprovalWakeups ||
        wakeups !== seenWakeups;
      const woke =
        timeoutMs === undefined
          ? await condition(wakeCondition)
          : await condition(wakeCondition, timeoutMs);
      if (!woke && peek.humanInputRequestId) {
        const expiry = await activity.expireSessionHumanInput({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          requestId: peek.humanInputRequestId,
        });
        // Temporal and PostgreSQL may observe slightly different wall clocks.
        // If the workflow timer fired first, the DB settler truthfully leaves
        // the request pending. Bound that skew with one interruptible timer
        // instead of spinning peek + activity at zero delay.
        if (expiry.action === "stale") {
          await condition(wakeCondition, HUMAN_INPUT_EXPIRY_STALE_RETRY_MS);
        }
      }
      continue;
    }
    if (peek.kind === "idle") {
      let continuation: activities.MaybeContinueGoalResult = { action: "none" };
      try {
        continuation = await goalActivity.maybeContinueGoal({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          workflowId,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        await activity.enqueueGoalRetryWake({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          workflowId,
        });
      }
      if (continuation.action === "continue" || continuation.action === "queue") continue;
      const seenWakeups = wakeups;
      const seenApprovalWakeups = approvalWakeups;
      const seenInterruptionWakeups = interruptionWakeups;
      const woke = await condition(
        () =>
          interruptionWakeups !== seenInterruptionWakeups ||
          wakeups !== seenWakeups ||
          approvalWakeups !== seenApprovalWakeups,
        "5s",
      );
      if (woke) continue;
      const finalPeek = await activity.peekSessionWork({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      });
      if (finalPeek.kind !== "idle") continue;
      await activity.markSessionIdle({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      });
      if (signalVersion !== closeSignalVersion) {
        continue;
      }
      return;
    }
    turnsThisRun += 1;
    const trigger =
      peek.kind === "approval-pending"
        ? ({ kind: "approval", triggerEventId: peek.triggerEventId } as const)
        : ({ kind: "next" } as const);
    if (!(await runTurn(input.accountId, input.workspaceId, input.sessionId, trigger))) {
      if (signalVersion !== closeSignalVersion) continue;
      return;
    }
  }

  async function runTurn(
    accountId: string,
    workspaceId: string,
    sessionId: string,
    trigger: activities.RunAgentTurnInput["trigger"],
  ): Promise<boolean> {
    const capacityWaitEntryBaseline = { wakeups, capacityWakeups };
    const attemptId = uuid4();
    const interruptionBaseline = interruptionWakeups;

    const scope = new CancellationScope();
    const workflowExecution = workflowInfo();
    const workflowId = workflowExecution.workflowId;
    // The stateless resume-by-id model (lease acquire + non-owned injection +
    // release) lives entirely in the runAgentTurn activity.
    const turn: Promise<activities.RunAgentTurnResult> = scope.run(() =>
      turnActivity.runAgentTurn({
        accountId,
        workspaceId,
        sessionId,
        workflowId,
        workflowRunId: workflowExecution.runId,
        attemptId,
        trigger,
      }),
    );
    const racedOutcome:
      | { kind: "result"; result: activities.RunAgentTurnResult }
      | { kind: "control" }
      | { kind: "failure"; error: unknown } = await Promise.race([
      turn.then(
        (result: activities.RunAgentTurnResult) => ({
          kind: "result" as const,
          result,
        }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      ),
      condition(() => interruptionWakeups !== interruptionBaseline).then(() => ({
        kind: "control" as const,
      })),
    ]);
    // A Steer/Pause transaction fences the active attempt before its Temporal
    // signal is necessarily handled. That fence can make the activity's typed
    // cancellation win Promise.race by one workflow activation. Give only that
    // confirmed cancellation shape a short deterministic arbitration window;
    // the durable control signal is authoritative once observed. Ordinary
    // failures and timeouts never wait here, and a cancellation with no session
    // control still follows the failure/cancellation path below.
    if (
      racedOutcome.kind === "failure" &&
      isTurnActivityFenceCancellation(racedOutcome.error) &&
      interruptionWakeups === interruptionBaseline
    ) {
      await condition(() => interruptionWakeups !== interruptionBaseline, "250ms");
    }
    const outcome =
      interruptionWakeups !== interruptionBaseline ? ({ kind: "control" } as const) : racedOutcome;

    if (outcome.kind === "control") {
      if (!receiptGatedCancellation) {
        // Replay-only v1 command order. New histories always take the v2 path
        // below. The current runAgentTurn still owns and writes the truthful
        // hard-fence receipt; this call remains an idempotent history command.
        scope.cancel();
        const settlement = await activity.settleSessionInterruptions({
          accountId,
          workspaceId,
          sessionId,
          attemptId,
          workflowId: workflowInfo().workflowId,
        });
        const termination = await turn.then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const physicalStopConfirmed =
          termination.kind === "completed" || isTurnActivityFenceCancellation(termination.error);
        if (patched("session-attempt-quiescence-v1") && physicalStopConfirmed) {
          await activity.settleSessionInterruptions({
            accountId,
            workspaceId,
            sessionId,
            attemptId,
            workflowId: workflowInfo().workflowId,
            phase: "attempt_quiesced",
          });
        }
        if (!physicalStopConfirmed) throw termination.error;
        return settlement.action !== "paused";
      }
      const settlement = await activity.settleSessionInterruptions({
        accountId,
        workspaceId,
        sessionId,
        attemptId,
        workflowId: workflowInfo().workflowId,
      });
      // The transaction above is the authority fence: every late model/tool/UI
      // write is rejected from this point onward. Request cancellation only
      // after it commits, then stop observing the Temporal activity promise.
      // TRY_CANCEL allows this workflow to move to cancellation-wait without
      // confusing Temporal completion/cancellation with local process safety.
      scope.cancel();
      return settlement.action !== "paused";
    }

    if (outcome.kind === "failure") {
      // A capacity settlement may have committed just before the activity
      // transport/worker failed. Recover that durable boundary before generic
      // failSession can overwrite the capacity-idle session.
      {
        const capacityWait = await activity.getCodexCapacityWait({
          workspaceId,
          sessionId,
        });
        if (capacityWait) {
          await waitForCodexCapacity(capacityWait, capacityWaitEntryBaseline);
          return true;
        }
      }
      // An ungraceful worker death never reaches the activity's graceful
      // recovery path — it surfaces here as a heartbeat-timeout failure.
      // Conversation truth was still dual-written during the turn, so the
      // same turn is marked recovering and the loop re-claims it on a healthy worker —
      // bounded by a per-turn redispatch counter persisted on the turn row.
      const workerDeath = workerDeathFailure(outcome.error);
      if (workerDeath) {
        const recovery = await activity.recoverDispatch({
          accountId,
          workspaceId,
          sessionId,
          attemptId,
          timeoutType: workerDeath.timeoutType,
        });
        if (recovery.action !== "exceeded") {
          // "recovering": the next claim creates a new attempt for this same
          // current inference. "stale": the
          // timed-out attempt actually settled the turn (a zombie finished
          // after the server gave up on its heartbeats); nothing to redo.
          return true;
        }
        // The worker-death activity atomically committed failed turn/session
        // truth when the bounded redispatch ceiling was exceeded.
        return false;
      }
      await activity.failSessionAttempt({
        accountId,
        workspaceId,
        sessionId,
        attemptId,
        error: workflowFailureMessage(outcome.error),
      });
      return false;
    }

    if (outcome.result.status === "unclaimed") {
      return true;
    }

    if (outcome.result.status === "failed" || outcome.result.status === "cancelled") {
      return outcome.result.status === "cancelled";
    }

    if (outcome.result.capacityWait) {
      await waitForCodexCapacity(outcome.result.capacityWait, capacityWaitEntryBaseline);
      return true;
    }

    if (outcome.result.deferredUntilWake) {
      return deferredResultMayContinue(capacityWaitEntryBaseline.wakeups, wakeups);
    }

    if (outcome.result.status === "requires_action") return true;

    const holdMs = continuationHoldMs(outcome.result, ROTATION_IDLE_FLOOR_MS);
    if (holdMs > 0) {
      // Provider recovery / rotation all-capped idle: hold the loop so the same
      // turn or an active goal does not immediately re-enter the same rate-limit window.
      // A rotation all-capped idle is a MANDATORY hold (idleUntilReset) — a 0/elapsed
      // delay can never skip it (invariant 4: NO THRASH). A control or user signal
      // ends the wait early and is handled by the main loop.
      const seenWakeups = wakeups;
      const seenInterruptionWakeups = interruptionWakeups;
      await condition(
        () => interruptionWakeups !== seenInterruptionWakeups || wakeups !== seenWakeups,
        holdMs,
      );
    }
    return true;
  }
}

function isSessionAttemptQuiescenceProof(
  value: unknown,
): value is activities.SessionAttemptQuiescenceProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Record<string, unknown>;
  return [
    "accountId",
    "workspaceId",
    "sessionId",
    "attemptId",
    "workflowId",
    "workflowRunId",
    "activityId",
  ].every((field) => typeof proof[field] === "string" && proof[field].length > 0);
}

function sessionAttemptQuiescenceProofKey(proof: activities.SessionAttemptQuiescenceProof): string {
  return `${proof.attemptId}:${proof.workflowRunId}:${proof.activityId}`;
}
