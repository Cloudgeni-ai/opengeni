import type { SessionListChangeSource } from "@opengeni/db";

export type SessionListHint = {
  type: "workspace.sessions.changed";
  workspaceId: string;
  available: boolean;
  /** null means reconcile all loaded scopes, including formerly visible rows. */
  sessionIds: string[] | null;
  /**
   * The viewer's changed Site conversations, which ordinary lists omit. Only
   * a surface that shows them (the rail's Site rows) needs to act on these.
   */
  siteSessionIds?: string[];
};

/** Authorized hint IDs; a plain array has no Site conversations. */
export type SessionListHintIds = string[] | { sessionIds: string[]; siteSessionIds: string[] };

/** Transient commit hints; only the subsequent authorized list read is truth. */
export function subscribeSessionListHints(options: {
  source: SessionListChangeSource;
  workspaceId: string;
  subjectId: string;
  authorizeIds: (ids: string[]) => Promise<SessionListHintIds>;
  write: (hint: SessionListHint) => Promise<unknown>;
  fail: (error: unknown) => void;
  intervalMs: number;
}): () => void {
  let stopped = false;
  let connected = false;
  let generation = 0;
  let all = false;
  let flushing = false;
  let flushPending = false;
  const ids = new Set<string>();
  let tail = Promise.resolve();
  const emit = (available: boolean, sessionIds: string[] | null, siteSessionIds: string[] = []) =>
    options.write({
      type: "workspace.sessions.changed",
      workspaceId: options.workspaceId,
      available,
      sessionIds,
      ...(siteSessionIds.length ? { siteSessionIds } : {}),
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
      flushPending = false;
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
    // The existing reconcile-all hint replaces an oversized transient ID set;
    // it never exposes IDs whose authorization has not been checked.
    all ||= change.all || (ids.size >= 512 && !!change.sessionId && !ids.has(change.sessionId));
    if (all) ids.clear();
    else if (change.sessionId) ids.add(change.sessionId);
  });
  const flush = () => {
    if (stopped || !connected || (!all && !ids.size)) return;
    if (flushing) {
      flushPending = true;
      return;
    }
    flushPending = false;
    flushing = true;
    const observedGeneration = generation;
    const reconcileAll = all;
    const pendingIds = [...ids];
    all = false;
    ids.clear();
    enqueue(async () => {
      try {
        if (observedGeneration !== generation || !connected) return;
        const authorized = reconcileAll ? null : await options.authorizeIds(pendingIds);
        if (stopped || observedGeneration !== generation || !connected) return;
        if (authorized === null) return await emit(true, null);
        const visible = Array.isArray(authorized)
          ? { sessionIds: authorized, siteSessionIds: [] }
          : authorized;
        if (!visible.sessionIds.length && !visible.siteSessionIds.length) return;
        await emit(true, visible.sessionIds, visible.siteSessionIds);
      } finally {
        flushing = false;
        // Keep the normal cadence for fast reads. Only a timer tick that was
        // blocked by I/O requests an immediate coalesced follow-up.
        if (flushPending) flush();
      }
    });
  };
  const timer = setInterval(flush, options.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    ids.clear();
  };
}
