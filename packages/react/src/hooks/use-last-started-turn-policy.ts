import type { LatencyMode, ReasoningEffort, SessionEvent, SessionTurn } from "@opengeni/sdk";
import { useCallback, useEffect } from "react";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { usePolledValue, useSessionEventTrigger, type SessionEventFeedOptions } from "./internal";

/** Refresh when a turn actually admits — not on composer picker / queue-only changes. */
export function isLastStartedTurnPolicyEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type === "turn.started";
}

export type LastStartedTurnPolicy = {
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
  turnId: string;
};

export type UseLastStartedTurnPolicyOptions = ClientOverride &
  SessionEventFeedOptions & {
    pollIntervalMs?: number | undefined;
  };

export type UseLastStartedTurnPolicyResult = {
  /** Null until some turn has durably emitted `turn.started`. */
  policy: LastStartedTurnPolicy | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

function policyFromTurn(turn: SessionTurn | null | undefined): LastStartedTurnPolicy | null {
  if (!turn) return null;
  return {
    model: turn.model,
    reasoningEffort: turn.reasoningEffort,
    latencyMode: turn.latencyMode ?? "standard",
    turnId: turn.id,
  };
}

/**
 * Model·effort·latency of the newest admitted turn (`turn.started`). This is
 * historical runtime truth for the session header — not the composer next-turn
 * picker and not the frozen session creation defaults.
 */
export function useLastStartedTurnPolicy(
  sessionId: string | null | undefined,
  options: UseLastStartedTurnPolicyOptions = {},
): UseLastStartedTurnPolicyResult {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);

  const load = useCallback(async (): Promise<LastStartedTurnPolicy | null> => {
    if (!sessionId) return null;
    const turns = await client.listTurns(workspaceId, sessionId, { latestStarted: true });
    return policyFromTurn(turns[0]);
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
    return registerSessionReconciler(sessionId, "last-started-turn-policy", refresh);
  }, [enabled, refresh, registerSessionReconciler, sessionId]);

  // Shared-feed only: the session header lives outside the route event log and
  // must not open a second SSE. Without `events`, rely on the initial fetch +
  // optional poll / workspace-control / reconciler.
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isLastStartedTurnPolicyEvent,
    () => void refresh(),
    {
      events: options.events,
      enabled: enabled && options.events !== undefined,
    },
  );

  return {
    policy: enabled ? data : null,
    loading,
    error,
    refresh,
  };
}
