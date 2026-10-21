import type { GetSessionOptions, Session } from "@opengeni/sdk";

/**
 * `useSession` reads a conversation's detail fresh (`getSession` with
 * `fresh: true`), and `useSessionEvents` reads the same detail for the durable
 * head once its first window lands, to join the live stream there. When both
 * open one conversation through one client object, the head read joins the
 * detail read started since the stream began loading (in flight or settled)
 * instead of reading the session a second time.
 *
 * A joined head can only be older than a new read would be; the stream then
 * replays the difference from its cursor, which is always correct. A failed
 * read is never kept.
 */
type SessionDetailSource = {
  getSession: (
    workspaceId: string,
    sessionId: string,
    options?: GetSessionOptions,
  ) => Promise<Session>;
};
type DetailRead = { promise: Promise<Session>; ordinal: number };

// Orders reads across clients: a read is joinable when it started after a mark.
let lastOrdinal = 0;
// Per client object, the newest fresh detail read of each conversation.
const reads = new WeakMap<object, Map<string, DetailRead>>();

function readKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

/** A mark: `joinSessionDetailRead` accepts only reads started after it. */
export function sessionDetailReadMark(): number {
  return lastOrdinal;
}

/** Read the detail fresh, so a head read started later can join it. */
export function readFreshSessionDetail(
  client: SessionDetailSource,
  workspaceId: string,
  sessionId: string,
  options: Omit<GetSessionOptions, "fresh"> = {},
): Promise<Session> {
  const promise = client.getSession(workspaceId, sessionId, { ...options, fresh: true });
  const read: DetailRead = { promise, ordinal: ++lastOrdinal };
  let scoped = reads.get(client);
  if (!scoped) {
    scoped = new Map();
    reads.set(client, scoped);
  }
  const key = readKey(workspaceId, sessionId);
  scoped.set(key, read);
  promise.catch(() => {
    if (scoped.get(key) === read) scoped.delete(key);
  });
  return promise;
}

/** The newest fresh detail read started after `mark`, or null. */
export function joinSessionDetailRead(
  client: object,
  workspaceId: string,
  sessionId: string,
  mark: number,
): Promise<Session> | null {
  const read = reads.get(client)?.get(readKey(workspaceId, sessionId));
  return read && read.ordinal > mark ? read.promise : null;
}
