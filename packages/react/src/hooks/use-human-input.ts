import type {
  SessionEvent,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useEmbeddedHumanInputSession,
  type EmbeddedHumanInputClientOverride,
} from "../session-context";
import { isActionableHumanInputRequest } from "../human-input";
import {
  useDebouncedCallback,
  useMutationRunner,
  usePolledValue,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Events that can create, settle, or invalidate an actionable request. */
export function isHumanInputEvent(event: Pick<SessionEvent, "type">): boolean {
  return (
    event.type === "session.humanInput.requested" ||
    event.type === "user.humanInputResponse" ||
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  );
}

export type UseHumanInputRequestsOptions = EmbeddedHumanInputClientOverride &
  SessionEventFeedOptions & {
    /** Optional safety-net polling. Durable events drive refresh by default. */
    pollIntervalMs?: number | undefined;
  };

export type UseHumanInputRequestsResult = {
  requests: SessionHumanInputRequest[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  respond: (
    requestId: string,
    response: SubmitHumanInputResponseRequest,
  ) => Promise<SessionEvent | null>;
  respondingRequestId: string | null;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * Authoritative structured-human-input hook. The server's pending-request
 * table is the read model; events only trigger reconciliation. This lets an
 * embedded host use the same primitive with a shared event feed or its own SDK
 * proxy without rebuilding request lifecycle logic.
 */
export function useHumanInputRequests(
  sessionId: string | null | undefined,
  options: UseHumanInputRequestsOptions = {},
): UseHumanInputRequestsResult {
  const { client, workspaceId, registerSessionReconciler } = useEmbeddedHumanInputSession(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const load = useCallback(
    async (): Promise<SessionHumanInputRequest[]> =>
      sessionId
        ? await client.listHumanInputRequests(workspaceId, sessionId, { status: "pending" })
        : [],
    [client, sessionId, workspaceId],
  );
  const state = usePolledValue(load, {
    enabled,
    pollIntervalMs: options.pollIntervalMs,
  });
  const loadedRequests = state.data;
  const refreshRequests = state.refresh;
  const mutation = useMutationRunner(`${workspaceId}\u0000${sessionId ?? ""}`);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [deadlineVersion, setDeadlineVersion] = useState(0);
  const respondingRequestRef = useRef<string | null>(null);

  useEffect(() => {
    respondingRequestRef.current = null;
    setRespondingRequestId(null);
  }, [sessionId, workspaceId]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "human-input", state.refresh);
  }, [enabled, registerSessionReconciler, sessionId, state.refresh]);

  const scheduleRefresh = useDebouncedCallback(() => void state.refresh());
  useSessionEventTrigger(client, workspaceId, sessionId, isHumanInputEvent, scheduleRefresh, {
    enabled,
    ...(options.events !== undefined ? { events: options.events } : {}),
  });

  useEffect(() => {
    const now = Date.now();
    const nextDeadline = (loadedRequests ?? []).reduce<number | null>((next, request) => {
      if (request.status !== "pending" || !request.expiresAt) return next;
      const deadline = Date.parse(request.expiresAt);
      if (!Number.isFinite(deadline) || deadline <= now) return next;
      return next === null ? deadline : Math.min(next, deadline);
    }, null);
    if (nextDeadline === null) return;
    const timer = globalThis.setTimeout(
      () => {
        setDeadlineVersion((current) => current + 1);
        void refreshRequests();
      },
      Math.min(2_147_483_647, Math.max(0, nextDeadline - now + 1)),
    );
    return () => globalThis.clearTimeout(timer);
  }, [loadedRequests, refreshRequests]);

  const respond = useCallback(
    async (
      requestId: string,
      response: SubmitHumanInputResponseRequest,
    ): Promise<SessionEvent | null> => {
      if (!sessionId || respondingRequestRef.current !== null) return null;
      respondingRequestRef.current = requestId;
      setRespondingRequestId(requestId);
      try {
        const event = await mutation.run(() =>
          client.submitHumanInputResponse(workspaceId, sessionId, requestId, response, {
            clientEventId: globalThis.crypto.randomUUID(),
          }),
        );
        if (event) await state.refresh();
        return event;
      } finally {
        if (respondingRequestRef.current === requestId) {
          respondingRequestRef.current = null;
          setRespondingRequestId(null);
        }
      }
    },
    [client, mutation, sessionId, state, workspaceId],
  );

  const now = Date.now();
  void deadlineVersion;
  return {
    requests: [...(state.data ?? [])]
      .filter((request) => isActionableHumanInputRequest(request, now))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    respond,
    respondingRequestId,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}
