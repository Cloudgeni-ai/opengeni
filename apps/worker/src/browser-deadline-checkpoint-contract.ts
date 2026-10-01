export const BROWSER_DEADLINE_CHECKPOINT_SWEEP_ID = "opengeni-browser-deadline-checkpoints-v1";
const QUEUE_SUFFIX = "-browser-checkpoint-v1";
export function browserDeadlineCheckpointTaskQueue(base: string): string {
  return base.endsWith(QUEUE_SUFFIX) ? base : `${base}${QUEUE_SUFFIX}`;
}
