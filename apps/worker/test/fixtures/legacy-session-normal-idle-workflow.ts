import { condition, defineSignal, patched, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";

// Frozen normal-idle command path immediately before
// session-normal-idle-no-grace-v1. This fixture RUNS on a real Temporal server;
// its unmodified histories are replayed by the production workflow. Do not add
// the new patch or import production activity proxies here. Only idle outcomes
// are supported: a non-idle result fails rather than inventing legacy commands.
const activity = proxyActivities<{
  peekSessionWork(input: Record<string, unknown>): Promise<{ kind: string }>;
  markSessionIdle(input: Record<string, unknown>): Promise<void>;
}>({
  startToCloseTimeout: "2 minutes",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "30 seconds" },
});
const goalActivity = proxyActivities<{
  maybeContinueGoal(input: Record<string, unknown>): Promise<{ action: string }>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "5 seconds", maximumAttempts: 3 },
});

export async function sessionWorkflow(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<void> {
  patched("session-attempt-quiescence-v2");
  patched("session-attempt-writer-set-quiescence-v1");
  patched("session-quiescence-reconciliation-wake-v1");
  patched("session-control-stale-wake-v1");
  patched("session-unclaimed-attempt-recovery-v1");
  patched("session-cancelled-attempt-recovery-v1");
  let wakeups = 0;
  let approvalWakeups = 0;
  let interruptionWakeups = 0;
  let signalVersion = 0;
  for (const name of ["userMessage", "queueChanged"]) {
    setHandler(defineSignal(name), () => { wakeups += 1; signalVersion += 1; });
  }
  setHandler(defineSignal("approvalDecision"), () => { approvalWakeups += 1; signalVersion += 1; });
  setHandler(defineSignal("sessionControl"), () => { interruptionWakeups += 1; signalVersion += 1; });
  for (;;) {
    const closeSignalVersion = signalVersion;
    const durableAdmissionBlocking = patched("session-durable-admission-block-v1");
    const safeObservation = patched("session-safe-control-observation-v1");
    const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId };
    const peek = await activity.peekSessionWork({
      ...scope,
      ...(durableAdmissionBlocking ? { includeAdmissionFence: true } : {}),
      ...(safeObservation ? { observerAccountId: input.accountId } : {}),
    });
    if (peek.kind !== "idle") throw new Error("legacy idle fixture requires idle work");
    const continuation = await goalActivity.maybeContinueGoal({
      accountId: input.accountId,
      ...scope,
      workflowId: workflowInfo().workflowId,
    });
    if (continuation.action !== "none") throw new Error("legacy idle fixture requires no goal");
    const seenWakeups = wakeups;
    const seenApprovalWakeups = approvalWakeups;
    const seenInterruptionWakeups = interruptionWakeups;
    const woke = await condition(
      () => interruptionWakeups !== seenInterruptionWakeups || wakeups !== seenWakeups || approvalWakeups !== seenApprovalWakeups,
      "5s",
    );
    if (woke) continue;
    const finalPeek = await activity.peekSessionWork({
      ...scope,
      ...(safeObservation ? { observerAccountId: input.accountId } : {}),
    });
    if (finalPeek.kind !== "idle") throw new Error("legacy idle fixture requires idle final peek");
    await activity.markSessionIdle(scope);
    if (signalVersion !== closeSignalVersion) continue;
    return;
  }
}