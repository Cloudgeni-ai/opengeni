/**
 * Process-local Temporal execution ceilings.
 *
 * Turn workers host only runAgentTurn, so this is the exact number of agent
 * turns one worker process may own concurrently. Keep the value centralized so
 * production and the real Temporal integration harness exercise one topology.
 */
export const TURN_WORKER_MAX_CONCURRENT_TURNS = 16;

export const CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES = 32;
export const CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS = 40;
