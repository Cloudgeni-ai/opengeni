export * from "../src/workflows";

import { TEST_ONLY_TURN_HEARTBEAT_TIMEOUT } from "../src/workflows/activities";
import { createSessionWorkflow } from "../src/workflows/session";

// Keep this entry under apps/worker: Temporal's generated Webpack entrypoint
// resolves @temporalio/workflow from the entry's workspace, and clean installs
// deliberately expose that direct dependency here rather than at the root.
// This module is loaded only by the real-Temporal integration test worker. It
// is deliberately not re-exported from apps/worker/src/workflows.ts, so the
// production worker cannot register or select this workflow.
export const sessionWorkflowWithAcceleratedHeartbeat = createSessionWorkflow({
  heartbeatTimeout: TEST_ONLY_TURN_HEARTBEAT_TIMEOUT,
});
