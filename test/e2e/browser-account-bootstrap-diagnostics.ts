type ReadEvidence = {
  sequence: number;
  receivedAt: number;
  dispatchedAt: number | null;
  settledAt: number | null;
  outcome: "pending" | "resolved" | "rejected";
  status: number | null;
};

/** Observe finite bootstrap reads without retaining headers, bodies, or authority. */
export function createAccountBootstrapDiagnostics() {
  const pending = new Map<object, ReadEvidence>();
  const completed: ReadEvidence[] = [];
  let receivedCount = 0;
  let discardedCompletedCount = 0;
  return {
    receive(request: object, method: string, pathname: string) {
      if (method !== "GET" || pathname !== "/v1/auth/session-set") return;
      pending.set(request, {
        sequence: ++receivedCount,
        receivedAt: performance.now(),
        dispatchedAt: null,
        settledAt: null,
        outcome: "pending",
        status: null,
      });
    },
    dispatch(request: object) {
      const read = pending.get(request);
      if (read) read.dispatchedAt = performance.now();
    },
    settle(request: object, outcome: "resolved" | "rejected", status: number | null) {
      const read = pending.get(request);
      if (!read) return;
      pending.delete(request);
      completed.push({ ...read, settledAt: performance.now(), outcome, status });
      if (completed.length > 128) {
        completed.shift();
        discardedCompletedCount += 1;
      }
    },
    snapshot() {
      return {
        receivedCount,
        discardedCompletedCount,
        pending: [...pending.values()].map((read) => ({ ...read })),
        completed: completed.map((read) => ({ ...read })),
      };
    },
  };
}
