import type {
  ComputerAction,
  ComputerActionReceipt,
  ComputerClipboard,
  ComputerFrame,
  ComputerObservation,
  ComputerSession,
  ComputerTarget,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type EmbeddedComputerInteractionClientOverride,
  useEmbeddedComputerInteraction,
} from "../session-context";
import { usePageLiveActivity } from "./internal";

export type UseComputerSessionOptions = EmbeddedComputerInteractionClientOverride & {
  computerSessionId: string | null;
  enabled?: boolean | undefined;
  pollIntervalMs?: number | undefined;
};

export type UseComputerSessionResult = {
  session: ComputerSession | null;
  targets: ComputerTarget[];
  selectedTarget: ComputerTarget | null;
  observation: ComputerObservation | null;
  loading: boolean;
  mutating: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  readClipboard: () => Promise<ComputerClipboard>;
  /** Changes only this viewer's target cursor; it never takes ownership or
   * foregrounds an application. */
  selectTarget: (targetId: string) => Promise<ComputerTarget>;
  act: (action: ComputerAction, operationId?: string) => Promise<ComputerActionReceipt>;
  /** Dispatch pointer input against the exact displayed frame. */
  actFromFrame: (
    action: Extract<ComputerAction, { type: "pointer" }>,
    frame: ComputerFrame,
    operationId?: string,
  ) => Promise<ComputerActionReceipt>;
};

/** Selected ComputerSession state. Semantic and pixel input share the same
 * generation-fenced controller operation stream used by agents. */
export function useComputerSession(options: UseComputerSessionOptions): UseComputerSessionResult {
  const { client, workspaceId } = useEmbeddedComputerInteraction(options);
  const computerSessionId = options.computerSessionId;
  const enabled = (options.enabled ?? true) && computerSessionId !== null;
  const pageLive = usePageLiveActivity();
  const pollIntervalMs = Math.max(750, options.pollIntervalMs ?? 2_000);
  const [state, setState] = useState<ComputerControlState>(() =>
    emptyState(computerSessionId, enabled),
  );
  const visible =
    state.computerSessionId === computerSessionId ? state : emptyState(computerSessionId, enabled);
  const selectedTargetIdRef = useRef<string | null>(visible.selectedTargetId);
  selectedTargetIdRef.current = visible.selectedTargetId;
  const targetsRef = useRef<{
    computerSessionId: string | null;
    targets: ComputerTarget[];
  }>({
    computerSessionId,
    targets: visible.targets,
  });
  const observationRef = useRef<{
    computerSessionId: string | null;
    observation: ComputerObservation | null;
  }>({ computerSessionId, observation: visible.observation });
  if (targetsRef.current.computerSessionId !== computerSessionId) {
    targetsRef.current = { computerSessionId, targets: visible.targets };
    observationRef.current = {
      computerSessionId,
      observation: visible.observation,
    };
  } else {
    targetsRef.current.targets = visible.targets;
    observationRef.current.observation = visible.observation;
  }
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({
    id: 0,
    controller: null,
  });
  const mutationRef = useRef<{
    computerSessionId: string | null;
    count: number;
  }>({
    computerSessionId,
    count: 0,
  });
  const mountedRef = useRef(true);

  const invalidateRefresh = useCallback(() => {
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    requestRef.current = { id, controller: null };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !computerSessionId) return;
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current = { id, controller };
    try {
      const [session, targetResponse] = await Promise.all([
        client.getComputerSession(workspaceId, computerSessionId, {
          signal: controller.signal,
        }),
        client.listComputerTargets(workspaceId, computerSessionId, {
          signal: controller.signal,
        }),
      ]);
      if (!mountedRef.current || requestRef.current.id !== id) return;
      const targets = sortComputerTargets(targetResponse.targets);
      const selected = chooseTarget(targets, selectedTargetIdRef.current, session.platform);
      const observation = selected
        ? await client.observeComputerTarget(workspaceId, computerSessionId, selected.id, {
            signal: controller.signal,
          })
        : null;
      if (!mountedRef.current || requestRef.current.id !== id) return;
      selectedTargetIdRef.current = selected?.id ?? null;
      targetsRef.current = { computerSessionId, targets };
      observationRef.current = { computerSessionId, observation };
      setState((current) =>
        current.computerSessionId === computerSessionId
          ? {
              ...current,
              session,
              targets,
              selectedTargetId: selected?.id ?? null,
              observation,
              loading: false,
              error: null,
            }
          : current,
      );
    } catch (cause) {
      if (controller.signal.aborted || !mountedRef.current || requestRef.current.id !== id) return;
      setState((current) =>
        current.computerSessionId === computerSessionId
          ? {
              ...current,
              loading: false,
              error: cause instanceof Error ? cause : new Error(String(cause)),
            }
          : current,
      );
    } finally {
      if (requestRef.current.id === id) requestRef.current = { id, controller: null };
    }
  }, [client, computerSessionId, enabled, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      invalidateRefresh();
      setState(emptyState(computerSessionId, false));
      return;
    }
    setState((current) =>
      current.computerSessionId === computerSessionId
        ? { ...current, loading: true }
        : emptyState(computerSessionId, true),
    );
    void refresh();
    return () => {
      mountedRef.current = false;
      invalidateRefresh();
    };
  }, [computerSessionId, enabled, invalidateRefresh, refresh]);

  useEffect(() => {
    if (!enabled || !pageLive || visible.mutating) return;
    const timer = setInterval(() => {
      if (!requestRef.current.controller) void refresh();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, pageLive, pollIntervalMs, refresh, visible.mutating]);

  useEffect(() => {
    if (!enabled || !computerSessionId || !pageLive) return;
    let disposed = false;
    const timer = setInterval(() => {
      void client.heartbeatComputerSession(workspaceId, computerSessionId).catch(() => {
        if (!disposed) void refresh();
      });
    }, 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, computerSessionId, enabled, pageLive, refresh, workspaceId]);

  const runMutation = useCallback(
    async <T>(scopeComputerSessionId: string, operation: () => Promise<T>): Promise<T> => {
      invalidateRefresh();
      if (mutationRef.current.computerSessionId !== scopeComputerSessionId) {
        mutationRef.current = {
          computerSessionId: scopeComputerSessionId,
          count: 0,
        };
      }
      mutationRef.current.count += 1;
      setState((current) =>
        current.computerSessionId === scopeComputerSessionId
          ? { ...current, mutating: true, error: null }
          : current,
      );
      try {
        return await operation();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((current) =>
          current.computerSessionId === scopeComputerSessionId ? { ...current, error } : current,
        );
        throw error;
      } finally {
        if (mutationRef.current.computerSessionId === scopeComputerSessionId) {
          mutationRef.current.count = Math.max(0, mutationRef.current.count - 1);
          const mutating = mutationRef.current.count > 0;
          setState((current) =>
            current.computerSessionId === scopeComputerSessionId
              ? { ...current, mutating }
              : current,
          );
        }
      }
    },
    [invalidateRefresh],
  );

  const selectTarget = useCallback(
    async (targetId: string): Promise<ComputerTarget> => {
      if (!computerSessionId) throw new Error("No ComputerSession is selected.");
      const target = targetsRef.current.targets.find((candidate) => candidate.id === targetId);
      if (!target) throw new Error("The selected computer target is no longer available.");
      invalidateRefresh();
      selectedTargetIdRef.current = target.id;
      observationRef.current = { computerSessionId, observation: null };
      setState((current) =>
        current.computerSessionId === computerSessionId
          ? {
              ...current,
              selectedTargetId: target.id,
              observation: null,
              loading: true,
              error: null,
            }
          : current,
      );
      try {
        const observation = await client.observeComputerTarget(
          workspaceId,
          computerSessionId,
          target.id,
        );
        if (selectedTargetIdRef.current !== target.id) return target;
        observationRef.current = { computerSessionId, observation };
        setState((current) =>
          current.computerSessionId === computerSessionId && current.selectedTargetId === target.id
            ? { ...current, observation, loading: false, error: null }
            : current,
        );
        return observation.target;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((current) =>
          current.computerSessionId === computerSessionId && current.selectedTargetId === target.id
            ? { ...current, loading: false, error }
            : current,
        );
        throw error;
      }
    },
    [client, computerSessionId, invalidateRefresh, workspaceId],
  );

  const dispatchAction = useCallback(
    async (
      action: ComputerAction,
      operationId: string,
      frame: ComputerFrame | null,
    ): Promise<ComputerActionReceipt> => {
      if (!computerSessionId) throw new Error("No ComputerSession is selected.");
      if (frame && frame.computerSessionId !== computerSessionId) {
        throw new Error("The displayed computer frame belongs to another ComputerSession.");
      }
      const currentObservation =
        observationRef.current.computerSessionId === computerSessionId
          ? observationRef.current.observation
          : null;
      const focusTarget =
        action.type === "focus"
          ? (targetsRef.current.targets.find((candidate) => candidate.id === action.targetId) ??
            null)
          : null;
      const frameTarget = frame
        ? (targetsRef.current.targets.find((candidate) => candidate.id === frame.targetId) ??
          (currentObservation?.target.id === frame.targetId ? currentObservation.target : null))
        : null;
      const target = frameTarget ?? focusTarget ?? currentObservation?.target ?? null;
      if (!target) throw new Error("The computer target is not ready for input.");
      if (frame && frame.targetId !== selectedTargetIdRef.current) {
        throw new Error("The displayed computer frame is no longer selected.");
      }
      if (action.type === "pointer") {
        const expectedFrameId = frame?.frameId ?? currentObservation?.frameId ?? null;
        if (!expectedFrameId || action.frameId !== expectedFrameId) {
          throw new Error("Pointer input must reference the exact displayed computer frame.");
        }
      }
      if (action.type === "semantic" && !currentObservation) {
        throw new Error("The computer accessibility tree is not ready for input.");
      }

      return await runMutation(computerSessionId, async () => {
        const receipt = await client.actInComputer(workspaceId, computerSessionId, {
          operationId,
          targetId: target.id,
          expectedTargetGeneration: frame?.targetGeneration ?? target.targetGeneration,
          expectedObservationId:
            action.type === "pointer" ? null : (currentObservation?.observationId ?? null),
          expectedFrameId: action.type === "pointer" ? action.frameId : null,
          action,
        });
        if (receipt.observation) {
          const observation = receipt.observation;
          observationRef.current = { computerSessionId, observation };
          selectedTargetIdRef.current = observation.target.id;
          setState((current) =>
            current.computerSessionId === computerSessionId
              ? {
                  ...current,
                  observation,
                  selectedTargetId: observation.target.id,
                  targets: replaceTarget(current.targets, observation.target),
                }
              : current,
          );
        } else {
          void refresh();
        }
        return receipt;
      });
    },
    [client, computerSessionId, refresh, runMutation, workspaceId],
  );

  const act = useCallback(
    async (
      action: ComputerAction,
      operationId: string = crypto.randomUUID(),
    ): Promise<ComputerActionReceipt> => await dispatchAction(action, operationId, null),
    [dispatchAction],
  );

  const actFromFrame = useCallback(
    async (
      action: Extract<ComputerAction, { type: "pointer" }>,
      frame: ComputerFrame,
      operationId: string = crypto.randomUUID(),
    ): Promise<ComputerActionReceipt> => await dispatchAction(action, operationId, frame),
    [dispatchAction],
  );

  const readClipboard = useCallback(async (): Promise<ComputerClipboard> => {
    if (!computerSessionId) throw new Error("No ComputerSession is selected.");
    return await client.readComputerClipboard(workspaceId, computerSessionId);
  }, [client, computerSessionId, workspaceId]);

  return {
    session: visible.session,
    targets: visible.targets,
    selectedTarget:
      visible.targets.find((target) => target.id === visible.selectedTargetId) ?? null,
    observation: visible.observation,
    loading: visible.loading,
    mutating: visible.mutating,
    error: visible.error,
    refresh,
    readClipboard,
    selectTarget,
    act,
    actFromFrame,
  };
}

type ComputerControlState = {
  computerSessionId: string | null;
  session: ComputerSession | null;
  targets: ComputerTarget[];
  selectedTargetId: string | null;
  observation: ComputerObservation | null;
  loading: boolean;
  mutating: boolean;
  error: Error | null;
};

function emptyState(computerSessionId: string | null, loading: boolean): ComputerControlState {
  return {
    computerSessionId,
    session: null,
    targets: [],
    selectedTargetId: null,
    observation: null,
    loading,
    mutating: false,
    error: null,
  };
}

function chooseTarget(
  targets: readonly ComputerTarget[],
  preferredId: string | null,
  platform: ComputerSession["platform"],
): ComputerTarget | null {
  const preferred = targets.find((target) => target.id === preferredId);
  if (preferred) return preferred;
  if (platform === "linux") {
    return (
      targets.find((target) => target.focused && target.kind === "screen") ??
      targets.find((target) => target.kind === "screen") ??
      targets.find((target) => target.focused && target.kind === "window") ??
      targets.find((target) => target.kind === "window") ??
      targets[0] ??
      null
    );
  }
  return (
    targets.find((target) => target.focused && target.kind === "window") ??
    targets.find((target) => target.kind === "window") ??
    targets.find((target) => target.kind === "screen") ??
    targets.find((target) => target.focused && target.kind === "app") ??
    targets.find((target) => target.kind === "app") ??
    targets[0] ??
    null
  );
}

function sortComputerTargets(targets: readonly ComputerTarget[]): ComputerTarget[] {
  const rank = { window: 0, app: 1, screen: 2 } as const;
  return [...targets].sort(
    (left, right) =>
      Number(right.focused) - Number(left.focused) ||
      rank[left.kind] - rank[right.kind] ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  );
}

function replaceTarget(
  targets: readonly ComputerTarget[],
  target: ComputerTarget,
): ComputerTarget[] {
  return sortComputerTargets([
    ...targets.filter((candidate) => candidate.id !== target.id),
    target,
  ]);
}
