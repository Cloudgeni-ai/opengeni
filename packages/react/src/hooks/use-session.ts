import type { Session, SessionEvent } from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  useMutationRunner,
  usePolledValue,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

export type UseSessionOptions = ClientOverride &
  SessionEventFeedOptions & {
    /** Re-fetch on an interval (ms). Off by default — pair with `useSessionEvents` for live status. */
    pollIntervalMs?: number | undefined;
  };

export type UseSessionResult = {
  session: Session | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Manually rename the session (PATCH, source='user'). Returns the updated session, or null on failure. */
  updateTitle: (title: string) => Promise<Session | null>;
  /** True while a rename is in flight. */
  updating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/** Event types that change the session title (auto + cross-client renames). */
export function isTitleEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type === "session.title_set";
}

/** Fetch one session (with optional polling), live-patching its title on `session.title_set`. */
export function useSession(
  sessionId: string | null | undefined,
  options: UseSessionOptions = {},
): UseSessionResult {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const [override, setOverride] = useState<Session | null>(null);
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner();
  const load = useCallback(async () => {
    if (!sessionId) {
      return null;
    }
    const fetched = await client.getSession(workspaceId, sessionId);
    // A fresh server read supersedes any optimistic/event-driven override.
    setOverride(null);
    return fetched;
  }, [client, workspaceId, sessionId]);
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled,
  });
  useEffect(() => {
    if (enabled && workspaceControlEvent) void refresh();
  }, [enabled, refresh, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "session", refresh);
  }, [enabled, refresh, registerSessionReconciler, sessionId]);

  const base = data ?? null;
  // The override only ever carries title/titleSource patches; it is reset on
  // every fresh load so it can never go stale against the server snapshot.
  const session =
    base && override && override.id === base.id
      ? { ...base, title: override.title, titleSource: override.titleSource }
      : base;

  // Live-patch the title on auto (agent) + cross-client (user/agent) renames so
  // the UI reflects the new title without polling or a full re-fetch.
  const onTitleEvent = useCallback(
    (event: SessionEvent) => {
      const payload = (event.payload ?? {}) as { title?: unknown; source?: unknown };
      const title = payload.title;
      if (typeof title !== "string") {
        return;
      }
      const source: "user" | "agent" | null =
        payload.source === "user" || payload.source === "agent" ? payload.source : null;
      setOverride((current): Session | null => {
        const next = current ?? base;
        if (!next) {
          return current;
        }
        return { ...next, title, titleSource: source };
      });
    },
    [base],
  );
  useSessionEventTrigger(client, workspaceId, sessionId, isTitleEvent, onTitleEvent, {
    enabled,
    ...(options.events !== undefined ? { events: options.events } : {}),
  });

  const updateTitle = useCallback(
    async (title: string): Promise<Session | null> => {
      if (!sessionId) {
        return null;
      }
      const result = await run(() => client.updateSession(workspaceId, sessionId, { title }));
      if (result) {
        setOverride(result);
      }
      return result;
    },
    [client, workspaceId, sessionId, run],
  );

  return {
    session,
    loading,
    error,
    refresh,
    updateTitle,
    updating: mutating,
    mutationError,
    clearMutationError,
  };
}
