/** One global Temporal Schedule owns bounded delivery of committed session wakes. */
export const SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID =
  "opengeni-session-workflow-wake-dispatcher";
export const SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE =
  "sessionWorkflowWakeDispatcherWorkflow";
export const SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS = 10_000;

/**
 * Temporal delivers activity cancellation through heartbeats. Keep both the
 * activity's local heartbeat timer and the worker's SDK throttle at this bound
 * so the end-to-end Pause/Steer physical-cancellation contract is not already
 * exhausted before sandbox/tool quiescence and replacement admission begin.
 */
export const TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS = 500;
