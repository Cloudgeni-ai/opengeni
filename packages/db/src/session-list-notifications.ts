import postgres from "postgres";
import { setTimeout as delay } from "node:timers/promises";
import {
  DATABASE_AUTHENTICATION_MAX_ATTEMPTS,
  isDatabaseAuthenticationFailure,
  type RotatingDatabasePassword,
} from "./database-credentials";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "./lossless-json";

export const SESSION_LIST_NOTIFICATION_CHANNEL = "opengeni_session_lists";

/** Database-private hint. Never forward this payload directly to a client. */
export type SessionListDatabaseChange = {
  schema: string;
  workspaceId: string;
  sessionId: string | null;
  subjectId: string | null;
  all: boolean;
};
export type SessionListNotification =
  | { type: "connected" | "disconnected" }
  | { type: "change"; change: SessionListDatabaseChange };
export type SessionListChangeSource = {
  subscribe(listener: (event: SessionListNotification) => void): () => void;
  close(): Promise<void>;
};

function parseChange(payload: string): SessionListDatabaseChange | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.schema !== "string" ||
    typeof row.workspaceId !== "string" ||
    (row.sessionId !== null && typeof row.sessionId !== "string") ||
    (row.subjectId !== null && typeof row.subjectId !== "string") ||
    typeof row.all !== "boolean"
  )
    return null;
  return row as SessionListDatabaseChange;
}

/**
 * One lazy, session-pinned connection per API database handle. A transaction-mode
 * pooler is not a notification transport: callers must provide a direct/session
 * URL or leave this capability absent (the existing polling client still works).
 * Notifications are hints, not a replay log. Every successful LISTEN, including
 * reconnect, announces reconciliation before clients can consider themselves live.
 */
export function createSessionListChangeSource(
  databaseUrl: string,
  options: {
    searchPath?: string;
    reconnectDelayMs?: number;
    /** File-backed password for the same login (see `createDb`'s `passwordFiles`). */
    credential?: RotatingDatabasePassword;
  } = {},
): SessionListChangeSource {
  const credential = options.credential;
  const listeners = new Set<(event: SessionListNotification) => void>();
  const stop = new AbortController();
  let loop: Promise<void> | undefined;
  let driver: postgres.Sql | undefined;
  let connected = false;
  let schema: string | undefined;
  let generation = 0;
  let wake: (() => void) | undefined;
  /** Reconnects right after a 28P01 since the last successful LISTEN. */
  let immediateReconnects = 0;
  let immediateReconnectsGeneration: number | undefined;
  const emit = (event: SessionListNotification) => {
    for (const listener of listeners) {
      // One stopped HTTP consumer cannot disconnect every other subscriber.
      try {
        listener(event);
      } catch {
        /* The consumer owns its stream failure. */
      }
    }
  };
  const disconnect = () => {
    generation++;
    if (connected) {
      connected = false;
      emit({ type: "disconnected" });
    }
    wake?.();
  };
  const run = async () => {
    // postgres.js passes onnotify through parseOptions, but omits it from its
    // public Options type. Its listen() wrapper replaces onclose, hiding loss
    // from consumers. Keep both callbacks on this single pinned connection;
    // the real-PostgreSQL reconnect test covers this driver integration.
    const connectionOptions: postgres.Options<{}> & {
      onnotify: (channel: string, payload: string) => void;
    } = {
      max: 1,
      prepare: false,
      idle_timeout: 0,
      max_lifetime: 0,
      // Asked on every (re)connect: re-reads the files, so a rotated password
      // applies to the next LISTEN, and records it for that login.
      ...(credential ? { pass: (login: object) => credential.password(login) } : {}),
      connection: {
        application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
        ...(options.searchPath ? { search_path: options.searchPath } : {}),
      },
      onclose: disconnect,
      onnotify: (channel, payload) => {
        if (channel !== SESSION_LIST_NOTIFICATION_CHANNEL || !connected || !listeners.size) return;
        const change = parseChange(payload);
        if (change && change.schema === schema) emit({ type: "change", change });
      },
    };
    driver = postgres(databaseUrl, connectionOptions);
    while (!stop.signal.aborted) {
      const observedGeneration = generation;
      const observedCandidate = credential?.position();
      const lost = new Promise<void>((resolve) => {
        wake = resolve;
      });
      try {
        // LISTEN is committed before the caller's reconciliation read. Any
        // earlier change is in that read; any later commit reaches the socket.
        await driver.unsafe(`listen ${SESSION_LIST_NOTIFICATION_CHANNEL}`);
        const [row] = await driver<{ schema: string }[]>`select current_schema() as schema`;
        if (stop.signal.aborted) break;
        if (generation !== observedGeneration) continue;
        schema = row?.schema;
        if (!schema) throw new Error("Notification schema unavailable");
        connected = true;
        immediateReconnects = 0;
        emit({ type: "connected" });
        await lost;
      } catch (error) {
        // A refused login moves this connection to the next candidate unless
        // it used a password already replaced (stale); the reconnect below
        // then tries the selected one. Nothing ran on a refused login.
        let retryNow = false;
        if (
          credential &&
          observedCandidate !== undefined &&
          isDatabaseAuthenticationFailure(error)
        ) {
          const outcome = credential.reportAuthenticationFailure(
            credential.refusedPosition(error) ?? observedCandidate,
          );
          // Another password is selected now: try it at once rather than
          // after the reconnect delay, a bounded number of times until this
          // connection listens again or the files change, so passwords that
          // are all refused cannot alternate without a pause.
          const filesGeneration = credential.position().generation;
          if (filesGeneration !== immediateReconnectsGeneration) {
            immediateReconnectsGeneration = filesGeneration;
            immediateReconnects = 0;
          }
          retryNow =
            outcome !== "unchanged" &&
            immediateReconnects < DATABASE_AUTHENTICATION_MAX_ATTEMPTS - 1;
        }
        disconnect();
        if (retryNow && !stop.signal.aborted) {
          immediateReconnects += 1;
          continue;
        }
      }
      if (!stop.signal.aborted) {
        await delay(options.reconnectDelayMs ?? 1000, undefined, { signal: stop.signal }).catch(
          () => undefined,
        );
      }
    }
  };
  return {
    subscribe(listener) {
      if (stop.signal.aborted) throw new Error("Session list listener closed");
      listeners.add(listener);
      listener({ type: connected ? "connected" : "disconnected" });
      loop ??= run();
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      stop.abort();
      disconnect();
      await driver?.end();
      await loop;
      listeners.clear();
    },
  };
}
