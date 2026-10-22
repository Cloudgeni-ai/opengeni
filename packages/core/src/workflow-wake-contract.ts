/**
 * Legacy id of the Temporal Schedule that used to start the dispatcher every
 * period whether or not anything was due. Current control workers delete it at
 * startup; older releases recreate it, so a rollback keeps its repair cadence.
 */
export const SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID =
  "opengeni-session-workflow-wake-dispatcher";
export const SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE =
  "sessionWorkflowWakeDispatcherWorkflow";
/**
 * The single dispatcher execution. Immediate triggers and the control
 * worker's repair cadence signal-with-start this id, so a request that lands
 * while a sweep is running buffers exactly one more sweep instead of starting
 * a second execution.
 */
export const SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_ID =
  "opengeni-session-workflow-wake-dispatcher";
export const SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL = "dispatchRequested";
export const SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS = 10_000;

/**
 * Temporal delivers activity cancellation through heartbeats. Keep both the
 * activity's local heartbeat timer and the worker's SDK throttle at this bound
 * so the end-to-end Pause/Steer physical-cancellation contract is not already
 * exhausted before sandbox/tool quiescence and replacement admission begin.
 */
export const TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS = 500;
