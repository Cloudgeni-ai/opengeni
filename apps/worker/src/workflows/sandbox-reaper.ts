// apps/worker/src/workflows/sandbox-reaper.ts — the ONE global reaper workflow.
//
// This is the action the single global reaper Temporal Schedule starts
// (registered in apps/worker/src/index.ts, gated on sandboxOwnershipEnabled). It
// runs on the global task queue — the SAME queue the worker pool listens on,
// because the worker carries the runtime needed to resume-by-id and terminate a
// provider box. There is NO per-session worker, NO per-session/per-group queue.
//
// The workflow is intentionally trivial: it delegates the whole sweep to the
// stateless `reapSandboxLeases` activity (the sweep is DB + provider IO that
// must run in an activity, not in workflow-deterministic code). The Schedule's
// SKIP overlap policy means a slow sweep never overlaps itself; the activity is
// idempotent regardless.

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS } from "../sandbox-reaper-contract";

// The activity must outlive the configured non-cancellable provider snapshot,
// its durable capture fence, and settlement cleanup. Worker startup enforces the
// shared contract before every control worker polls and again when the activity
// starts. SKIP overlap prevents a slow sweep from creating a competing owner.
const reaperActivity = proxyActivities<Pick<typeof activities, "reapSandboxLeases">>({
  startToCloseTimeout: SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
  retry: { maximumAttempts: 1 },
});

export async function sandboxReaperWorkflow(): Promise<void> {
  await reaperActivity.reapSandboxLeases();
}
