import type { SessionPaginationGroup } from "./session-group-pagination";
import type { RailSession } from "./session-list-entry";

export type SessionListDirtyScopes = {
  revision: number;
  all: number;
  branches: ReadonlyMap<string, number>;
  roots: ReadonlyMap<string, { revision: number; session: RailSession }>;
};

export function emptySessionListDirtyScopes(): SessionListDirtyScopes {
  return { revision: 0, all: 0, branches: new Map(), roots: new Map() };
}

/** Unknown/new rows and audience changes require discovery, not a guessed scope. */
export function invalidateSessionListScopes(
  current: SessionListDirtyScopes,
  sessionIds: readonly string[] | null,
  sessions: ReadonlyMap<string, RailSession>,
): SessionListDirtyScopes {
  const revision = current.revision + 1;
  const full = () => ({ revision, all: revision, branches: new Map(), roots: new Map() });
  if (sessionIds === null) return full();
  const branches = new Map(current.branches);
  const roots = new Map(current.roots);
  for (const id of sessionIds) {
    let session = sessions.get(id);
    if (!session) return full();
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(session.id)) return full();
      visited.add(session.id);
      branches.set(session.id, revision);
      if (!session.parentSessionId) {
        roots.set(session.id, { revision, session });
        break;
      }
      session = sessions.get(session.parentSessionId);
      if (!session) return full();
    }
  }
  return { revision, all: current.all, branches, roots };
}

export function sessionListGroupRevision(
  scopes: SessionListDirtyScopes,
  group: SessionPaginationGroup,
): number {
  let revision = scopes.all;
  for (const root of scopes.roots.values()) {
    // Channel/creator membership is stable within an ID-only hint. Moves send a
    // full reconciliation. Time/status buckets may gain OR lose a changed row.
    const matches =
      group.kind === "channel"
        ? (root.session.channelId ?? null) === group.channelId
        : group.kind === "creator"
          ? root.session.createdBy.kind === group.creator.kind &&
            root.session.createdBy.subjectId === group.creator.subjectId
          : true;
    if (matches) revision = Math.max(revision, root.revision);
  }
  return revision;
}
