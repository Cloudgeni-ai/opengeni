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
