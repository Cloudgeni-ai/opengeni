import type { SessionEvent, SessionTurn, UpdateSessionTurnRequest } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  useDebouncedCallback,
  useMutationRunner,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Event types that change the turn queue (queue/edit/reorder/claim/finish). */
export function isTurnQueueEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type.startsWith("turn.");
}

/** Queued turns in execution order (position, then creation time). */
export function queueFromTurns(turns: SessionTurn[]): SessionTurn[] {
  return turns
    .filter((turn) => turn.status === "queued")
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

/** The turn currently holding the session (running or awaiting approval). */
export function activeTurnFromTurns(turns: SessionTurn[]): SessionTurn | null {
  return (
    turns.find((turn) => turn.status === "running" || turn.status === "requires_action") ?? null
  );
}

/** Optimistic projection of a queued-turn edit. */
export function applyTurnEdit(
  turns: SessionTurn[],
  turnId: string,
  update: UpdateSessionTurnRequest,
): SessionTurn[] {
  return turns.map((turn) => {
    if (turn.id !== turnId || turn.status !== "queued") {
      return turn;
    }
    return {
      ...turn,
      ...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
      ...(update.resources !== undefined ? { resources: update.resources } : {}),
      ...(update.tools !== undefined ? { tools: update.tools } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.reasoningEffort !== undefined ? { reasoningEffort: update.reasoningEffort } : {}),
      ...(update.sandboxBackend !== undefined ? { sandboxBackend: update.sandboxBackend } : {}),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
    };
  });
}

/**
 * Optimistic projection of a reorder, mirroring the server: the listed
 * queued turns get positions 1..n in the given order; everything else keeps
 * its position.
 */
export function applyTurnReorder(turns: SessionTurn[], turnIds: string[]): SessionTurn[] {
  const positions = new Map(turnIds.map((turnId, index) => [turnId, index + 1] as const));
  return turns.map((turn) => {
    const position = positions.get(turn.id);
    return position !== undefined && turn.status === "queued" ? { ...turn, position } : turn;
  });
}

/** Optimistic projection of a queued-turn delete (server marks it cancelled). */
export function applyTurnRemoval(turns: SessionTurn[], turnId: string): SessionTurn[] {
  return turns.map((turn) =>
    turn.id === turnId && turn.status === "queued"
      ? { ...turn, status: "cancelled" as const }
      : turn,
  );
}

export type UseTurnQueueOptions = ClientOverride &
  SessionEventFeedOptions & {
    /** Optional safety-net polling (ms). Off by default — turn.* events drive updates. */
    pollIntervalMs?: number | undefined;
  };

export type UseTurnQueueResult = {
  /** All turns the API returned (history + queue), newest server view. */
  turns: SessionTurn[];
  /** Queued turns in execution order — render this as the editable queue. */
  queue: SessionTurn[];
  /** The running / requires_action turn, if any. */
  activeTurn: SessionTurn | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Edit a queued turn (optimistic; rolls back via refetch on failure). */
  editTurn: (turnId: string, update: UpdateSessionTurnRequest) => Promise<SessionTurn | null>;
  /** Reorder the queue to the given queued-turn id order (optimistic). */
  reorderTurns: (turnIds: string[]) => Promise<SessionTurn[] | null>;
  /** Delete (cancel) a queued turn before it is claimed (optimistic). */
  removeTurn: (turnId: string) => Promise<SessionTurn | null>;
  /** True while an edit/reorder/remove is in flight. */
  mutating: boolean;
  /** Last failed mutation, until the next mutation or clear. */
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * The live turn queue — the heart of the queue-by-default interaction model.
 * Messages sent mid-turn stack up here, visible and editable/reorderable/
 * deletable until the worker claims them. Updates arrive over the session
 * event stream (`turn.*`), either shared via `options.events` (pass the log
 * from `useSessionEvents` to reuse its connection) or a dedicated tail
 * stream. All mutations apply optimistically and reconcile with the server.
 */
export function useTurnQueue(
  sessionId: string | null | undefined,
  options: UseTurnQueueOptions = {},
): UseTurnQueueResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useMutationRunner();
  const generation = useRef(0);
  const targetKeyRef = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const ticket = ++generation.current;
    try {
      const fetched = await client.listTurns(workspaceId, sessionId);
      if (ticket === generation.current) {
        setTurns(fetched);
        setError(null);
        setLoading(false);
      }
    } catch (cause) {
      if (ticket === generation.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setLoading(false);
      }
    }
  }, [client, workspaceId, sessionId]);

  // Reset when the target session changes; initial load + optional polling.
  useEffect(() => {
    const targetKey = `${workspaceId}\u0000${sessionId ?? ""}`;
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      setTurns([]);
      setError(null);
    }
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
    const pollIntervalMs = options.pollIntervalMs;
    if (pollIntervalMs === undefined || pollIntervalMs <= 0) {
      return () => {
        generation.current += 1;
      };
    }
    const timer = setInterval(() => void load(), pollIntervalMs);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [load, enabled, workspaceId, sessionId, options.pollIntervalMs]);

  // Live updates: any turn.* event re-syncs the queue (debounced).
  const scheduleRefresh = useDebouncedCallback(() => void load());
  useSessionEventTrigger(client, workspaceId, sessionId, isTurnQueueEvent, scheduleRefresh, {
    enabled,
    ...(options.events !== undefined ? { events: options.events } : {}),
  });

  const editTurn = useCallback(
    async (turnId: string, update: UpdateSessionTurnRequest): Promise<SessionTurn | null> => {
      if (!sessionId) {
        return null;
      }
      setTurns((current) => applyTurnEdit(current, turnId, update));
      const result = await mutation.run(() =>
        client.updateQueuedTurn(workspaceId, sessionId, turnId, update),
      );
      if (result) {
        setTurns((current) => current.map((turn) => (turn.id === result.id ? result : turn)));
      } else {
        void load();
      }
      return result;
    },
    [client, workspaceId, sessionId, mutation.run, load],
  );

  const reorderTurns = useCallback(
    async (turnIds: string[]): Promise<SessionTurn[] | null> => {
      if (!sessionId || turnIds.length === 0) {
        return null;
      }
      setTurns((current) => applyTurnReorder(current, turnIds));
      const result = await mutation.run(() =>
        client.reorderQueuedTurns(workspaceId, sessionId, turnIds),
      );
      if (result) {
        // The server returns the queued turns; merge them over local state.
        setTurns((current) => {
          const bySId = new Map(result.map((turn) => [turn.id, turn] as const));
          return current.map((turn) => bySId.get(turn.id) ?? turn);
        });
      } else {
        void load();
      }
      return result;
    },
    [client, workspaceId, sessionId, mutation.run, load],
  );

  const removeTurn = useCallback(
    async (turnId: string): Promise<SessionTurn | null> => {
      if (!sessionId) {
        return null;
      }
      setTurns((current) => applyTurnRemoval(current, turnId));
      const result = await mutation.run(() =>
        client.deleteQueuedTurn(workspaceId, sessionId, turnId),
      );
      if (result) {
        setTurns((current) => current.map((turn) => (turn.id === result.id ? result : turn)));
      } else {
        void load();
      }
      return result;
    },
    [client, workspaceId, sessionId, mutation.run, load],
  );

  return {
    turns,
    queue: queueFromTurns(turns),
    activeTurn: activeTurnFromTurns(turns),
    loading,
    error,
    refresh: load,
    editTurn,
    reorderTurns,
    removeTurn,
    mutating: mutation.mutating,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}
