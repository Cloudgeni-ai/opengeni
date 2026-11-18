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
  metadata?: Record<string, unknown> | undefined;
};

export type DesktopConnectWatch = {
  itemId: string;
  /** The provider the sign-in is for; null when only its MCP address is known. */
  providerDomain: string | null;
  mcpUrl: string | null;
  ownership: ConnectionOwnership;
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
  connections: readonly WatchedConnection[];
  now?: number;
}): DesktopConnectWatch | null {
  if (!input.providerDomain && !input.mcpUrl) return null;
  return {
    itemId: input.itemId,
    providerDomain: input.providerDomain,
    mcpUrl: input.mcpUrl,
    ownership: input.ownership,
    before: new Map(input.connections.map((connection) => [connection.id, connection.status])),
    until: (input.now ?? Date.now()) + DESKTOP_CONNECT_WATCH_MS,
  };
}

/**
 * The connection the watched sign-in produced: one for its provider that is
 * active now and was not before (new, or signed in again). Null until then.
 */
export function finishedDesktopConnection<Connection extends WatchedConnection>(
  watch: DesktopConnectWatch,
  connections: readonly Connection[],
): Connection | null {
  return (
    connections.find((connection) => {
      if (connection.status !== "active" || watch.before.get(connection.id) === "active")
        return false;
      if (watch.providerDomain) return connection.providerDomain === watch.providerDomain;
      return connection.metadata?.mcpUrl === watch.mcpUrl;
    }) ?? null
  );
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
