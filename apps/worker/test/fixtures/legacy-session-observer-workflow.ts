import { patched, proxyActivities } from "@temporalio/workflow";

/** Frozen pre-safe-observer command path: admission-blocked first peek.
 * It deliberately has no session-safe-control-observation-v1 marker. */
export async function sessionWorkflow(input: { accountId: string; workspaceId: string; sessionId: string }) {
  patched("session-attempt-quiescence-v2");
  patched("session-attempt-writer-set-quiescence-v1");
  patched("session-quiescence-reconciliation-wake-v1");
  patched("session-control-stale-wake-v1");
  patched("session-unclaimed-attempt-recovery-v1");
  patched("session-cancelled-attempt-recovery-v1");
  const { peekSessionWork } = proxyActivities<{
    peekSessionWork(input: { workspaceId: string; sessionId: string; includeAdmissionFence?: boolean }): Promise<{ kind: "admission-blocked" }>;
  }>({ startToCloseTimeout: "2 minutes", retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "30 seconds" } });
  const includeAdmissionFence = patched("session-durable-admission-block-v1");
  await peekSessionWork({ workspaceId: input.workspaceId, sessionId: input.sessionId,
    ...(includeAdmissionFence ? { includeAdmissionFence: true } : {}),
  });
}