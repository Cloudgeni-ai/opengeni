import type {
  LatencyMode,
  ReasoningEffort,
  SessionEvent,
  SessionTurn,
  SessionModelAccountChoiceResponse,
} from "@opengeni/sdk";
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
    /** Project the last lease-backed serving model without changing the accepted policy. */
    includeServingModel?: boolean | undefined;
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
    latencyMode: turn.latencyMode,
    turnId: turn.id,
  };
}

/** Never project an earlier turn's selection onto newly admitted work. */
export function withServingModel(
  policy: LastStartedTurnPolicy | null,
  serving: SessionModelAccountChoiceResponse["serving"],
): LastStartedTurnPolicy | null {
  if (!policy || !serving || serving.turnId !== policy.turnId) return policy;
  return {
    turnId: policy.turnId,
    model: serving.modelId,
    reasoningEffort: serving.reasoningEffort,
    latencyMode: serving.latencyMode,
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
  const { client, workspaceId, registerSessionReconciler } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const includeServingModel = options.includeServingModel === true;

  const load = useCallback(
    async (signal?: AbortSignal): Promise<LastStartedTurnPolicy | null> => {
      if (!sessionId) return null;
      const turns = await client.listTurns(workspaceId, sessionId, {
        latestStarted: true,
        signal,
      });
      const policy = policyFromTurn(turns[0]);
      if (!includeServingModel || !policy || !client.getSessionModelAccount) return policy;
      const choice = await client.getSessionModelAccount(workspaceId, sessionId);
      return withServingModel(policy, choice.serving);
    },
    [client, workspaceId, sessionId, includeServingModel],
  );

  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled,
  });

  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "last-started-turn-policy", refresh);
  }, [enabled, refresh, registerSessionReconciler, sessionId]);

  // Shared-feed only: the session header lives outside the route event log and
  // must not open a second SSE. Without `events`, rely on the initial fetch +
  // optional poll / reconciler. Pause/resume controls do not change the last
  // admitted turn; its own turn.started event supplies that invalidation.
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    (event) =>
      isLastStartedTurnPolicyEvent(event) ||
      (includeServingModel &&
        (event.type === "subscription.account.selected" ||
          event.type === "subscription.account.switched")),
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
