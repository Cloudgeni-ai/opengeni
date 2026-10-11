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
  isInteractionControlUnavailable,
  isNonRetryableInteractionError,
} from "../lib/interaction-errors";
import {
  type EmbeddedComputerInteractionClientOverride,
  useEmbeddedComputerInteraction,
} from "../session-context";
import { usePageLiveActivity } from "./internal";

// Keep caller promises intact while fencing their later viewer side effects.
// These local fences never become part of an operation receipt on the wire.
const actionResultFences = new WeakMap<object, () => boolean>();
export function isStaleComputerActionResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && actionResultFences.get(value)?.() === false;
}
export function computerActionReceiptError(receipt: ComputerActionReceipt): Error {
  const error = new Error(receipt.error?.message ?? "Desktop input did not complete.");
  const fence = actionResultFences.get(receipt);
  if (fence) actionResultFences.set(error, fence);
  return error;
}

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
  /** Control service loss, independent of target accessibility inspection and media. */
  controlError: Error | null;
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
  const sourceRef = useRef<ComputerControlSource>({
    client,
    workspaceId,
    computerSessionId,
    enabled,
  });
  if (
    sourceRef.current.client !== client ||
    sourceRef.current.workspaceId !== workspaceId ||
    sourceRef.current.computerSessionId !== computerSessionId ||
    sourceRef.current.enabled !== enabled
  ) {
    sourceRef.current = { client, workspaceId, computerSessionId, enabled };
  }
  const source = sourceRef.current;
  const pageLive = usePageLiveActivity();
  const pollIntervalMs = Math.max(750, options.pollIntervalMs ?? 2_000);
  const [state, setState] = useState<ComputerControlState>(() => emptyState(source, enabled));
  const visible = state.source === source ? state : emptyState(source, enabled);
  const refreshBlocked = isNonRetryableInteractionError(visible.error);
  const selectedTargetIdRef = useRef<string | null>(visible.selectedTargetId);
  selectedTargetIdRef.current = visible.selectedTargetId;
  const selectionRevisionRef = useRef(0);
  const actionResultOrderRef = useRef({ next: 0, settled: 0 });
  const targetsRef = useRef<{
    source: ComputerControlSource;
    computerSessionId: string | null;
    targets: ComputerTarget[];
  }>({
    source,
    computerSessionId,
    targets: visible.targets,
  });
  const observationRef = useRef<{
    source: ComputerControlSource;
    computerSessionId: string | null;
    observation: ComputerObservation | null;
  }>({ source, computerSessionId, observation: visible.observation });
  if (targetsRef.current.source !== source) {
    targetsRef.current = { source, computerSessionId, targets: visible.targets };
    observationRef.current = {
      source,
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
    source: typeof source;
    count: number;
  }>({
    computerSessionId,
    source,
    count: 0,
  });
  const mountedRef = useRef(true);
  const isCurrentSource = useCallback(
    () => mountedRef.current && sourceRef.current === source,
    [source],
  );

  const invalidateRefresh = useCallback(() => {
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    requestRef.current = { id, controller: null };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !computerSessionId || !isCurrentSource()) return;
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current = { id, controller };
    let discoveryCompleted = false;
    try {
      const [session, targetResponse] = await Promise.all([
        client.getComputerSession(workspaceId, computerSessionId, {
          signal: controller.signal,
        }),
        client.listComputerTargets(workspaceId, computerSessionId, {
          signal: controller.signal,
        }),
      ]);
      discoveryCompleted = true;
      if (!isCurrentSource() || requestRef.current.id !== id) return;
      const targets = sortComputerTargets(targetResponse.targets);
      const selected = chooseTarget(targets, selectedTargetIdRef.current);
      // A closed window must not silently redirect viewing or input to another
      // application. Retain the choice until the person selects a new target.
      const selectedId = selected?.id ?? selectedTargetIdRef.current;
      // Discovery is useful independently of semantic observation. Publish it
      // now so a slow/unresponsive application cannot block the frame stream
      // or prevent the person from choosing a different window or screen.
      const previous =
        observationRef.current.source === source ? observationRef.current.observation : null;
      const retainedObservation =
        selected &&
        previous?.target.id === selected.id &&
        previous.target.controllerGeneration === selected.controllerGeneration &&
        previous.target.targetGeneration === selected.targetGeneration
          ? previous
          : null;
      selectedTargetIdRef.current = selectedId;
      targetsRef.current = { source, computerSessionId, targets };
      observationRef.current = { source, computerSessionId, observation: retainedObservation };
      setState((current) =>
        isCurrentSource() &&
        current.source === source &&
        current.computerSessionId === computerSessionId
          ? {
              ...current,
              session,
              targets,
              selectedTargetId: selectedId,
              observation: retainedObservation,
              loading: false,
              error: null,
              controlError: null,
            }
          : current,
      );
      const observation = selected
        ? await client.observeComputerTarget(workspaceId, computerSessionId, selected.id, {
            signal: controller.signal,
          })
        : null;
      if (!isCurrentSource() || requestRef.current.id !== id) return;
      selectedTargetIdRef.current = selectedId;
      targetsRef.current = { source, computerSessionId, targets };
      observationRef.current = { source, computerSessionId, observation };
      setState((current) =>
        isCurrentSource() &&
        current.source === source &&
        current.computerSessionId === computerSessionId
          ? {
              ...current,
              session,
              targets,
              selectedTargetId: selectedId,
              observation,
              loading: false,
              error: null,
            }
          : current,
      );
    } catch (cause) {
      if (controller.signal.aborted || !isCurrentSource() || requestRef.current.id !== id) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setState((current) =>
        isCurrentSource() &&
        current.source === source &&
        current.computerSessionId === computerSessionId
          ? {
              ...current,
              loading: false,
              error,
              controlError: isInteractionControlUnavailable(
                error,
                discoveryCompleted ? "observation" : "control",
              )
                ? error
                : current.controlError,
            }
          : current,
      );
    } finally {
      if (requestRef.current.id === id) requestRef.current = { id, controller: null };
    }
  }, [client, computerSessionId, enabled, isCurrentSource, source, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      invalidateRefresh();
      setState(emptyState(source, false));
      return;
    }
    setState((current) =>
      current.source === source
        ? {
            ...current,
            loading: true,
            mutating: mutationRef.current.source === source && mutationRef.current.count > 0,
          }
        : emptyState(source, true),
    );
    void refresh();
    return () => {
      mountedRef.current = false;
      invalidateRefresh();
    };
  }, [computerSessionId, enabled, invalidateRefresh, refresh, source]);

  useEffect(() => {
    if (!enabled || !pageLive || visible.mutating || refreshBlocked) return;
    const timer = setInterval(() => {
      if (!requestRef.current.controller) void refresh();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, pageLive, pollIntervalMs, refresh, refreshBlocked, visible.mutating]);

  useEffect(() => {
    if (!enabled || !computerSessionId || !pageLive || refreshBlocked) return;
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
  }, [client, computerSessionId, enabled, pageLive, refresh, refreshBlocked, workspaceId]);

  const runMutation = useCallback(
    async <T>(scopeComputerSessionId: string, operation: () => Promise<T>): Promise<T> => {
      if (!isCurrentSource()) throw new Error("The desktop source is no longer selected.");
      invalidateRefresh();
      if (
        mutationRef.current.computerSessionId !== scopeComputerSessionId ||
        mutationRef.current.source !== source
      ) {
        mutationRef.current = {
          computerSessionId: scopeComputerSessionId,
          source,
          count: 0,
        };
      }
      mutationRef.current.count += 1;
      setState((current) =>
        isCurrentSource() &&
        current.source === source &&
        current.computerSessionId === scopeComputerSessionId
          ? { ...current, mutating: true, error: null }
          : current,
      );
      try {
        return await operation();
      } finally {
        if (
          mutationRef.current.computerSessionId === scopeComputerSessionId &&
          mutationRef.current.source === source
        ) {
          mutationRef.current.count = Math.max(0, mutationRef.current.count - 1);
          const mutating = mutationRef.current.count > 0;
          setState((current) =>
            isCurrentSource() &&
            current.source === source &&
            current.computerSessionId === scopeComputerSessionId
              ? { ...current, mutating }
              : current,
          );
        }
      }
    },
    [invalidateRefresh, isCurrentSource, source],
  );

  const selectTarget = useCallback(
    async (targetId: string): Promise<ComputerTarget> => {
      if (!computerSessionId) throw new Error("No desktop is selected.");
      if (!isCurrentSource()) throw new Error("The desktop source is no longer selected.");
      const target =
        targetsRef.current.source === source
          ? targetsRef.current.targets.find((candidate) => candidate.id === targetId)
          : null;
      if (!target) throw new Error("The selected desktop target is no longer available.");
      invalidateRefresh();
      const readRequestId = requestRef.current.id;
      const selectionRevision = ++selectionRevisionRef.current;
      const isCurrentSelection = () =>
        isCurrentSource() && selectionRevisionRef.current === selectionRevision;
      // Once admitted, a queued observation survives immediate input.
      const isCurrentSelectionRead = () =>
        isCurrentSelection() && requestRef.current.id === readRequestId;
      selectedTargetIdRef.current = target.id;
      observationRef.current = { source, computerSessionId, observation: null };
      setState((current) =>
        isCurrentSelection() &&
        current.source === source &&
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
        if (!isCurrentSelectionRead() || selectedTargetIdRef.current !== target.id) return target;
        observationRef.current = { source, computerSessionId, observation };
        setState((current) =>
          isCurrentSelection() &&
          current.source === source &&
          current.computerSessionId === computerSessionId &&
          current.selectedTargetId === target.id
            ? { ...current, observation, loading: false, error: null }
            : current,
        );
        return observation.target;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (isCurrentSelectionRead()) {
          setState((current) =>
            isCurrentSelection() &&
            current.source === source &&
            current.computerSessionId === computerSessionId &&
            current.selectedTargetId === target.id
              ? {
                  ...current,
                  loading: false,
                  error,
                  controlError: isInteractionControlUnavailable(error, "observation")
                    ? error
                    : current.controlError,
                }
              : current,
          );
        }
        throw error;
      }
    },
    [client, computerSessionId, invalidateRefresh, isCurrentSource, source, workspaceId],
  );

  const dispatchAction = useCallback(
    async (
      action: ComputerAction,
      operationId: string,
      frame: ComputerFrame | null,
    ): Promise<ComputerActionReceipt> => {
      if (!computerSessionId) throw new Error("No desktop is selected.");
      if (!isCurrentSource()) throw new Error("The desktop source is no longer selected.");
      if (frame && frame.computerSessionId !== computerSessionId) {
        throw new Error("The displayed desktop frame belongs to another desktop session.");
      }
      const currentObservation =
        observationRef.current.source === source &&
        observationRef.current.computerSessionId === computerSessionId
          ? observationRef.current.observation
          : null;
      const focusTarget =
        action.type === "focus" && targetsRef.current.source === source
          ? (targetsRef.current.targets.find((candidate) => candidate.id === action.targetId) ??
            null)
          : null;
      const frameTarget =
        frame && targetsRef.current.source === source
          ? currentObservation?.target.id === frame.targetId
            ? currentObservation.target
            : (targetsRef.current.targets.find((candidate) => candidate.id === frame.targetId) ??
              null)
          : null;
      const inputTarget =
        (action.type === "keyboard" || action.type === "clipboard") &&
        targetsRef.current.source === source &&
        targetsRef.current.computerSessionId === computerSessionId
          ? targetsRef.current.targets.find(
              (candidate) => candidate.id === selectedTargetIdRef.current,
            )
          : null;
      const target =
        frameTarget ?? focusTarget ?? currentObservation?.target ?? inputTarget ?? null;
      if (!target) throw new Error("The desktop target is not ready for input.");
      if (frame && frame.targetId !== selectedTargetIdRef.current) {
        throw new Error("The displayed desktop frame is no longer selected.");
      }
      if (
        frame &&
        (frame.controllerGeneration !== target.controllerGeneration ||
          frame.targetGeneration !== target.targetGeneration)
      ) {
        throw new Error("The displayed desktop frame belongs to an earlier target generation.");
      }
      if (action.type === "pointer") {
        const expectedFrameId = frame?.frameId ?? currentObservation?.frameId ?? null;
        if (!expectedFrameId || action.frameId !== expectedFrameId) {
          throw new Error("Pointer input must reference the exact displayed desktop frame.");
        }
      }
      if (action.type === "semantic" && !currentObservation) {
        throw new Error("The desktop accessibility tree is not ready for input.");
      }
      const selectedTargetId = selectedTargetIdRef.current;
      const selectedTarget = targetsRef.current.targets.find(
        (candidate) => candidate.id === selectedTargetId,
      );
      const selectedFence = selectedTarget && {
        id: selectedTarget.id,
        computerSessionId: selectedTarget.computerSessionId,
        controllerGeneration: selectedTarget.controllerGeneration,
        targetGeneration: selectedTarget.targetGeneration,
      };
      const selectionRevision = selectionRevisionRef.current;
      const isCurrentView = () =>
        isCurrentSource() &&
        selectionRevisionRef.current === selectionRevision &&
        selectedTargetIdRef.current === selectedTargetId &&
        targetsRef.current.source === source &&
        targetsRef.current.computerSessionId === computerSessionId &&
        sameTargetFence(
          selectedFence,
          targetsRef.current.targets.find((candidate) => candidate.id === selectedTargetId),
        );
      const resultOrder = ++actionResultOrderRef.current.next;
      let admitted = false;
      let resultTargetId = selectedTargetId;
      let resultFence = selectedFence;
      const isCurrentResultView = () =>
        isCurrentSource() &&
        selectionRevisionRef.current === selectionRevision &&
        selectedTargetIdRef.current === resultTargetId &&
        targetsRef.current.source === source &&
        sameTargetFence(
          resultFence,
          targetsRef.current.targets.find((candidate) => candidate.id === resultTargetId),
        );
      const canProjectResult = () => {
        if (!admitted) {
          if (!isCurrentView() || resultOrder < actionResultOrderRef.current.settled) return false;
          actionResultOrderRef.current.settled = resultOrder;
          admitted = true;
          invalidateRefresh();
        }
        return isCurrentResultView() && resultOrder === actionResultOrderRef.current.settled;
      };
      const projectState = (update: (current: ComputerControlState) => ComputerControlState) => {
        setState((current) =>
          admitted &&
          isCurrentResultView() &&
          current.source === source &&
          current.computerSessionId === computerSessionId &&
          current.actionResultOrder <= resultOrder
            ? { ...update(current), actionResultOrder: resultOrder }
            : current,
        );
      };

      return await runMutation(computerSessionId, async () => {
        try {
          const receipt = await client.actInComputer(workspaceId, computerSessionId, {
            operationId,
            targetId: target.id,
            expectedTargetGeneration: frame?.targetGeneration ?? target.targetGeneration,
            expectedObservationId:
              action.type === "pointer" ? null : (currentObservation?.observationId ?? null),
            expectedFrameId: action.type === "pointer" ? action.frameId : null,
            action,
          });
          const receiptSettled =
            receipt.state === "completed" ||
            receipt.state === "failed" ||
            receipt.state === "outcome_unknown";
          actionResultFences.set(receipt, () =>
            admitted
              ? isCurrentResultView() && resultOrder === actionResultOrderRef.current.settled
              : isCurrentView() && resultOrder >= actionResultOrderRef.current.settled,
          );
          // A settled result may project only until a later dispatched action
          // settles for this view. Pending later input does not hide this result.
          if (!receiptSettled || !canProjectResult()) return receipt;
          if (receipt.observation) {
            const observation = receipt.observation;
            observationRef.current = { source, computerSessionId, observation };
            selectedTargetIdRef.current = observation.target.id;
            targetsRef.current.targets = replaceTarget(
              targetsRef.current.targets,
              observation.target,
            );
            resultTargetId = observation.target.id;
            resultFence = {
              id: observation.target.id,
              computerSessionId: observation.target.computerSessionId,
              controllerGeneration: observation.target.controllerGeneration,
              targetGeneration: observation.target.targetGeneration,
            };
            projectState((current) => ({
              ...current,
              error: null,
              controlError: null,
              observation,
              selectedTargetId: observation.target.id,
              targets: replaceTarget(current.targets, observation.target),
            }));
          } else {
            projectState((current) => ({ ...current, error: null, controlError: null }));
            void refresh();
          }
          return receipt;
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          actionResultFences.set(
            error,
            () =>
              admitted &&
              isCurrentResultView() &&
              resultOrder === actionResultOrderRef.current.settled,
          );
          if (canProjectResult()) {
            projectState((current) => ({
              ...current,
              error,
              controlError: isInteractionControlUnavailable(error) ? error : current.controlError,
            }));
          }
          throw error;
        }
      });
    },
    [
      client,
      computerSessionId,
      invalidateRefresh,
      isCurrentSource,
      refresh,
      runMutation,
      source,
      workspaceId,
    ],
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
    if (!computerSessionId) throw new Error("No desktop is selected.");
    const selectionRevision = selectionRevisionRef.current;
    const settledOrder = actionResultOrderRef.current.settled;
    const selectedTargetId = selectedTargetIdRef.current;
    const selectedTarget = targetsRef.current.targets.find(
      (candidate) => candidate.id === selectedTargetId,
    );
    const selectedFence = selectedTarget && {
      id: selectedTarget.id,
      computerSessionId: selectedTarget.computerSessionId,
      controllerGeneration: selectedTarget.controllerGeneration,
      targetGeneration: selectedTarget.targetGeneration,
    };
    const isCurrentRead = () =>
      isCurrentSource() &&
      selectionRevisionRef.current === selectionRevision &&
      actionResultOrderRef.current.settled === settledOrder &&
      selectedTargetIdRef.current === selectedTargetId &&
      targetsRef.current.source === source &&
      sameTargetFence(
        selectedFence,
        targetsRef.current.targets.find((candidate) => candidate.id === selectedTargetId),
      );
    try {
      const clipboard = await client.readComputerClipboard(workspaceId, computerSessionId);
      actionResultFences.set(clipboard, isCurrentRead);
      return clipboard;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      actionResultFences.set(error, isCurrentRead);
      setState((current) =>
        isCurrentRead() &&
        current.source === source &&
        current.computerSessionId === computerSessionId
          ? {
              ...current,
              error,
              controlError: isInteractionControlUnavailable(error) ? error : current.controlError,
            }
          : current,
      );
      throw error;
    }
  }, [client, computerSessionId, isCurrentSource, source, workspaceId]);

  return {
    session: visible.session,
    targets: visible.targets,
    selectedTarget:
      visible.targets.find((target) => target.id === visible.selectedTargetId) ?? null,
    observation: visible.observation,
    loading: visible.loading,
    mutating: visible.mutating,
    error: visible.error,
    controlError: visible.controlError,
    refresh,
    readClipboard,
    selectTarget,
    act,
    actFromFrame,
  };
}

type ComputerControlSource = Pick<
  ReturnType<typeof useEmbeddedComputerInteraction>,
  "client" | "workspaceId"
> & {
  computerSessionId: string | null;
  enabled: boolean;
};

type ComputerControlState = {
  source: ComputerControlSource;
  computerSessionId: string | null;
  session: ComputerSession | null;
  targets: ComputerTarget[];
  selectedTargetId: string | null;
  observation: ComputerObservation | null;
  loading: boolean;
  mutating: boolean;
  error: Error | null;
  controlError: Error | null;
  actionResultOrder: number;
};

function emptyState(source: ComputerControlSource, loading: boolean): ComputerControlState {
  return {
    source,
    computerSessionId: source.computerSessionId,
    session: null,
    targets: [],
    selectedTargetId: null,
    observation: null,
    loading,
    mutating: false,
    error: null,
    controlError: null,
    actionResultOrder: 0,
  };
}

function chooseTarget(
  targets: readonly ComputerTarget[],
  preferredId: string | null,
): ComputerTarget | null {
  if (preferredId !== null) return targets.find((target) => target.id === preferredId) ?? null;
  return (
    targets.find((target) => target.focused && target.kind === "screen") ??
    targets.find((target) => target.kind === "screen") ??
    targets.find((target) => target.focused && target.kind === "window") ??
    targets.find((target) => target.kind === "window") ??
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

type ComputerTargetFence = Pick<
  ComputerTarget,
  "id" | "computerSessionId" | "controllerGeneration" | "targetGeneration"
>;

function sameTargetFence(
  left: ComputerTargetFence | undefined,
  right: ComputerTargetFence | undefined,
): boolean {
  return (
    left?.id === right?.id &&
    left?.computerSessionId === right?.computerSessionId &&
    left?.controllerGeneration === right?.controllerGeneration &&
    left?.targetGeneration === right?.targetGeneration
  );
}
