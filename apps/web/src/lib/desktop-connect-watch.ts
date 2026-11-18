/**
 * The desktop app sends a connection's sign-in to the person's browser, and
 * the browser finishes it. The app does not wait for the browser to hand the
 * person back (a link the browser may ask about, block, or open in another
 * app): it watches the workspace's connections and finishes as soon as the new
 * one appears. The hand-back link then only brings the window forward.
 */
import type { ConnectionOwnership } from "@opengeni/contracts";

type WatchedConnection = {
  id: string;
  providerDomain: string;
  status: string;
  /** The person a personal connection belongs to; null for a workspace one. */
  subjectId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type DesktopConnectWatch = {
  itemId: string;
  /** The provider the sign-in is for; null when only its MCP address is known. */
  providerDomain: string | null;
  mcpUrl: string | null;
  ownership: ConnectionOwnership;
  /** Who is connecting, to tell their personal connection from a teammate's. */
  viewerSubjectId: string | null;
  /** The account being signed in again, for a reconnect. */
  reconnectConnectionId: string | null;
  /** Each connection's status when the sign-in started. */
  before: ReadonlyMap<string, string>;
  /** When to stop watching: a sign-in link lasts ten minutes. */
  until: number;
};

export const DESKTOP_CONNECT_WATCH_MS = 10 * 60 * 1_000;
export const DESKTOP_CONNECT_POLL_MS = 2_500;

export function startDesktopConnectWatch(input: {
  itemId: string;
  providerDomain: string | null;
  mcpUrl: string | null;
  ownership: ConnectionOwnership;
  viewerSubjectId?: string | null | undefined;
  reconnectConnectionId?: string | null | undefined;
  connections: readonly WatchedConnection[];
  now?: number;
}): DesktopConnectWatch | null {
  if (!input.providerDomain && !input.mcpUrl) return null;
  return {
    itemId: input.itemId,
    providerDomain: input.providerDomain,
    mcpUrl: input.mcpUrl,
    ownership: input.ownership,
    viewerSubjectId: input.viewerSubjectId ?? null,
    reconnectConnectionId: input.reconnectConnectionId ?? null,
    before: new Map(input.connections.map((connection) => [connection.id, connection.status])),
    until: (input.now ?? Date.now()) + DESKTOP_CONNECT_WATCH_MS,
  };
}

/**
 * The connection the watched sign-in produced: one for its provider and owner
 * (the workspace, or the person connecting) that is active now and was not
 * before. A reconnect accepts only the account it signs in again or a new
 * one, never another account that recovers meanwhile. Connections the app
 * already finished are skipped. Null until then.
 */
export function finishedDesktopConnection<Connection extends WatchedConnection>(
  watch: DesktopConnectWatch,
  connections: readonly Connection[],
  alreadyFinished: (connectionId: string) => boolean = () => false,
): Connection | null {
  return (
    connections.find((connection) => {
      if (connection.status !== "active" || watch.before.get(connection.id) === "active")
        return false;
      if (alreadyFinished(connection.id)) return false;
      if (!ownedAsWatched(watch, connection)) return false;
      if (
        watch.reconnectConnectionId &&
        connection.id !== watch.reconnectConnectionId &&
        watch.before.has(connection.id)
      )
        return false;
      if (watch.providerDomain) return connection.providerDomain === watch.providerDomain;
      return connection.metadata?.mcpUrl === watch.mcpUrl;
    }) ?? null
  );
}

function ownedAsWatched(watch: DesktopConnectWatch, connection: WatchedConnection): boolean {
  // Rows without an owner field can't be told apart; the provider match decides.
  if (connection.subjectId === undefined) return true;
  if (watch.ownership === "workspace") return connection.subjectId === null;
  if (connection.subjectId === null) return false;
  return watch.viewerSubjectId === null || connection.subjectId === watch.viewerSubjectId;
}

const FINISHED_KEY = "opengeni.desktopConnect.finished";

/**
 * Connections the app already finished by watching, so the hand-back link that
 * may arrive afterwards refreshes quietly instead of announcing them twice.
 */
export function rememberDesktopConnectFinished(connectionId: string, storage?: Storage): void {
  try {
    const store = storage ?? window.sessionStorage;
    const ids = readFinished(store).filter((id) => id !== connectionId);
    store.setItem(FINISHED_KEY, JSON.stringify([...ids.slice(-19), connectionId]));
  } catch {
    // Storage can be unavailable; the hand-back link then just repeats the toast.
  }
}

export function desktopConnectAlreadyFinished(connectionId: string, storage?: Storage): boolean {
  try {
    return readFinished(storage ?? window.sessionStorage).includes(connectionId);
  } catch {
    return false;
  }
}

function readFinished(storage: Storage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(FINISHED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
