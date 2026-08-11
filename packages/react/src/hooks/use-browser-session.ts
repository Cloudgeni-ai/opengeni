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
import { usePageLiveActivity } from "./internal";

export type UseBrowserSessionOptions = EmbeddedBrowserInteractionClientOverride & {
  browserSessionId: string | null;
  enabled?: boolean | undefined;
  pollIntervalMs?: number | undefined;
};

export type UseBrowserSessionResult = {
  session: BrowserSession | null;
  targets: BrowserTarget[];
  selectedTarget: BrowserTarget | null;
  observation: BrowserObservation | null;
  loading: boolean;
  mutating: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
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
    frame: BrowserFrame,
    operationId?: string,
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
  const pageLive = usePageLiveActivity();
  const pollIntervalMs = Math.max(750, options.pollIntervalMs ?? 2_000);
  const [state, setState] = useState<{
    browserSessionId: string | null;
    session: BrowserSession | null;
    targets: BrowserTarget[];
    selectedTargetId: string | null;
    observation: BrowserObservation | null;
    loading: boolean;
    mutating: boolean;
    error: Error | null;
  }>(() => emptyState(browserSessionId, enabled));
  const visible =
    state.browserSessionId === browserSessionId ? state : emptyState(browserSessionId, enabled);
  const selectedTargetIdRef = useRef<string | null>(visible.selectedTargetId);
  selectedTargetIdRef.current = visible.selectedTargetId;
  const observationRef = useRef<{
    browserSessionId: string | null;
    observation: BrowserObservation | null;
  }>({ browserSessionId, observation: visible.observation });
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
    count: number;
  }>({
    browserSessionId,
    count: 0,
  });
  const mountedRef = useRef(true);

  const invalidateRefresh = useCallback(() => {
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    requestRef.current = { id, controller: null };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !browserSessionId) return;
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
      if (!mountedRef.current || requestRef.current.id !== id) return;
      const selected = chooseTarget(targetResponse.targets, selectedTargetIdRef.current);
      const observation = selected
        ? await client.observeBrowserTarget(workspaceId, browserSessionId, selected.id, {
            signal: controller.signal,
          })
        : null;
      if (!mountedRef.current || requestRef.current.id !== id) return;
      selectedTargetIdRef.current = selected?.id ?? null;
      observationRef.current = { browserSessionId, observation };
      setState((current) =>
        current.browserSessionId === browserSessionId
          ? {
              ...current,
              session,
              targets: targetResponse.targets,
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
  }, [browserSessionId, client, enabled, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      invalidateRefresh();
      setState(emptyState(browserSessionId, false));
      return;
    }
    setState((current) =>
      current.browserSessionId === browserSessionId
        ? { ...current, loading: true }
        : emptyState(browserSessionId, true),
    );
    void refresh();
    return () => {
      mountedRef.current = false;
      invalidateRefresh();
    };
  }, [browserSessionId, enabled, invalidateRefresh, refresh]);

  useEffect(() => {
    if (!enabled || !pageLive || visible.mutating) return;
    const timer = setInterval(() => {
      if (!requestRef.current.controller) void refresh();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, pageLive, pollIntervalMs, refresh, visible.mutating]);

  useEffect(() => {
    if (!enabled || !browserSessionId || !pageLive) return;
    let disposed = false;
    const heartbeat = () => {
      void client.heartbeatBrowserSession(workspaceId, browserSessionId).catch(() => {
        if (!disposed) void refresh();
      });
    };
    const timer = setInterval(heartbeat, 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [browserSessionId, client, enabled, pageLive, refresh, workspaceId]);

  const runMutation = useCallback(
    async <T>(scopeBrowserSessionId: string, operation: () => Promise<T>): Promise<T> => {
      invalidateRefresh();
      if (mutationRef.current.browserSessionId !== scopeBrowserSessionId) {
        mutationRef.current = {
          browserSessionId: scopeBrowserSessionId,
          count: 0,
        };
      }
      mutationRef.current.count += 1;
      setState((current) =>
        current.browserSessionId === scopeBrowserSessionId
          ? { ...current, mutating: true, error: null }
          : current,
      );
      try {
        return await operation();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((current) =>
          current.browserSessionId === scopeBrowserSessionId ? { ...current, error } : current,
        );
        throw error;
      } finally {
        if (mutationRef.current.browserSessionId === scopeBrowserSessionId) {
          mutationRef.current.count = Math.max(0, mutationRef.current.count - 1);
          const mutating = mutationRef.current.count > 0;
          setState((current) =>
            current.browserSessionId === scopeBrowserSessionId ? { ...current, mutating } : current,
          );
        }
      }
    },
    [invalidateRefresh],
  );

  const selectTarget = useCallback(
    async (targetId: string): Promise<BrowserTarget> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      return await runMutation(browserSessionId, async () => {
        let targets = visible.targets;
        let target: BrowserTarget;
        let observation: BrowserObservation;
        try {
          target = await client.selectBrowserTarget(workspaceId, browserSessionId, targetId);
          observation = await client.observeBrowserTarget(workspaceId, browserSessionId, target.id);
        } catch (cause) {
          if (!isMissingBrowserTarget(cause)) throw cause;
          // A physical/attached tab may disappear between inventory and click.
          // Reconcile once from the authoritative controller inventory and move
          // to its live selected/first page instead of leaving a dead tab ID in
          // React state. Session-level 404s are deliberately not swallowed.
          const response = await client.listBrowserTargets(workspaceId, browserSessionId);
          targets = response.targets;
          const fallback = chooseTarget(targets, null);
          if (!fallback) {
            selectedTargetIdRef.current = null;
            observationRef.current = { browserSessionId, observation: null };
            setState((current) =>
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
          target = await client.selectBrowserTarget(workspaceId, browserSessionId, fallback.id);
          observation = await client.observeBrowserTarget(workspaceId, browserSessionId, target.id);
        }
        selectedTargetIdRef.current = target.id;
        observationRef.current = { browserSessionId, observation };
        setState((current) =>
          current.browserSessionId === browserSessionId
            ? {
                ...current,
                targets: targets.map((candidate) => ({
                  ...candidate,
                  selected: candidate.id === target.id,
                })),
                selectedTargetId: target.id,
                observation,
              }
            : current,
        );
        return target;
      });
    },
    [browserSessionId, client, runMutation, visible.targets, workspaceId],
  );

  const openTarget = useCallback(
    async (url?: string): Promise<BrowserTarget> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      return await runMutation(browserSessionId, async () => {
        const target = await client.openBrowserTarget(
          workspaceId,
          browserSessionId,
          url === undefined ? {} : { url },
        );
        const observation = await client.observeBrowserTarget(
          workspaceId,
          browserSessionId,
          target.id,
        );
        selectedTargetIdRef.current = target.id;
        observationRef.current = { browserSessionId, observation };
        setState((current) =>
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
      });
    },
    [browserSessionId, client, runMutation, workspaceId],
  );

  const closeTarget = useCallback(
    async (targetId: string): Promise<void> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      await runMutation(browserSessionId, async () => {
        const response = await client.closeBrowserTarget(workspaceId, browserSessionId, targetId);
        const selected = chooseTarget(response.targets, null);
        const observation = selected
          ? await client.observeBrowserTarget(workspaceId, browserSessionId, selected.id)
          : null;
        selectedTargetIdRef.current = selected?.id ?? null;
        observationRef.current = { browserSessionId, observation };
        setState((current) =>
          current.browserSessionId === browserSessionId
            ? {
                ...current,
                targets: response.targets,
                selectedTargetId: selected?.id ?? null,
                observation,
              }
            : current,
        );
      });
    },
    [browserSessionId, client, runMutation, workspaceId],
  );

  const dispatchAction = useCallback(
    async (
      action: BrowserAction | BrowserActionBatch,
      operationId: string,
      frame: BrowserFrame | null,
    ): Promise<BrowserActionReceipt> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
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
        : currentObservation
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
      return await runMutation(browserSessionId, async () => {
        const receipt = await client.actInBrowser(workspaceId, browserSessionId, {
          operationId,
          ...fence,
          action,
        });
        if (receipt.observation) {
          observationRef.current = {
            browserSessionId,
            observation: receipt.observation,
          };
          setState((current) =>
            current.browserSessionId === browserSessionId
              ? {
                  ...current,
                  observation: receipt.observation,
                  targets: replaceTarget(current.targets, receipt.observation!.target),
                }
              : current,
          );
        } else {
          void refresh();
        }
        return receipt;
      });
    },
    [browserSessionId, client, refresh, runMutation, workspaceId],
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
      frame: BrowserFrame,
      operationId: string = crypto.randomUUID(),
    ): Promise<BrowserActionReceipt> => await dispatchAction(action, operationId, frame),
    [dispatchAction],
  );

  const diagnostics = useCallback(
    async (diagnosticOptions: BrowserDiagnosticsOptions = {}): Promise<BrowserDiagnosticBatch> => {
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
    [browserSessionId, client, workspaceId],
  );

  const readClipboard = useCallback(async (): Promise<BrowserClipboard> => {
    if (!browserSessionId) throw new Error("No BrowserSession is selected.");
    const clipboard = await client.readBrowserClipboard(workspaceId, browserSessionId);
    if (clipboard.browserSessionId !== browserSessionId) {
      throw new Error("Browser clipboard belongs to another BrowserSession.");
    }
    return clipboard;
  }, [browserSessionId, client, workspaceId]);

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

function isMissingBrowserTarget(error: unknown): boolean {
  return error instanceof OpenGeniApiError && error.code === "target_not_found";
}
