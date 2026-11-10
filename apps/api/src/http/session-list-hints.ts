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

/**
 * The viewer's own drafts changed on another device: their composer drafts in
 * `sessionIds`, and their new-chat draft when `newSession` is true. Drafts are
 * private to their author, so only that author's streams receive this, and it
 * carries no content: the device reads its own draft again.
 */
export type DraftsChangedHint = {
  type: "workspace.drafts.changed";
  workspaceId: string;
  sessionIds: string[];
  newSession: boolean;
};

/** Authorized hint IDs; a plain array has no Site conversations. */
export type SessionListHintIds = string[] | { sessionIds: string[]; siteSessionIds: string[] };

/** Transient commit hints; only the subsequent authorized list read is truth. */
export function subscribeSessionListHints(options: {
  source: SessionListChangeSource;
  workspaceId: string;
  subjectId: string;
  authorizeIds: (ids: string[]) => Promise<SessionListHintIds>;
  write: (hint: SessionListHint | DraftsChangedHint) => Promise<unknown>;
  fail: (error: unknown) => void;
  intervalMs: number;
  /**
   * How soon a draft change reaches the author's other devices. Shorter than
   * the list cadence: until it arrives, another visible composer still shows
   * the older draft.
   */
  draftFlushDelayMs?: number;
}): () => void {
  let stopped = false;
  let connected = false;
  let generation = 0;
  let all = false;
  let flushing = false;
  let flushPending = false;
  const ids = new Set<string>();
  const draftIds = new Set<string>();
  let newSessionDraft = false;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
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
      draftIds.clear();
      newSessionDraft = false;
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
    if (change.draft) {
      // Only the author's own draft, never a colleague's.
      if (change.subjectId !== options.subjectId) return;
      if (change.sessionId === null) newSessionDraft = true;
      else if (draftIds.size < 512) draftIds.add(change.sessionId);
      draftTimer ??= setTimeout(() => {
        draftTimer = null;
        if (!stopped) flushDrafts();
      }, options.draftFlushDelayMs ?? DRAFT_HINT_FLUSH_DELAY_MS);
      return;
    }
    // The existing reconcile-all hint replaces an oversized transient ID set;
    // it never exposes IDs whose authorization has not been checked.
    all ||= change.all || (ids.size >= 512 && !!change.sessionId && !ids.has(change.sessionId));
    if (all) ids.clear();
    else if (change.sessionId) ids.add(change.sessionId);
  });
  const flushDrafts = () => {
    if (!draftIds.size && !newSessionDraft) return;
    const observedGeneration = generation;
    const pendingIds = [...draftIds];
    const newSession = newSessionDraft;
    draftIds.clear();
    newSessionDraft = false;
    enqueue(async () => {
      if (observedGeneration !== generation || !connected) return;
      // A chat the author can no longer open is not named, even to them.
      const authorized = pendingIds.length ? await options.authorizeIds(pendingIds) : [];
      if (stopped || observedGeneration !== generation || !connected) return;
      const sessionIds = Array.isArray(authorized)
        ? authorized
        : [...authorized.sessionIds, ...authorized.siteSessionIds];
      if (!sessionIds.length && !newSession) return;
      await options.write({
        type: "workspace.drafts.changed",
        workspaceId: options.workspaceId,
        sessionIds,
        newSession,
      });
    });
  };
  const flush = () => {
    flushDrafts();
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
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    unsubscribe();
    ids.clear();
    draftIds.clear();
  };
}

/** Coalesces a burst of autosaves into one hint without the list's cadence. */
export const DRAFT_HINT_FLUSH_DELAY_MS = 200;
