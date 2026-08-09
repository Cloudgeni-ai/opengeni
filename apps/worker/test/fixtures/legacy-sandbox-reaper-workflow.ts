import { proxyActivities } from "@temporalio/workflow";

// Exact schedule-workflow command emitted before the split reaper rollout.
// Keep this fixture frozen: it proves both forward replay and rollback replay.
const activities = proxyActivities<{ reapSandboxLeases(): Promise<unknown> }>({
  startToCloseTimeout: 65 * 60_000,
  retry: { maximumAttempts: 1 },
});

export async function sandboxReaperWorkflow(): Promise<void> {
  await activities.reapSandboxLeases();
}
