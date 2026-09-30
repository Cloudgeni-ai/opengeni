import { useRef } from "react";

/**
 * Runs one task at a time; a task scheduled while another runs replaces any
 * task still waiting, so only the newest request starts next. Editors use it
 * for projection loads: replaying a long history emits one revision per
 * committed transaction, and composing a projection for each of them at once
 * would overrun the artifact Worker's bounded request queue.
 */
export function createLatestTaskRunner(): (task: () => Promise<void>) => void {
  let running = false;
  let waiting: (() => Promise<void>) | null = null;
  const drain = async () => {
    running = true;
    try {
      while (waiting) {
        const task = waiting;
        waiting = null;
        try {
          await task();
        } catch {
          // Tasks settle their own errors; one failure must not stall the next.
        }
      }
    } finally {
      running = false;
    }
  };
  return (task) => {
    waiting = task;
    if (!running) void drain();
  };
}

/**
 * One runner per artifact session. A composition still pending on a replaced
 * session (for example one whose Worker stopped answering) must never hold up
 * the next session's first load, so the runner is scoped to the session object
 * rather than to the component.
 */
export function useLatestTaskRunner(session: object): (task: () => Promise<void>) => void {
  const runner = useRef<{ session: object; schedule: (task: () => Promise<void>) => void } | null>(
    null,
  );
  if (runner.current?.session !== session) {
    runner.current = { session, schedule: createLatestTaskRunner() };
  }
  return runner.current.schedule;
}
