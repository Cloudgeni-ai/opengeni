import type { SessionListChangeSource } from "@opengeni/db";

export type SessionListHint = {
  type: "workspace.sessions.changed";
  workspaceId: string;
  available: boolean;
  /** null means reconcile all loaded scopes, including formerly visible rows. */
  sessionIds: string[] | null;
};

/** Transient commit hints; only the subsequent authorized list read is truth. */
export function subscribeSessionListHints(options: {
  source: SessionListChangeSource;
  workspaceId: string;
  subjectId: string;
  authorizeIds: (ids: string[]) => Promise<string[]>;
  write: (hint: SessionListHint) => Promise<unknown>;
  fail: (error: unknown) => void;
  intervalMs: number;
}): () => void {
  let stopped = false;
  let connected = false;
  let generation = 0;
  let all = false;
  const ids = new Set<string>();
  let tail = Promise.resolve();
  const emit = (available: boolean, sessionIds: string[] | null) =>
    options.write({
      type: "workspace.sessions.changed",
      workspaceId: options.workspaceId,
      available,
      sessionIds,
    });
  const enqueue = (action: () => Promise<unknown>) => {
    tail = tail
      .then(async () => {
        if (!stopped) await action();
      })
      .catch((error) => {
        if (!stopped) options.fail(error);
      });
  };
  const unsubscribe = options.source.subscribe((event) => {
    if (stopped) return;
    if (event.type !== "change") {
      connected = event.type === "connected";
      const available = connected;
      generation++;
      all = false;
      ids.clear();
      // LISTEN has committed: reconciliation now covers any missed history.
      // A disconnected source immediately restores the legacy polling path.
      enqueue(() => emit(available, null));
      return;
    }
    const change = event.change;
    if (
      !connected ||
      change.workspaceId !== options.workspaceId ||
      (change.subjectId !== null && change.subjectId !== options.subjectId)
    )
      return;
    all ||= change.all;
    if (all) ids.clear();
    else if (change.sessionId) ids.add(change.sessionId);
  });
  const timer = setInterval(() => {
    if (!connected || (!all && !ids.size)) return;
    const observedGeneration = generation;
    const reconcileAll = all;
    const pendingIds = [...ids];
    all = false;
    ids.clear();
    enqueue(async () => {
      if (observedGeneration !== generation || !connected) return;
      const visibleIds = reconcileAll ? null : await options.authorizeIds(pendingIds);
      if (observedGeneration !== generation || !connected) return;
      if (visibleIds !== null && !visibleIds.length) return;
      await emit(true, visibleIds);
    });
  }, options.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    ids.clear();
  };
}
