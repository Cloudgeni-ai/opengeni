import {
  ActivityFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  setHandler,
  TimeoutFailure,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import { activity, workflowFailureMessage } from "./activities";

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
  result: { status: string; continueDelayMs?: number; idleUntilReset?: boolean },
  floorMs: number,
): number {
  if (result.status !== "idle") {
    return 0;
  }
  const delay = result.continueDelayMs ?? 0;
  if (result.idleUntilReset) {
    return Math.max(delay, floorMs);
  }
  return Math.max(delay, 0);
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
): { dispatchId: string; timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START" } | null {
  if (!(error instanceof ActivityFailure)) {
    return null;
  }
  const cause = error.cause;
  if (
    !(cause instanceof TimeoutFailure) ||
    (cause.timeoutType !== "HEARTBEAT" && cause.timeoutType !== "SCHEDULE_TO_START") ||
    !error.activityId
  ) {
    return null;
  }
  return { dispatchId: error.activityId, timeoutType: cause.timeoutType };
}

export const userMessage = defineSignal<[string]>("userMessage");
export const queueChanged = defineSignal("queueChanged");
export const approvalDecision = defineSignal<[string]>("approvalDecision");
export const sessionControl = defineSignal<[string]>("sessionControl");
export const codexCapacityChanged = defineSignal<[number]>("codexCapacityChanged");

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
  const approvalQueue: string[] = [];
  let controlEventId: string | null = null;
  let wakeups = 0;
  let capacityWakeups = 0;
  // Turns dispatched on THIS run (reset to 0 by continueAsNew). The backstop
  // for the history-overflow guard below; bounded growth is what makes a
  // weeks-long session survivable.
  let turnsThisRun = 0;
  let capacityChecksThisRun = 0;

  setHandler(userMessage, () => {
    wakeups += 1;
  });
  setHandler(queueChanged, () => {
    wakeups += 1;
  });
  setHandler(approvalDecision, (eventId) => {
    approvalQueue.push(eventId);
  });
  setHandler(sessionControl, (eventId) => {
    controlEventId = eventId;
  });
  setHandler(codexCapacityChanged, () => {
    capacityWakeups += 1;
  });

  async function waitForCodexCapacity(
    initial: activities.CodexCapacityWaitRef,
    entryBaseline?: { wakeups: number; capacityWakeups: number },
  ): Promise<void> {
    let current = initial;
    let firstEntryBaseline = entryBaseline;
    for (;;) {
      if (controlEventId !== null) {
        return;
      }
      // Signals can land after the waiter commit but before runAgentTurn returns.
      // Compare the first wait against pre-dispatch counters so they cannot be
      // baselined away; later iterations use their normal local snapshot.
      const seenWakeups = firstEntryBaseline?.wakeups ?? wakeups;
      const seenCapacityWakeups = firstEntryBaseline?.capacityWakeups ?? capacityWakeups;
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
            controlEventId !== null ||
            wakeups !== seenWakeups ||
            capacityWakeups !== seenCapacityWakeups,
          timerMs,
        );
        if (controlEventId !== null) {
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
      if (
        controlEventId === null &&
        (workflowInfo().continueAsNewSuggested || capacityChecksThisRun >= capacityCheckBackstop)
      ) {
        // The waiter/outbox is durable in Postgres. A fresh workflow run reads
        // it before goal continuation, reconstructs its timer, and turns any
        // unobserved wake revision into an immediate evaluation.
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
    // History-overflow guard. The top of the loop is the only safe
    // continueAsNew boundary: no turn is mid-flight (every path that reaches a
    // new iteration settled or recovered its turn first), and a pending
    // control signal is unbacked in-memory state that the new run could not
    // reconstruct — so we refuse to continueAsNew while one is set and let the
    // loop handle it first. A buffered userMessage/queueChanged signal only
    // bumps `wakeups`, and its turn was written to Postgres BEFORE the signal
    // was sent, so the fresh run re-claims it on its first claimNextSessionExecution
    // — losing the counter strands nothing. The queue living in Postgres is the
    // safety net: continueAsNew carries only the self-contained
    // SessionWorkflowInput (no initialEventId — the new run claims from the
    // queue, it does not replay a seed event).
    //
    // The approval queue is NOT a boundary condition, and is cleared here. A
    // genuinely-pending approval keeps the workflow blocked INSIDE runTurn (the
    // `await condition(...)` in the requires_action branch), so it never
    // reaches the top of the loop — meaning every approvalQueue entry observed
    // here is necessarily STALE (an approvalDecision signal for a turn that
    // already settled; the API guard only checks status==='requires_action', so
    // two decisions submitted while requires_action both land in the queue and
    // the surplus is left behind once the turn completes without re-blocking).
    // Coupling continueAsNew to `approvalQueue.length === 0` would let one such
    // stale entry wedge the guard forever, re-introducing the exact
    // history-overflow termination this branch prevents. Dropping the surplus
    // is safe: a real pending approval also leaves the session in
    // requires_action with the turn re-dispatchable from Postgres.
    {
      const info = workflowInfo();
      const maxTurnsPerRun = input.maxTurnsPerRun ?? TURNS_PER_RUN_BACKSTOP;
      const shouldContinue = info.continueAsNewSuggested || turnsThisRun >= maxTurnsPerRun;
      if (shouldContinue && controlEventId === null) {
        approvalQueue.length = 0;
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
    const workflowId = workflowInfo().workflowId;
    const turn = await activity.claimNextSessionExecution({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      workflowId,
    });
    if (!turn) {
      // A durable Codex capacity waiter replaces the generic goal continuation
      // loop. This read also repairs the DB-commit -> activity-return boundary:
      // if runAgentTurn committed the waiter and then its worker died, the fresh
      // workflow reconstructs the timer here instead of synthesizing work.
      if (controlEventId === null) {
        const capacityWait = await activity.getCodexCapacityWait({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        });
        if (capacityWait) {
          await waitForCodexCapacity(capacityWait);
          continue;
        }
      }
      if (controlEventId === null) {
        // With an active goal, idling out is replaced by a synthesized
        // continuation turn; the queue (any non-terminal turn) always wins and
        // the no-progress/max-continuation guards auto-pause runaway goals.
        let continuation: activities.MaybeContinueGoalResult = { action: "none" };
        try {
          continuation = await activity.maybeContinueGoal({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            workflowId,
          });
        } catch (error) {
          if (isCancellation(error)) {
            throw error;
          }
          // A failing goal check must not kill the session (activity retry is
          // 1). Fall through to the idle path: the goal stays active in the
          // database and the next wake retries, which means the workflow CAN
          // complete normally with an active goal on this error path.
        }
        if (continuation.action === "continue" || continuation.action === "queue") {
          // "continue": a goal continuation turn was just enqueued; "queue":
          // queued work appeared concurrently. Claim it on the next loop pass.
          continue;
        }
      }
      const seenWakeups = wakeups;
      const woke = await condition(() => controlEventId !== null || wakeups !== seenWakeups, "5s");
      if (controlEventId) {
        const idleControlEventId = controlEventId;
        controlEventId = null;
        await activity.settleSessionControl({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          triggerEventId: idleControlEventId,
          workflowId,
        });
        return;
      }
      if (woke) {
        continue;
      }
      const finalTurn = await activity.claimNextSessionExecution({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        workflowId,
      });
      if (!finalTurn) {
        await activity.markSessionIdle({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        });
        // A queueChanged/userMessage signal can land between the final claim and
        // completion; Temporal blocks completion while a signal is buffered, so
        // re-checking here guarantees the queued turn is picked up instead of
        // stranding it (the signaler skips its start-child fallback on success).
        if (controlEventId !== null || wakeups !== seenWakeups) {
          continue;
        }
        return;
      }
      turnsThisRun += 1;
      if (
        !(await runTurn(
          input.accountId,
          input.workspaceId,
          input.sessionId,
          finalTurn.id,
          finalTurn.triggerEventId,
        ))
      ) {
        return;
      }
      continue;
    }
    turnsThisRun += 1;
    if (
      !(await runTurn(
        input.accountId,
        input.workspaceId,
        input.sessionId,
        turn.id,
        turn.triggerEventId,
      ))
    ) {
      return;
    }
  }

  async function runTurn(
    accountId: string,
    workspaceId: string,
    sessionId: string,
    turnId: string,
    triggerEventId: string,
  ): Promise<boolean> {
    if (controlEventId) {
      await activity.settleSessionControl({
        accountId,
        workspaceId,
        sessionId,
        triggerEventId: controlEventId,
        workflowId: workflowInfo().workflowId,
      });
      controlEventId = null;
      return true;
    }

    const capacityWaitEntryBaseline = { wakeups, capacityWakeups };
    const attemptId = uuid4();

    const scope = new CancellationScope();
    const workflowId = workflowInfo().workflowId;
    // The stateless resume-by-id model (lease acquire + non-owned injection +
    // release) lives entirely in the runAgentTurn activity.
    const turn: Promise<activities.RunAgentTurnResult> = scope.run(() =>
      activity.runAgentTurn({
        accountId,
        workspaceId,
        sessionId,
        triggerEventId,
        workflowId,
        turnId,
        attemptId,
      }),
    );
    const outcome:
      | { kind: "result"; result: activities.RunAgentTurnResult }
      | { kind: "control" }
      | { kind: "failure"; error: unknown } = await Promise.race([
      turn.then(
        (result: activities.RunAgentTurnResult) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      ),
      condition(() => controlEventId !== null).then(() => ({ kind: "control" as const })),
    ]);

    if (outcome.kind === "control") {
      scope.cancel();
      await activity.settleSessionControl({
        accountId,
        workspaceId,
        sessionId,
        triggerEventId: controlEventId!,
        workflowId: workflowInfo().workflowId,
      });
      controlEventId = null;
      return true;
    }

    if (outcome.kind === "failure") {
      // A capacity settlement may have committed just before the activity
      // transport/worker failed. Recover that durable boundary before generic
      // failSession can overwrite the capacity-idle session.
      {
        const capacityWait = await activity.getCodexCapacityWait({ workspaceId, sessionId });
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
        const recovery = await activity.recoverTurnAfterWorkerDeath({
          accountId,
          workspaceId,
          sessionId,
          triggerEventId,
          workflowId,
          turnId,
          attemptId,
          dispatchId: workerDeath.dispatchId,
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
      await activity.failSession({
        accountId,
        workspaceId,
        sessionId,
        triggerEventId,
        workflowId,
        turnId,
        attemptId,
        error: workflowFailureMessage(outcome.error),
      });
      return false;
    }

    if (outcome.result.status === "failed" || outcome.result.status === "cancelled") {
      return outcome.result.status === "cancelled";
    }

    if (outcome.result.status === "recovering") {
      return true;
    }

    if (outcome.result.capacityWait) {
      await waitForCodexCapacity(outcome.result.capacityWait, capacityWaitEntryBaseline);
      return true;
    }

    if (outcome.result.deferredUntilWake) {
      return wakeups !== capacityWaitEntryBaseline.wakeups;
    }

    if (outcome.result.status === "requires_action") {
      await condition(() => controlEventId !== null || approvalQueue.length > 0);
      if (controlEventId) {
        await activity.settleSessionControl({
          accountId,
          workspaceId,
          sessionId,
          triggerEventId: controlEventId,
          workflowId,
        });
        controlEventId = null;
        return true;
      }
      const approvalEventId = approvalQueue.shift();
      if (approvalEventId) {
        return await runTurn(accountId, workspaceId, sessionId, turnId, approvalEventId);
      }
    }

    const holdMs = continuationHoldMs(outcome.result, ROTATION_IDLE_FLOOR_MS);
    if (holdMs > 0) {
      // Provider backpressure / rotation all-capped idle: hold the loop so an active
      // goal's continuation does not immediately re-enter the same rate-limit window.
      // A rotation all-capped idle is a MANDATORY hold (idleUntilReset) — a 0/elapsed
      // delay can never skip it (invariant 4: NO THRASH). A control or user signal
      // ends the wait early and is handled by the main loop.
      const seenWakeups = wakeups;
      await condition(() => controlEventId !== null || wakeups !== seenWakeups, holdMs);
    }
    return true;
  }
}
