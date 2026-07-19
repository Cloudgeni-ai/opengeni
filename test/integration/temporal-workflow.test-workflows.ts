export * from "../../apps/worker/src/workflows";

import { TEST_ONLY_TURN_HEARTBEAT_TIMEOUT } from "../../apps/worker/src/workflows/activities";
import { createSessionWorkflow } from "../../apps/worker/src/workflows/session";

// This module is loaded only by the real-Temporal integration test worker. It
// is deliberately not re-exported from apps/worker/src/workflows.ts, so the
// production worker cannot register or select this workflow.
export const sessionWorkflowWithAcceleratedHeartbeat = createSessionWorkflow({
  heartbeatTimeout: TEST_ONLY_TURN_HEARTBEAT_TIMEOUT,
});
