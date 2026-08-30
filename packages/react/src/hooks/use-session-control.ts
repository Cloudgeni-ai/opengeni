import { createSessionControlStore } from "@opengeni/sdk/session";
import type { SessionControlResponse, SessionEvent } from "@opengeni/sdk";
import { useMemo, useSyncExternalStore } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useOwnedExternalStore } from "./internal";

export type UseSessionControlOptions = EmbeddedSessionClientOverride;

export type UseSessionControlResult = {
  pause: (reason?: string) => Promise<SessionControlResponse | null>;
  resume: (reason?: string) => Promise<SessionControlResponse | null>;
  controlling: boolean;
  /** Approve a pending `requires_action` approval. */
  approve: (approvalId: string, message?: string) => Promise<SessionEvent | null>;
  /** Reject a pending `requires_action` approval. */
  reject: (approvalId: string, message?: string) => Promise<SessionEvent | null>;
  /** True while an approval decision is in flight. */
  responding: boolean;
  error: Error | null;
  clearError: () => void;
};

/** React adapter over the framework-neutral session-control controller. */
export function useSessionControl(
  sessionId: string | null | undefined,
  options: UseSessionControlOptions = {},
): UseSessionControlResult {
  const { client, workspaceId } = useEmbeddedSession(options);
  const store = useMemo(
    () => createSessionControlStore({ client, workspaceId, sessionId }),
    [client, sessionId, workspaceId],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useOwnedExternalStore(store);
  return {
    pause: store.pause,
    resume: store.resume,
    controlling: snapshot.controlling,
    approve: store.approve,
    reject: store.reject,
    responding: snapshot.responding,
    error: snapshot.error,
    clearError: store.clearError,
  };
}
