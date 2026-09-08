import type { Session } from "@/types";

/** Archive order is personal filing time, never activity or running status. */
export function compareSessionArchiveOrder(a: Session, b: Session): number {
  const timeA = a.archivedAt ? Date.parse(a.archivedAt) : 0;
  const timeB = b.archivedAt ? Date.parse(b.archivedAt) : 0;
  return timeB - timeA || b.id.localeCompare(a.id);
}

export type SessionPageIdentity = {
  key: string;
  generation: number;
};

export type SessionContinuationState = {
  generation: number;
  sessions: Session[];
  nextCursor: string | null | undefined;
  failed: boolean;
  /** Page-one read revision whose snapshot produced the retained cursor chain. */
  snapshotRevision: number;
  /** Shared causal generation captured when that snapshot's page-one read started. */
  snapshotGeneration: number;
  /** Root-hook snapshots and direct cursor-rebase snapshots have independent identities. */
  source: "root" | "rebase" | "group";
  /** Rows fetched from that snapshot, excluding display-only rows retained from older snapshots. */
  authoritativeIds: ReadonlySet<string>;
  /** Actual request-start generation for each accepted continuation row's live channel fields. */
  channelGenerations: ReadonlyMap<string, number>;
};

export type SessionContinuationChannelEvidence = readonly [
  session: Session,
  readGeneration: number,
];

/**
 * Apply the exact archive mutation fields without allowing its full response
 * object to overwrite unrelated list projections that may have advanced while
 * the request was in flight.
 */
export function applySessionArchiveProjection(current: Session, updated: Session): Session {
  if ((current.archiveVersion ?? 0) > (updated.archiveVersion ?? 0)) return current;
  return {
    ...current,
    archived: updated.archived,
    archivedAt: updated.archivedAt,
    archiveVersion: updated.archiveVersion,
    ...((current.pinVersion ?? 0) <= (updated.pinVersion ?? 0)
      ? {
          pinned: updated.pinned,
          pinnedAt: updated.pinnedAt,
          pinVersion: updated.pinVersion,
        }
      : {}),
    ...((current.attentionVersion ?? 0) <= (updated.attentionVersion ?? 0)
      ? {
          activelyWorking: updated.activelyWorking,
          attentionVersion: updated.attentionVersion,
        }
      : {}),
  };
}

/** Keep successful archive/restore writes authoritative over retained pages. */
export function projectSessionArchiveMembership(
  sessions: readonly Session[],
  overrides: ReadonlyMap<string, Session>,
  archived: boolean,
  workspaceId: string,
): Session[] {
  const rows = new Map(sessions.map((session) => [session.id, session]));
  for (const [id, override] of overrides) {
    if (override.workspaceId !== workspaceId) continue;
    const current = rows.get(id);
    rows.set(id, current ? applySessionArchiveProjection(current, override) : override);
  }
  return [...rows.values()].flatMap((session) => {
    // A cached descendant follows its root instead of becoming an orphan row.
    const root = rows.get(session.rootSessionId ?? session.id);
    if (Boolean(root?.archived ?? session.archived) !== archived) return [];
    return [
      root && root.id !== session.id
        ? { ...session, archived: root.archived, archivedAt: root.archivedAt }
        : session,
    ];
  });
}

export function sessionPageKey(workspaceId: string, search: string): string {
  return `${workspaceId}\u0000${search}`;
}

/**
 * Advance the request generation whenever the workspace/query changes. The
 * integer matters in addition to the key: a delayed request for A must still be
 * rejected after the user visits A → B → A while it is in flight.
 */
export function advanceSessionPageIdentity(
  current: SessionPageIdentity,
  key: string,
): SessionPageIdentity {
  return current.key === key ? current : { key, generation: current.generation + 1 };
}

export function emptySessionContinuation(generation: number): SessionContinuationState {
  return {
    generation,
    sessions: [],
    nextCursor: undefined,
    failed: false,
    snapshotRevision: 0,
    snapshotGeneration: 0,
    source: "root",
    authoritativeIds: new Set(),
    channelGenerations: new Map(),
  };
}

export function activeSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
): SessionContinuationState {
  return state.generation === activeGeneration ? state : emptySessionContinuation(activeGeneration);
}

/** Merge a continuation only when it belongs to the still-active query. */
export function mergeSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
  requestGeneration: number,
  page: { sessions: Session[]; nextCursor: string | null },
  snapshotRevision: number,
  snapshotGeneration = 0,
  source: "root" | "rebase" | "group" = "root",
  pageReadGeneration = snapshotGeneration,
): SessionContinuationState {
  if (requestGeneration !== activeGeneration) {
    return state;
  }
  const active = activeSessionContinuation(state, activeGeneration);
  const rows = new Map(active.sessions.map((session) => [session.id, session]));
  const authoritativeIds =
    active.source === source && active.snapshotRevision === snapshotRevision
      ? new Set(active.authoritativeIds)
      : new Set<string>();
  const channelGenerations =
    active.source === source && active.snapshotRevision === snapshotRevision
      ? new Map(active.channelGenerations)
      : new Map<string, number>();
  for (const session of page.sessions) rows.set(session.id, session);
  for (const session of page.sessions) {
    authoritativeIds.add(session.id);
    channelGenerations.set(session.id, pageReadGeneration);
  }
  return {
    generation: activeGeneration,
    sessions: [...rows.values()],
    nextCursor: page.nextCursor,
    failed: false,
    snapshotRevision,
    snapshotGeneration,
    source,
    authoritativeIds,
    channelGenerations,
  };
}

function continuationRowHasCurrentChannelAuthority(
  state: SessionContinuationState,
  readGeneration: number,
  currentReadRevision: number,
  currentReadGeneration: number,
): boolean {
  if (currentReadGeneration > 0) return readGeneration >= currentReadGeneration;
  return state.source === "root"
    ? state.snapshotRevision === currentReadRevision
    : state.snapshotGeneration >= currentReadGeneration;
}

/** Current continuation rows that may own channel filing, with each page's actual read start. */
export function authoritativeSessionContinuationChannels(
  state: SessionContinuationState,
  activeGeneration: number,
  currentReadRevision: number,
  currentReadGeneration = 0,
): SessionContinuationChannelEvidence[] {
  const active = activeSessionContinuation(state, activeGeneration);
  const byId = new Map(active.sessions.map((session) => [session.id, session]));
  const evidence: SessionContinuationChannelEvidence[] = [];
  for (const sessionId of active.authoritativeIds) {
    const session = byId.get(sessionId);
    const readGeneration = active.channelGenerations.get(sessionId) ?? active.snapshotGeneration;
    if (
      session &&
      continuationRowHasCurrentChannelAuthority(
        active,
        readGeneration,
        currentReadRevision,
        currentReadGeneration,
      )
    ) {
      evidence.push([session, readGeneration]);
    }
  }
  return evidence;
}

/** Current continuation rows that may still own mutable list projections. */
export function authoritativeSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
  currentReadRevision: number,
  currentReadGeneration = 0,
): Session[] {
  return authoritativeSessionContinuationChannels(
    state,
    activeGeneration,
    currentReadRevision,
    currentReadGeneration,
  ).map(([session]) => session);
}

/**
 * Persist a causally fresh detail channel onto a display-only retained row.
 * Current-snapshot list evidence remains authoritative and is never rewritten.
 */
export function reconcileRetainedSessionContinuationChannel(
  state: SessionContinuationState,
  activeGeneration: number,
  currentReadRevision: number,
  projected: Pick<Session, "id" | "workspaceId" | "channelId"> | null,
  currentReadGeneration = 0,
): SessionContinuationState {
  if (!projected || state.generation !== activeGeneration) return state;
  const rowReadGeneration = state.channelGenerations.get(projected.id) ?? state.snapshotGeneration;
  if (
    state.authoritativeIds.has(projected.id) &&
    continuationRowHasCurrentChannelAuthority(
      state,
      rowReadGeneration,
      currentReadRevision,
      currentReadGeneration,
    )
  ) {
    return state;
  }
  const index = state.sessions.findIndex(
    (session) => session.id === projected.id && session.workspaceId === projected.workspaceId,
  );
  if (index === -1) return state;
  const current = state.sessions[index]!;
  const channelId = projected.channelId ?? null;
  if ((current.channelId ?? null) === channelId) return state;
  const sessions = [...state.sessions];
  sessions[index] = { ...current, channelId };
  return { ...state, sessions };
}

/**
 * Rebase retained rows onto a fresh first-page snapshot after the server says
 * the previous cursor expired. Fresh rows replace retained duplicates and own
 * the new snapshot while older off-page rows remain display-only. Delayed
 * rebases are fenced like ordinary page merges so an A → B → A query
 * transition cannot revive an obsolete cursor.
 */
export function rebaseSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
  requestGeneration: number,
  page: { sessions: Session[]; nextCursor: string | null },
  snapshotRevision: number,
  snapshotGeneration = 0,
  source: "root" | "rebase" | "group" = "root",
): SessionContinuationState {
  if (requestGeneration !== activeGeneration) return state;
  const active = activeSessionContinuation(state, activeGeneration);
  const rows = new Map(active.sessions.map((session) => [session.id, session]));
  const authoritativeIds = new Set<string>();
  const channelGenerations = new Map<string, number>();
  for (const session of page.sessions) {
    rows.set(session.id, session);
    authoritativeIds.add(session.id);
    channelGenerations.set(session.id, snapshotGeneration);
  }
  return {
    ...active,
    sessions: [...rows.values()],
    nextCursor: page.nextCursor,
    failed: false,
    snapshotRevision,
    snapshotGeneration,
    source,
    authoritativeIds,
    channelGenerations,
  };
}
