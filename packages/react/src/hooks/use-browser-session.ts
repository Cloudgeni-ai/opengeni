import type {
  BrowserAction,
  BrowserActionBatch,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDiagnosticsOptions,
  BrowserFrame,
  BrowserObservation,
  BrowserSession,
  BrowserTarget,
} from "@opengeni/sdk/interaction";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import { isNonRetryableInteractionError } from "../lib/interaction-errors";
import { usePageLiveActivity } from "./internal";

/** Immutable input fence; queued actions never need the encoded screenshot. */
export type BrowserFrameInputFence = Pick<
  BrowserFrame,
  | "browserSessionId"
  | "controllerGeneration"
  | "targetId"
  | "targetGeneration"
  | "documentGeneration"
  | "frameId"
>;

export type BrowserInputFailure = Pick<BrowserActionReceipt, "operationId" | "error"> & {
  state: Exclude<BrowserActionReceipt["state"], "completed">;
};

export type UseBrowserSessionOptions = EmbeddedBrowserInteractionClientOverride & {
  browserSessionId: string | null;
  enabled?: boolean | undefined;
  pollIntervalMs?: number | undefined;
  /** Keep session/tab inventory current without repeatedly fetching the full
   * accessibility tree while a live frame is available or the viewer is hidden. */
  semanticObservationEnabled?: boolean | undefined;
};

export type UseBrowserSessionResult = {
  session: BrowserSession | null;
  targets: BrowserTarget[];
  selectedTarget: BrowserTarget | null;
  observation: BrowserObservation | null;
  loading: boolean;
  mutating: boolean;
  error: Error | null;
  inputFailure: BrowserInputFailure | null;
  refresh: () => Promise<void>;
  observeForInput: () => Promise<BrowserObservation>;
  actFromObservation: (
    action: BrowserAction,
    observation: BrowserObservation,
  ) => Promise<BrowserActionReceipt>;
  selectTarget: (targetId: string) => Promise<BrowserTarget>;
  openTarget: (url?: string) => Promise<BrowserTarget>;
  closeTarget: (targetId: string) => Promise<void>;
  act: (
    action: BrowserAction | BrowserActionBatch,
    operationId?: string,
  ) => Promise<BrowserActionReceipt>;
  /** Dispatch input against the exact image a human saw. Stale images fail at
   *  the controller fence instead of targeting a newer page. */
  actFromFrame: (
    action: BrowserAction | BrowserActionBatch,
    frame: BrowserFrameInputFence,
    operationId?: string,
    observationMode?: "none" | "input",
  ) => Promise<BrowserActionReceipt>;
  readClipboard: () => Promise<BrowserClipboard>;
  diagnostics: (options?: BrowserDiagnosticsOptions) => Promise<BrowserDiagnosticBatch>;
};

/** Selected BrowserSession control state. All human actions use the same
 *  generation-fenced controller operation stream as agent actions. */
export function useBrowserSession(options: UseBrowserSessionOptions): UseBrowserSessionResult {
  const { client, workspaceId } = useEmbeddedBrowserInteraction(options);
  const browserSessionId = options.browserSessionId;
  const enabled = (options.enabled ?? true) && browserSessionId !== null;
  const sourceRef = useRef({ client, workspaceId, browserSessionId, enabled });
  if (
    sourceRef.current.client !== client ||
    sourceRef.current.workspaceId !== workspaceId ||
    sourceRef.current.browserSessionId !== browserSessionId ||
    sourceRef.current.enabled !== enabled
  ) {
    sourceRef.current = { client, workspaceId, browserSessionId, enabled };
  }
  const source = sourceRef.current;
  const semanticObservationEnabled = options.semanticObservationEnabled ?? true;
  const semanticObservationEnabledRef = useRef(semanticObservationEnabled);
  semanticObservationEnabledRef.current = semanticObservationEnabled;
  const previousSemanticObservationRef = useRef({
    browserSessionId,
    enabled: semanticObservationEnabled,
  });
  const pageLive = usePageLiveActivity();
  const pollIntervalMs = Math.max(750, options.pollIntervalMs ?? 2_000);
  const [state, setState] = useState<{
    source: typeof source;
    browserSessionId: string | null;
    session: BrowserSession | null;
    targets: BrowserTarget[];
    selectedTargetId: string | null;
    observation: BrowserObservation | null;
    loading: boolean;
    mutating: boolean;
    error: Error | null;
    inputFailure: BrowserInputFailure | null;
    actionResultOrder: number;
  }>(() => ({ ...emptyState(browserSessionId, enabled), source }));
  const visible =
    state.source === source && state.browserSessionId === browserSessionId
      ? state
      : { ...emptyState(browserSessionId, enabled), source };
  const refreshBlocked = isNonRetryableInteractionError(visible.error);
  const inputFailureRef = useRef(visible.inputFailure);
  inputFailureRef.current = visible.inputFailure;
  const selectedTargetIdRef = useRef<string | null>(visible.selectedTargetId);
  selectedTargetIdRef.current = visible.selectedTargetId;
  const selectionRevisionRef = useRef(0);
  const actionResultOrderRef = useRef({ next: 0, settled: 0 });
  const selectedTargetRef = useRef<BrowserTarget | null>(
    visible.targets.find((target) => target.id === visible.selectedTargetId) ?? null,
  );
  selectedTargetRef.current =
    visible.targets.find((target) => target.id === visible.selectedTargetId) ?? null;
  const observationRef = useRef<{
    browserSessionId: string | null;
    observation: BrowserObservation | null;
  }>({ browserSessionId, observation: visible.observation });
  const lastObservationAtRef = useRef(0);
  if (observationRef.current.browserSessionId !== browserSessionId) {
    observationRef.current = {
      browserSessionId,
      observation: visible.observation,
    };
  } else {
    observationRef.current.observation = visible.observation;
  }
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({
    id: 0,
    controller: null,
  });
  const mutationRef = useRef<{
    browserSessionId: string | null;
    source: typeof source;
    count: number;
    needsInventoryReconcile: boolean;
  }>({
    browserSessionId,
    source,
    count: 0,
    needsInventoryReconcile: false,
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

  const refreshInventory = useCallback(
    async (checkInput = false, observeSelectedTarget = true) => {
      if (!enabled || !browserSessionId || !isCurrentSource()) return;
      const checkedInputFailure = inputFailureRef.current;
      const id = requestRef.current.id + 1;
      requestRef.current.controller?.abort();
      const controller = new AbortController();
      requestRef.current = { id, controller };
      try {
        const [session, targetResponse] = await Promise.all([
          client.getBrowserSession(workspaceId, browserSessionId, {
            signal: controller.signal,
          }),
          client.listBrowserTargets(workspaceId, browserSessionId, {
            signal: controller.signal,
          }),
        ]);
        if (!isCurrentSource() || requestRef.current.id !== id) return;
        const selected = chooseTarget(targetResponse.targets, selectedTargetIdRef.current);
        selectedTargetIdRef.current = selected?.id ?? null;
        selectedTargetRef.current = selected;
        const previousObservation =
          observationRef.current.browserSessionId === browserSessionId
            ? observationRef.current.observation
            : null;
        const retainedObservation =
          selected && previousObservation && sameObservationTarget(previousObservation, selected)
            ? previousObservation
            : null;
        observationRef.current = {
          browserSessionId,
          observation: retainedObservation,
        };
        setState((current) =>
          isCurrentSource() &&
          current.source === source &&
          current.browserSessionId === browserSessionId
            ? {
                ...current,
                session,
                targets: targetResponse.targets,
                selectedTargetId: selected?.id ?? null,
                observation: retainedObservation,
                loading: false,
                error: null,
                // Media and background polling cannot confirm an input outcome.
                // Only an explicit fresh check clears the notice it began with.
                inputFailure:
                  checkInput &&
                  session.id === browserSessionId &&
                  targetResponse.browserSessionId === browserSessionId &&
                  current.inputFailure === checkedInputFailure
                    ? null
                    : current.inputFailure,
              }
            : current,
        );
        if (!selected || !observeSelectedTarget || !semanticObservationEnabledRef.current) return;
        try {
          const observation = await client.observeBrowserTarget(
            workspaceId,
            browserSessionId,
            selected.id,
            { signal: controller.signal },
          );
          if (!isCurrentSource() || requestRef.current.id !== id) return;
          const currentSelected = selectedTargetRef.current;
          if (
            observationRef.current.browserSessionId !== browserSessionId ||
            currentSelected?.id !== selected.id ||
            observation.browserSessionId !== browserSessionId ||
            observation.target.id !== selected.id ||
            observation.target.controllerGeneration !== currentSelected.controllerGeneration ||
            observation.target.targetGeneration !== currentSelected.targetGeneration
          )
            return;
          // Navigation may complete between the inventory and its selected-page
          // observation. Keep both the selected target and input fence coherent.
          selectedTargetRef.current = observation.target;
          observationRef.current = { browserSessionId, observation };
          lastObservationAtRef.current = Date.now();
          setState((current) =>
            isCurrentSource() &&
            current.source === source &&
            current.browserSessionId === browserSessionId &&
            current.selectedTargetId === observation.target.id
              ? {
                  ...current,
                  observation,
                  targets: replaceTarget(current.targets, observation.target),
                }
              : current,
          );
        } catch (cause) {
          if (controller.signal.aborted || !isCurrentSource() || requestRef.current.id !== id)
            return;
          // Target inventory and the media plane remain authoritative for the
          // human-facing browser. A failed semantic snapshot must not blank or
          // disable an otherwise live visual browser.
          void cause;
        }
      } catch (cause) {
        if (controller.signal.aborted || !isCurrentSource() || requestRef.current.id !== id) return;
        setState((current) =>
          isCurrentSource() &&
          current.source === source &&
          current.browserSessionId === browserSessionId
            ? {
                ...current,
                loading: false,
                error: cause instanceof Error ? cause : new Error(String(cause)),
              }
            : current,
        );
      } finally {
        if (requestRef.current.id === id) {
          requestRef.current = { id, controller: null };
        }
      }
    },
    [browserSessionId, client, enabled, isCurrentSource, source, workspaceId],
  );

  const refresh = useCallback(async () => await refreshInventory(true), [refreshInventory]);

  const refreshSemantic = useCallback(async (): Promise<void> => {
    if (!enabled || !browserSessionId || !isCurrentSource()) return;
    const target = selectedTargetRef.current;
    if (!target) return;
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current = { id, controller };
    try {
      const observation = await client.observeBrowserTarget(
        workspaceId,
        browserSessionId,
        target.id,
        { signal: controller.signal },
      );
      if (!isCurrentSource() || requestRef.current.id !== id) return;
      if (!sameObservationTarget(observation, selectedTargetRef.current)) return;
      observationRef.current = { browserSessionId, observation };
      lastObservationAtRef.current = Date.now();
      setState((current) =>
        isCurrentSource() &&
        current.source === source &&
        current.browserSessionId === browserSessionId &&
        current.selectedTargetId === target.id
          ? { ...current, observation }
          : current,
      );
    } catch {
      // A failed semantic fallback cannot disable an otherwise live browser.
    } finally {
      if (requestRef.current.id === id) requestRef.current = { id, controller: null };
    }
  }, [browserSessionId, client, enabled, isCurrentSource, source, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      invalidateRefresh();
      setState({ ...emptyState(browserSessionId, false), source });
      return;
    }
    setState((current) =>
      isCurrentSource() &&
      current.source === source &&
      current.browserSessionId === browserSessionId
        ? { ...current, loading: true }
        : { ...emptyState(browserSessionId, true), source },
    );
    void refreshInventory();
    return () => {
      mountedRef.current = false;
      invalidateRefresh();
    };
  }, [browserSessionId, enabled, invalidateRefresh, isCurrentSource, refreshInventory, source]);

  useEffect(() => {
    const previous = previousSemanticObservationRef.current;
    previousSemanticObservationRef.current = {
      browserSessionId,
      enabled: semanticObservationEnabled,
    };
    if (
      enabled &&
      semanticObservationEnabled &&
      previous.browserSessionId === browserSessionId &&
      !previous.enabled
    ) {
      // The media stream disappeared or the user returned to the Browser tab.
      // A just-returned action/tab observation is already a fresh fallback.
      // Otherwise drop the old tree/fence until a new read settles.
      const currentObservation = observationRef.current.observation;
      if (
        currentObservation &&
        sameObservationTarget(currentObservation, selectedTargetRef.current) &&
        Date.now() - lastObservationAtRef.current < pollIntervalMs
      ) {
        return;
      }
      observationRef.current = { browserSessionId, observation: null };
      setState((current) =>
        isCurrentSource() &&
        current.source === source &&
        current.browserSessionId === browserSessionId
          ? { ...current, observation: null }
          : current,
      );
      void refreshSemantic();
    }
  }, [
    browserSessionId,
    enabled,
    isCurrentSource,
    pollIntervalMs,
    refreshSemantic,
    semanticObservationEnabled,
    source,
  ]);

  useEffect(() => {
    if (!enabled || !pageLive || visible.mutating || refreshBlocked) return;
    const timer = setInterval(() => {
      if (!requestRef.current.controller) void refreshInventory();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, pageLive, pollIntervalMs, refreshInventory, refreshBlocked, visible.mutating]);

  useEffect(() => {
    if (!enabled || !browserSessionId || !pageLive || refreshBlocked) return;
    let disposed = false;
    const heartbeat = () => {
      if (!isCurrentSource()) return;
      void client.heartbeatBrowserSession(workspaceId, browserSessionId).catch(() => {
        if (!disposed) void refreshInventory();
      });
    };
    const timer = setInterval(heartbeat, 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [
    browserSessionId,
    client,
    enabled,
    isCurrentSource,
    pageLive,
    refreshInventory,
    refreshBlocked,
    workspaceId,
  ]);

  const runMutation = useCallback(
    async <T>(
      scopeBrowserSessionId: string,
      operation: (selectionRevision: number, readRequestId: number) => Promise<T>,
      selectionRead = false,
      changesInventory = false,
    ): Promise<T> => {
      if (!enabled || !isCurrentSource()) {
        throw new Error("The browser source is no longer selected.");
      }
      const selectionRevision = ++selectionRevisionRef.current;
      invalidateRefresh();
      const readRequestId = requestRef.current.id;
      if (
        mutationRef.current.browserSessionId !== scopeBrowserSessionId ||
        mutationRef.current.source !== source
      ) {
        mutationRef.current = {
          browserSessionId: scopeBrowserSessionId,
          source,
          count: 0,
          needsInventoryReconcile: false,
        };
      }
      mutationRef.current.count += 1;
      setState((current) =>
        isCurrentSource() &&
        current.source === source &&
        current.browserSessionId === scopeBrowserSessionId
          ? { ...current, mutating: true, error: null }
          : current,
      );
      try {
        return await operation(selectionRevision, readRequestId);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        // Selection observations share refresh ordering; physical mutations
        // keep their existing outcome admission.
        if (!selectionRead || requestRef.current.id === readRequestId) {
          setState((current) =>
            isCurrentSource() &&
            selectionRevisionRef.current === selectionRevision &&
            current.source === source &&
            current.browserSessionId === scopeBrowserSessionId
              ? { ...current, error }
              : current,
          );
        }
        throw error;
      } finally {
        if (
          mutationRef.current.browserSessionId === scopeBrowserSessionId &&
          mutationRef.current.source === source
        ) {
          if (
            changesInventory &&
            (selectionRevisionRef.current !== selectionRevision ||
              requestRef.current.id !== readRequestId)
          ) {
            mutationRef.current.needsInventoryReconcile = true;
          }
          mutationRef.current.count = Math.max(0, mutationRef.current.count - 1);
          const mutating = mutationRef.current.count > 0;
          setState((current) =>
            isCurrentSource() &&
            current.source === source &&
            current.browserSessionId === scopeBrowserSessionId
              ? { ...current, mutating }
              : current,
          );
          if (!mutating && mutationRef.current.needsInventoryReconcile && isCurrentSource()) {
            mutationRef.current.needsInventoryReconcile = false;
            // A superseded tab mutation still changed the real inventory. Wait
            // for all selections to settle, then reconcile without replacing
            // the latest selected-page observation or cancelling its read.
            void refreshInventory(false, false);
          }
        }
      }
    },
    [enabled, invalidateRefresh, isCurrentSource, refreshInventory, source],
  );

  const selectTarget = useCallback(
    async (targetId: string): Promise<BrowserTarget> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      return await runMutation(
        browserSessionId,
        async (selectionRevision, readRequestId) => {
          const isCurrentSelection = () =>
            isCurrentSource() && selectionRevisionRef.current === selectionRevision;
          // Once admitted, a queued observation survives immediate input.
          const isCurrentSelectionRead = () =>
            isCurrentSelection() && requestRef.current.id === readRequestId;
          let targets = visible.targets;
          let target: BrowserTarget;
          let observation: BrowserObservation;
          try {
            observation = await client.selectBrowserTarget(workspaceId, browserSessionId, targetId);
            target = observation.target;
          } catch (cause) {
            if (!isCurrentSelectionRead() || !isMissingBrowserTarget(cause)) throw cause;
            // A physical/attached tab may disappear between inventory and click.
            // Reconcile once from the authoritative controller inventory and move
            // to its live selected/first page instead of leaving a dead tab ID in
            // React state. Session-level 404s are deliberately not swallowed.
            const response = await client.listBrowserTargets(workspaceId, browserSessionId);
            if (!isCurrentSelectionRead()) throw cause;
            targets = response.targets;
            const fallback = chooseTarget(targets, null);
            if (!fallback) {
              selectedTargetIdRef.current = null;
              selectedTargetRef.current = null;
              observationRef.current = { browserSessionId, observation: null };
              setState((current) =>
                isCurrentSelection() &&
                current.source === source &&
                current.browserSessionId === browserSessionId
                  ? {
                      ...current,
                      targets,
                      selectedTargetId: null,
                      observation: null,
                    }
                  : current,
              );
              throw cause;
            }
            observation = await client.selectBrowserTarget(
              workspaceId,
              browserSessionId,
              fallback.id,
            );
            target = observation.target;
          }
          if (!isCurrentSelectionRead()) return target;
          selectedTargetIdRef.current = target.id;
          selectedTargetRef.current = target;
          observationRef.current = { browserSessionId, observation };
          lastObservationAtRef.current = Date.now();
          setState((current) =>
            isCurrentSelection() &&
            current.source === source &&
            current.browserSessionId === browserSessionId
              ? {
                  ...current,
                  targets: replaceTarget(targets, target).map((candidate) => ({
                    ...candidate,
                    selected: candidate.id === target.id,
                  })),
                  selectedTargetId: target.id,
                  observation,
                }
              : current,
          );
          return target;
        },
        true,
      );
    },
    [browserSessionId, client, isCurrentSource, runMutation, source, visible.targets, workspaceId],
  );

  const openTarget = useCallback(
    async (url?: string): Promise<BrowserTarget> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      return await runMutation(
        browserSessionId,
        async (selectionRevision, readRequestId) => {
          const isCurrentSelection = () =>
            isCurrentSource() && selectionRevisionRef.current === selectionRevision;
          const isCurrentSelectionRead = () =>
            isCurrentSelection() && requestRef.current.id === readRequestId;
          const observation = await client.openBrowserTarget(
            workspaceId,
            browserSessionId,
            url === undefined ? {} : { url },
          );
          const target = observation.target;
          if (!isCurrentSource()) return target;
          if (!isCurrentSelectionRead()) return target;
          selectedTargetIdRef.current = target.id;
          selectedTargetRef.current = target;
          observationRef.current = { browserSessionId, observation };
          lastObservationAtRef.current = Date.now();
          setState((current) =>
            isCurrentSelection() &&
            current.source === source &&
            current.browserSessionId === browserSessionId
              ? {
                  ...current,
                  targets: [
                    ...current.targets.map((candidate) => ({
                      ...candidate,
                      selected: false,
                    })),
                    target,
                  ],
                  selectedTargetId: target.id,
                  observation,
                }
              : current,
          );
          return target;
        },
        false,
        true,
      );
    },
    [browserSessionId, client, isCurrentSource, runMutation, source, workspaceId],
  );

  const closeTarget = useCallback(
    async (targetId: string): Promise<void> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      await runMutation(
        browserSessionId,
        async (selectionRevision, readRequestId) => {
          const isCurrentSelection = () =>
            isCurrentSource() && selectionRevisionRef.current === selectionRevision;
          const isCurrentSelectionRead = () =>
            isCurrentSelection() && requestRef.current.id === readRequestId;
          const response = await client.closeBrowserTarget(workspaceId, browserSessionId, targetId);
          if (!isCurrentSource()) return;
          if (!isCurrentSelectionRead()) return;
          const selected = chooseTarget(response.targets, selectedTargetIdRef.current);
          const observed = selected
            ? await client.observeBrowserTarget(workspaceId, browserSessionId, selected.id)
            : null;
          if (!isCurrentSource()) return;
          if (!isCurrentSelectionRead()) return;
          const observation =
            observed &&
            selected &&
            observed.browserSessionId === browserSessionId &&
            observed.target.id === selected.id &&
            observed.target.controllerGeneration === selected.controllerGeneration &&
            observed.target.targetGeneration === selected.targetGeneration
              ? observed
              : null;
          const currentTarget = observation?.target ?? selected;
          selectedTargetIdRef.current = currentTarget?.id ?? null;
          selectedTargetRef.current = currentTarget;
          observationRef.current = { browserSessionId, observation };
          if (observation) lastObservationAtRef.current = Date.now();
          setState((current) =>
            isCurrentSelection() &&
            current.source === source &&
            current.browserSessionId === browserSessionId
              ? {
                  ...current,
                  targets: currentTarget
                    ? replaceTarget(response.targets, currentTarget)
                    : response.targets,
                  selectedTargetId: currentTarget?.id ?? null,
                  observation,
                }
              : current,
          );
        },
        false,
        true,
      );
    },
    [browserSessionId, client, isCurrentSource, runMutation, source, workspaceId],
  );

  const dispatchAction = useCallback(
    async (
      action: BrowserAction | BrowserActionBatch,
      operationId: string,
      frame:
        | (Pick<
            BrowserFrame,
            "browserSessionId" | "controllerGeneration" | "targetId" | "targetGeneration"
          > & {
            frameId: string | null;
            documentGeneration: string | null;
          })
        | null,
      observationMode: "none" | "input" = "none",
    ): Promise<BrowserActionReceipt> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      if (!enabled || !isCurrentSource()) {
        throw new Error("The browser source is no longer selected.");
      }
      if (!selectedTargetRef.current) {
        throw new Error("The browser page is not ready for input.");
      }
      if (frame && frame.browserSessionId !== browserSessionId) {
        throw new Error("The displayed browser frame belongs to another BrowserSession.");
      }
      const currentObservation =
        observationRef.current.browserSessionId === browserSessionId
          ? observationRef.current.observation
          : null;
      const fence = frame
        ? {
            targetId: frame.targetId,
            expectedTargetGeneration: frame.targetGeneration,
            expectedDocumentGeneration: frame.documentGeneration,
            expectedFrameId: frame.frameId,
          }
        : currentObservation && sameObservationTarget(currentObservation, selectedTargetRef.current)
          ? {
              targetId: currentObservation.target.id,
              expectedTargetGeneration: currentObservation.target.targetGeneration,
              expectedDocumentGeneration: currentObservation.target.documentGeneration,
              expectedFrameId: currentObservation.frameId,
            }
          : null;
      if (!fence) {
        throw new Error("The browser page is not ready for input.");
      }
      const expectedControllerGeneration =
        frame?.controllerGeneration ?? currentObservation!.target.controllerGeneration;
      const selectionRevision = selectionRevisionRef.current;
      const resultOrder = ++actionResultOrderRef.current.next;
      let resultDocumentGeneration = fence.expectedDocumentGeneration;
      const isCurrentResultView = () => {
        const selected = selectedTargetRef.current;
        return (
          isCurrentSource() &&
          selectionRevisionRef.current === selectionRevision &&
          selected?.browserSessionId === browserSessionId &&
          selected.id === fence.targetId &&
          selected.controllerGeneration === expectedControllerGeneration &&
          selected.targetGeneration === fence.expectedTargetGeneration &&
          (selected.documentGeneration === fence.expectedDocumentGeneration ||
            selected.documentGeneration === resultDocumentGeneration)
        );
      };
      const canProjectResult = () =>
        isCurrentResultView() && resultOrder >= actionResultOrderRef.current.settled;
      const settleResult = () => {
        if (!canProjectResult()) return false;
        actionResultOrderRef.current.settled = resultOrder;
        invalidateRefresh();
        return true;
      };
      try {
        const receipt = await client.actInBrowser(workspaceId, browserSessionId, {
          operationId,
          ...fence,
          observationMode,
          action,
        });
        resultDocumentGeneration =
          receipt.observation?.target.documentGeneration ?? fence.expectedDocumentGeneration;
        const settled =
          receipt.state === "completed" ||
          receipt.state === "failed" ||
          receipt.state === "outcome_unknown";
        // Keep the operation result available to its caller, but an older
        // delivery cannot replace a newer settled view or input failure.
        if (!canProjectResult() || (settled && !settleResult())) return receipt;
        const receivedObservation = receipt.observation;
        const selectedTarget = selectedTargetRef.current;
        let projectedObservation: BrowserObservation | null = null;
        if (
          settled &&
          receivedObservation &&
          canProjectResult() &&
          receipt.browserSessionId === browserSessionId &&
          receipt.controllerGeneration === expectedControllerGeneration &&
          receipt.targetId === fence.targetId &&
          observationRef.current.browserSessionId === browserSessionId &&
          receivedObservation.browserSessionId === browserSessionId &&
          selectedTarget?.browserSessionId === browserSessionId &&
          selectedTarget.id === fence.targetId &&
          receivedObservation.target.id === fence.targetId &&
          selectedTarget.controllerGeneration === expectedControllerGeneration &&
          receivedObservation.target.controllerGeneration === expectedControllerGeneration &&
          selectedTarget.targetGeneration === fence.expectedTargetGeneration &&
          receivedObservation.target.targetGeneration === fence.expectedTargetGeneration &&
          (selectedTarget.documentGeneration === fence.expectedDocumentGeneration ||
            selectedTarget.documentGeneration === receivedObservation.target.documentGeneration)
        ) {
          // A receipt updates its own selected page only. Its operation outcome
          // remains available even when the human has moved to another page.
          projectedObservation = receivedObservation;
          observationRef.current = {
            browserSessionId,
            observation: receivedObservation,
          };
          selectedTargetRef.current = receivedObservation.target;
          lastObservationAtRef.current = Date.now();
        }
        setState((current) =>
          isCurrentResultView() &&
          current.source === source &&
          current.browserSessionId === browserSessionId &&
          current.actionResultOrder <= resultOrder
            ? {
                ...current,
                actionResultOrder: settled ? resultOrder : current.actionResultOrder,
                error: receipt.state === "completed" ? null : current.error,
                inputFailure:
                  receipt.state === "completed"
                    ? current.inputFailure
                    : {
                        operationId: receipt.operationId,
                        state: receipt.state,
                        error: receipt.error,
                      },
                ...(projectedObservation
                  ? {
                      observation: projectedObservation,
                      targets: replaceTarget(current.targets, projectedObservation.target),
                    }
                  : {}),
              }
            : current,
        );
        return receipt;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (settleResult()) {
          setState((current) =>
            isCurrentResultView() &&
            current.source === source &&
            current.browserSessionId === browserSessionId &&
            current.actionResultOrder <= resultOrder
              ? { ...current, error, actionResultOrder: resultOrder }
              : current,
          );
        }
        throw error;
      }
    },
    [browserSessionId, client, enabled, invalidateRefresh, isCurrentSource, source, workspaceId],
  );

  const act = useCallback(
    async (
      action: BrowserAction | BrowserActionBatch,
      operationId: string = crypto.randomUUID(),
    ): Promise<BrowserActionReceipt> => await dispatchAction(action, operationId, null),
    [dispatchAction],
  );

  const actFromFrame = useCallback(
    async (
      action: BrowserAction | BrowserActionBatch,
      frame: BrowserFrameInputFence,
      operationId: string = crypto.randomUUID(),
      observationMode: "none" | "input" = "none",
    ): Promise<BrowserActionReceipt> =>
      await dispatchAction(action, operationId, frame, observationMode),
    [dispatchAction],
  );

  const observeForInput = useCallback(async (): Promise<BrowserObservation> => {
    const target = selectedTargetRef.current;
    if (!enabled || !isCurrentSource()) {
      throw new Error("The browser source is no longer selected.");
    }
    if (!browserSessionId || !target) throw new Error("No browser tab is selected.");
    const observation = await client.observeBrowserTarget(workspaceId, browserSessionId, target.id);
    if (
      !isCurrentSource() ||
      observation.browserSessionId !== browserSessionId ||
      !sameObservationTarget(observation, selectedTargetRef.current)
    ) {
      throw new Error("The browser page changed. Open the options again.");
    }
    return observation;
  }, [browserSessionId, client, enabled, isCurrentSource, workspaceId]);

  const actFromObservation = useCallback(
    async (action: BrowserAction, observation: BrowserObservation) => {
      if (!sameObservationTarget(observation, selectedTargetRef.current)) {
        throw new Error("The browser page changed. Open the options again.");
      }
      return await dispatchAction(action, crypto.randomUUID(), {
        browserSessionId: observation.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: observation.target.id,
        targetGeneration: observation.target.targetGeneration,
        documentGeneration: observation.target.documentGeneration,
        frameId: observation.frameId,
      });
    },
    [dispatchAction],
  );

  const diagnostics = useCallback(
    async (diagnosticOptions: BrowserDiagnosticsOptions = {}): Promise<BrowserDiagnosticBatch> => {
      if (!enabled || !isCurrentSource()) {
        throw new Error("The browser source is no longer selected.");
      }
      const targetId = selectedTargetIdRef.current;
      if (!browserSessionId || !targetId) {
        throw new Error("No browser tab is selected.");
      }
      return await client.listBrowserDiagnostics(
        workspaceId,
        browserSessionId,
        targetId,
        diagnosticOptions,
      );
    },
    [browserSessionId, client, enabled, isCurrentSource, workspaceId],
  );

  const readClipboard = useCallback(async (): Promise<BrowserClipboard> => {
    if (!enabled || !isCurrentSource()) {
      throw new Error("The browser source is no longer selected.");
    }
    if (!browserSessionId) throw new Error("No BrowserSession is selected.");
    const clipboard = await client.readBrowserClipboard(workspaceId, browserSessionId);
    if (!isCurrentSource() || clipboard.browserSessionId !== browserSessionId) {
      throw new Error("Browser clipboard belongs to another BrowserSession.");
    }
    return clipboard;
  }, [browserSessionId, client, enabled, isCurrentSource, workspaceId]);

  return {
    session: visible.session,
    targets: visible.targets,
    selectedTarget:
      visible.targets.find((target) => target.id === visible.selectedTargetId) ?? null,
    observation: visible.observation,
    loading: visible.loading,
    mutating: visible.mutating,
    error: visible.error,
    inputFailure: visible.inputFailure,
    refresh,
    observeForInput,
    actFromObservation,
    selectTarget,
    openTarget,
    closeTarget,
    act,
    actFromFrame,
    readClipboard,
    diagnostics,
  };
}

function emptyState(browserSessionId: string | null, loading: boolean) {
  return {
    browserSessionId,
    session: null as BrowserSession | null,
    targets: [] as BrowserTarget[],
    selectedTargetId: null as string | null,
    observation: null as BrowserObservation | null,
    loading,
    mutating: false,
    error: null as Error | null,
    inputFailure: null as BrowserInputFailure | null,
    actionResultOrder: 0,
  };
}

function chooseTarget(
  targets: readonly BrowserTarget[],
  preferredId: string | null,
): BrowserTarget | null {
  return (
    targets.find((target) => target.id === preferredId) ??
    targets.find((target) => target.selected && target.kind === "page") ??
    targets.find((target) => target.kind === "page") ??
    targets[0] ??
    null
  );
}

function replaceTarget(targets: readonly BrowserTarget[], target: BrowserTarget): BrowserTarget[] {
  const next = targets.filter((candidate) => candidate.id !== target.id);
  next.push(target);
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function sameObservationTarget(
  observation: BrowserObservation,
  target: BrowserTarget | null,
): boolean {
  return (
    target !== null &&
    observation.browserSessionId === target.browserSessionId &&
    observation.target.id === target.id &&
    observation.target.controllerGeneration === target.controllerGeneration &&
    observation.target.targetGeneration === target.targetGeneration &&
    observation.target.documentGeneration === target.documentGeneration
  );
}

function isMissingBrowserTarget(error: unknown): boolean {
  return error instanceof OpenGeniApiError && error.code === "target_not_found";
}
