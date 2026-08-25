// Cross-tab invalidation for personal session pins. Postgres remains truth;
// this message carries only workspace/session ids and tells sibling tabs to
// re-read. Cross-device clients reconcile through the normal page refresh/poll.

import type { Session } from "@/types";

const SESSION_PIN_CHANNEL_PREFIX = "opengeni.session-pins";
const SESSION_PIN_STORAGE_PREFIX = "opengeni.session-pins.changed";
const ACCEPTED_SESSION_CHANNEL_READ_SOFT_LIMIT = 512;
const outboundChannels = new Map<string, BroadcastChannel>();

type SessionTreeStats = NonNullable<Session["treeStats"]>;
type SessionChannelProjection = Pick<Session, "id" | "workspaceId" | "channelId">;
type SessionChannelEvidence = {
  channelId: string | null;
  priority: number;
  readGeneration: number;
};
type SessionChannelRead = {
  channelId: string | null;
  present: boolean;
  readGeneration: number;
};
type SessionChannelAcceptedRead = SessionChannelProjection & {
  readGeneration: number;
};

function sessionChannelProjectionKey(projection: Pick<Session, "id" | "workspaceId">): string {
  return `${projection.workspaceId}\u0000${projection.id}`;
}

/**
 * Tracks exact list/point-read ownership of channel projections without
 * putting browser-only provenance onto the public Session contract.
 */
export class SessionChannelProjectionAuthority {
  private readonly projectionsByOwner = new Map<
    object,
    ReadonlyMap<string, SessionChannelEvidence>
  >();
  private readonly acceptedReads = new Map<string, SessionChannelRead>();
  private readonly acceptedReadListeners = new Set<
    (accepted: SessionChannelAcceptedRead) => void
  >();
  private nextReadGeneration = 0;

  readonly beginRead = (): number => ++this.nextReadGeneration;

  /** Reconcile component-owned optimistic state when a newer exact read wins. */
  subscribeToAcceptedReads(listener: (accepted: SessionChannelAcceptedRead) => void): () => void {
    this.acceptedReadListeners.add(listener);
    return () => this.acceptedReadListeners.delete(listener);
  }

  replace(
    owner: object,
    projections: readonly SessionChannelProjection[],
    priority = 0,
    readGeneration = 0,
  ): void {
    this.replaceEvidence(
      owner,
      projections.map((projection) => ({ projection, readGeneration })),
      priority,
    );
  }

  replaceEvidence(
    owner: object,
    evidence: readonly {
      projection: SessionChannelProjection;
      readGeneration: number;
    }[],
    priority = 0,
  ): void {
    if (evidence.length === 0) {
      this.clear(owner);
      return;
    }
    this.projectionsByOwner.set(
      owner,
      new Map(
        evidence.map(({ projection, readGeneration }) => [
          sessionChannelProjectionKey(projection),
          { channelId: projection.channelId ?? null, priority, readGeneration },
        ]),
      ),
    );
    this.compactAcceptedReads();
  }

  clear(owner: object): void {
    this.projectionsByOwner.delete(owner);
  }

  /** Drop browser-only evidence when its workspace principal/route fence is retired. */
  clearWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}\u0000`;
    for (const key of this.acceptedReads.keys()) {
      if (key.startsWith(prefix)) this.acceptedReads.delete(key);
    }
    for (const [owner, projections] of this.projectionsByOwner) {
      const retained = new Map([...projections].filter(([key]) => !key.startsWith(prefix)));
      if (retained.size === 0) this.projectionsByOwner.delete(owner);
      else if (retained.size !== projections.size) this.projectionsByOwner.set(owner, retained);
    }
  }

  /** Retain an accepted exact/detail read so older list requests cannot revive stale filing. */
  recordRead(projection: SessionChannelProjection, readGeneration: number): boolean {
    return this.recordReadObservation(projection, readGeneration, true);
  }

  /** Fence a not-found point read without treating absence as a channel projection. */
  recordMissing(
    projection: Pick<SessionChannelProjection, "id" | "workspaceId">,
    readGeneration: number,
  ): boolean {
    return this.recordReadObservation(projection, readGeneration, false);
  }

  private recordReadObservation(
    projection: Pick<SessionChannelProjection, "id" | "workspaceId"> &
      Partial<Pick<SessionChannelProjection, "channelId">>,
    readGeneration: number,
    present: boolean,
  ): boolean {
    if (readGeneration <= 0) return false;
    const key = sessionChannelProjectionKey(projection);
    if (this.highestReadGeneration(key) > readGeneration) return false;
    // Refresh iteration order when exact evidence for one session advances so
    // compaction considers genuinely older observations first.
    this.acceptedReads.delete(key);
    this.acceptedReads.set(key, {
      channelId: projection.channelId ?? null,
      present,
      readGeneration,
    });
    this.compactAcceptedReads();
    if (present) {
      const accepted = {
        id: projection.id,
        workspaceId: projection.workspaceId,
        channelId: projection.channelId ?? null,
        readGeneration,
      };
      for (const listener of this.acceptedReadListeners) listener(accepted);
    }
    return true;
  }

  /**
   * The limit is deliberately soft: an accepted read is the only fence that
   * can stop an older retained branch/page owner from reviving stale filing.
   * Compact only after every current owner for that session is at least as
   * new; otherwise retaining the winner is required for correctness. Workspace
   * transitions provide the hard lifecycle bound for unresolved evidence.
   */
  private compactAcceptedReads(): void {
    if (this.acceptedReads.size <= ACCEPTED_SESSION_CHANNEL_READ_SOFT_LIMIT) return;
    for (const [key, accepted] of this.acceptedReads) {
      const ownerEvidence = [...this.projectionsByOwner.values()]
        .map((projections) => projections.get(key))
        .filter((candidate): candidate is SessionChannelEvidence => candidate !== undefined);
      if (
        ownerEvidence.length === 0 ||
        ownerEvidence.some((candidate) => candidate.readGeneration < accepted.readGeneration)
      ) {
        continue;
      }
      this.acceptedReads.delete(key);
      if (this.acceptedReads.size <= ACCEPTED_SESSION_CHANNEL_READ_SOFT_LIMIT) return;
    }
  }

  private highestReadGeneration(key: string): number {
    let generation = this.acceptedReads.get(key)?.readGeneration ?? Number.NEGATIVE_INFINITY;
    for (const projections of this.projectionsByOwner.values()) {
      const candidate = projections.get(key);
      if (candidate) generation = Math.max(generation, candidate.readGeneration);
    }
    return generation;
  }

  project<T extends SessionChannelProjection>(projection: T, readGeneration: number): T {
    const accepted = this.acceptedReads.get(sessionChannelProjectionKey(projection));
    if (
      !accepted ||
      !accepted.present ||
      accepted.readGeneration <= readGeneration ||
      accepted.channelId === (projection.channelId ?? null)
    ) {
      return projection;
    }
    return { ...projection, channelId: accepted.channelId };
  }

  owns(projection: SessionChannelProjection | null): boolean {
    if (!projection) return false;
    const key = sessionChannelProjectionKey(projection);
    const channelId = projection.channelId ?? null;
    const accepted = this.acceptedReads.get(key);
    let highestPriority = accepted ? 0 : Number.NEGATIVE_INFINITY;
    let highestGeneration = accepted?.readGeneration ?? Number.NEGATIVE_INFINITY;
    let owned = accepted?.present === true && accepted.channelId === channelId;
    for (const projections of this.projectionsByOwner.values()) {
      const candidate = projections.get(key);
      if (!candidate || candidate.priority < highestPriority) continue;
      if (candidate.priority > highestPriority || candidate.readGeneration > highestGeneration) {
        highestPriority = candidate.priority;
        highestGeneration = candidate.readGeneration;
        owned = candidate.channelId === channelId;
      } else if (
        candidate.readGeneration === highestGeneration &&
        candidate.channelId === channelId
      ) {
        owned = true;
      }
    }
    return owned;
  }
}

type SessionPinChangeMessage = {
  type: "session-pin.changed";
  sessionId: string;
  messageId: string;
};

function channelName(workspaceId: string): string {
  return `${SESSION_PIN_CHANNEL_PREFIX}:${workspaceId}`;
}

function storageKey(workspaceId: string): string {
  return `${SESSION_PIN_STORAGE_PREFIX}:${workspaceId}`;
}

function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sessionPinChangeMessage(value: unknown): SessionPinChangeMessage | null {
  const message = value as Partial<SessionPinChangeMessage> | null;
  return message?.type === "session-pin.changed" &&
    typeof message.sessionId === "string" &&
    message.sessionId.length > 0 &&
    typeof message.messageId === "string" &&
    message.messageId.length > 0
    ? (message as SessionPinChangeMessage)
    : null;
}

function sameTreeStats(a: SessionTreeStats | undefined, b: SessionTreeStats | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.directChildren === b.directChildren &&
    a.totalDescendants === b.totalDescendants &&
    a.runningDescendants === b.runningDescendants &&
    a.queuedDescendants === b.queuedDescendants &&
    a.attentionDescendants === b.attentionDescendants &&
    a.pausedDescendants === b.pausedDescendants &&
    a.failedDescendants === b.failedDescendants &&
    (a.attentionSince ?? null) === (b.attentionSince ?? null) &&
    a.truncated === b.truncated
  );
}

/**
 * Merge only personal pin fields from a list/page projection into the open
 * route projection. Lifecycle and event-driven session fields remain owned by
 * the route/SSE reducer and cannot be regressed by a slower list poll.
 */
export function applySessionPinProjection(
  current: Session | null,
  projected: Pick<Session, "id" | "workspaceId" | "pinned" | "pinnedAt" | "pinVersion">,
): Session | null {
  if (!current || current.id !== projected.id || current.workspaceId !== projected.workspaceId) {
    return current;
  }
  const pinned = Boolean(projected.pinned);
  const pinnedAt = projected.pinnedAt ?? null;
  const pinVersion = projected.pinVersion ?? 0;
  // A page poll, mutation response, or legacy-replica response can finish
  // after a newer optimistic/authoritative projection is already visible.
  // Pin revisions are monotonic, so never let that older response undo the
  // newer header/list state. Equal revisions remain authoritative: they let a
  // server response replace the local optimistic timestamp for that revision.
  if (pinVersion < (current.pinVersion ?? 0)) {
    return current;
  }
  if (
    Boolean(current.pinned) === pinned &&
    (current.pinnedAt ?? null) === pinnedAt &&
    (current.pinVersion ?? 0) === pinVersion
  ) {
    return current;
  }
  return { ...current, pinned, pinnedAt, pinVersion };
}

/** Merge the list-owned project filing without replacing route/SSE content. */
export function applySessionChannelProjection(
  current: Session | null,
  projected: Pick<Session, "id" | "workspaceId" | "channelId">,
): Session | null {
  if (!current || current.id !== projected.id || current.workspaceId !== projected.workspaceId) {
    return current;
  }
  const channelId = projected.channelId ?? null;
  return (current.channelId ?? null) === channelId ? current : { ...current, channelId };
}

/**
 * Merge a detail/SSE projection into the root context without allowing a
 * slower detail read to erase newer list-owned pin or project projections.
 * Detail remains authoritative for route-owned fields; the current context
 * contributes personal pin fields and the project filing.
 */
export function mergeSessionContextProjection(
  current: Session | null,
  projected: Session | null,
  channelAuthority: SessionChannelProjectionAuthority,
  source: "detail" | "live",
): Session | null {
  if (!projected) {
    return null;
  }
  const pinned = applySessionPinProjection(projected, current ?? projected) ?? projected;
  return source === "live" || channelAuthority.owns(current)
    ? (applySessionChannelProjection(pinned, current ?? projected) ?? pinned)
    : pinned;
}

/**
 * Merge list-owned personal pin and hierarchy fields into route-owned session
 * content. A route/SSE object must never overwrite a newer cross-device unpin,
 * while a list poll must never regress lifecycle state or message content.
 */
export function applySessionRailProjection(
  current: Session,
  projected: Session,
  options: { channelOwned?: boolean } = {},
): Session {
  const pinned = applySessionPinProjection(current, projected) ?? current;
  const merged =
    options.channelOwned === false
      ? pinned
      : (applySessionChannelProjection(pinned, projected) ?? pinned);
  if (sameTreeStats(merged.treeStats, projected.treeStats)) {
    return merged;
  }
  return projected.treeStats ? { ...merged, treeStats: projected.treeStats } : merged;
}

/**
 * Reconcile the point read performed after a failed pin request.
 *
 * An optimistic first pin projects version 1 before the server responds. If the
 * request fails before commit, the authoritative point read correctly returns
 * the absent relation at version 0. The normal monotonic merge must reject an
 * arbitrary lower revision, but doing so here would leave the exact optimistic
 * projection stuck forever. Allow the lower authoritative revision only while
 * the current state is still byte-for-byte the projection installed by this
 * operation. Any intervening poll, mutation, or device response wins instead.
 */
export function reconcileFailedSessionPin(
  current: Session | null,
  optimistic: Pick<Session, "id" | "workspaceId" | "pinned" | "pinnedAt" | "pinVersion"> | null,
  authoritative: Pick<Session, "id" | "workspaceId" | "pinned" | "pinnedAt" | "pinVersion">,
): Session | null {
  if (
    !current ||
    !optimistic ||
    current.id !== optimistic.id ||
    current.workspaceId !== optimistic.workspaceId ||
    authoritative.id !== optimistic.id ||
    authoritative.workspaceId !== optimistic.workspaceId
  ) {
    return applySessionPinProjection(current, authoritative);
  }
  const stillExactOptimistic =
    Boolean(current.pinned) === Boolean(optimistic.pinned) &&
    (current.pinnedAt ?? null) === (optimistic.pinnedAt ?? null) &&
    (current.pinVersion ?? 0) === (optimistic.pinVersion ?? 0);
  if (!stillExactOptimistic) {
    return applySessionPinProjection(current, authoritative);
  }
  const authoritativePinned = Boolean(authoritative.pinned);
  const authoritativePinnedAt = authoritative.pinnedAt ?? null;
  const authoritativeVersion = authoritative.pinVersion ?? 0;
  if (
    Boolean(current.pinned) === authoritativePinned &&
    (current.pinnedAt ?? null) === authoritativePinnedAt &&
    (current.pinVersion ?? 0) === authoritativeVersion
  ) {
    return current;
  }
  return {
    ...current,
    pinned: authoritativePinned,
    pinnedAt: authoritativePinnedAt,
    pinVersion: authoritativeVersion,
  };
}

export function notifySessionPinChanged(workspaceId: string, sessionId: string): void {
  const message: SessionPinChangeMessage = {
    type: "session-pin.changed",
    sessionId,
    messageId: newMessageId(),
  };
  if (typeof BroadcastChannel !== "undefined") {
    const name = channelName(workspaceId);
    try {
      let channel = outboundChannels.get(name);
      if (!channel) {
        // Closing immediately after postMessage is observably lossy in real
        // browsers. Keep one document-scoped outbound channel alive instead.
        channel = new BroadcastChannel(name);
        outboundChannels.set(name, channel);
      }
      channel.postMessage(message);
    } catch {
      // localStorage below remains the cross-document fallback.
    }
  }

  if (typeof window === "undefined") return;
  const key = storageKey(workspaceId);
  const serialized = JSON.stringify(message);
  try {
    window.localStorage.setItem(key, serialized);
    // Removing synchronously can race delivery in sibling tabs. Leave the
    // unique payload long enough to emit a storage event, then remove only the
    // value written by this notification.
    window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(key) === serialized) {
          window.localStorage.removeItem(key);
        }
      } catch {
        // Storage may become unavailable after the page was backgrounded.
      }
    }, 1_000);
  } catch {
    // Private browsing and embedded contexts may deny localStorage entirely.
  }
}

export function subscribeToSessionPinChanges(
  workspaceId: string,
  onChange: (sessionId: string) => void,
): () => void {
  // BroadcastChannel and storage events can arrive in either order, and two
  // rapid mutations can interleave those transports. Remember a small bounded
  // window rather than only the immediately previous id so A, B, A still
  // invalidates exactly once per mutation without growing for the tab's life.
  const seenMessageIds = new Set<string>();
  const receive = (value: unknown): void => {
    const message = sessionPinChangeMessage(value);
    if (!message || seenMessageIds.has(message.messageId)) return;
    seenMessageIds.add(message.messageId);
    if (seenMessageIds.size > 64) {
      const oldest = seenMessageIds.values().next().value;
      if (oldest !== undefined) seenMessageIds.delete(oldest);
    }
    onChange(message.sessionId);
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(channelName(workspaceId));
      channel.addEventListener("message", (event: MessageEvent<unknown>) => receive(event.data));
    } catch {
      channel = null;
    }
  }

  const key = storageKey(workspaceId);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== key || !event.newValue) return;
    try {
      receive(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed or unrelated storage payloads.
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    channel?.close();
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}
