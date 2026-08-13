import {
  OpenGeniApiContractMismatchError,
  OPENGENI_API_CONTRACT_REVISION,
  type StreamConnectionState,
  type WorkspaceControlEvent,
  type WorkspaceInteractionRevisionEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionClientLike } from "./client";
import { usePageLiveActivity } from "./hooks/internal";
import { OpenGeniContext } from "./session-context";

export { useOpenGeni, useOpenGeniClient } from "./session-context";
export type { ClientOverride, OpenGeniContextValue } from "./session-context";
const CONTRACT_RELOAD_STORAGE_PREFIX = "opengeni.reloadForApiContract:";

export type OpenGeniProviderProps = {
  client: SessionClientLike;
  workspaceId: string;
  onWorkspaceControlEvent?: ((event: WorkspaceControlEvent) => void) | undefined;
  onWorkspaceInteractionEvent?: ((event: WorkspaceInteractionRevisionEvent) => void) | undefined;
  children?: ReactNode;
};

/**
 * Supplies the OpenGeni client + workspace to all hooks below it. Hooks also
 * accept `{ client, workspaceId }` overrides per call for multi-workspace UIs.
 */
export function OpenGeniProvider({
  client,
  workspaceId,
  onWorkspaceControlEvent,
  onWorkspaceInteractionEvent,
  children,
}: OpenGeniProviderProps) {
  const [workspaceControlEvent, setWorkspaceControlEvent] = useState<WorkspaceControlEvent | null>(
    null,
  );
  const [workspaceControlConnectionState, setWorkspaceControlConnectionState] = useState<
    StreamConnectionState | "idle" | "error"
  >("idle");
  const [workspaceInteractionEvent, setWorkspaceInteractionEvent] =
    useState<WorkspaceInteractionRevisionEvent | null>(null);
  const [workspaceInteractionConnectionState, setWorkspaceInteractionConnectionState] = useState<
    StreamConnectionState | "idle" | "error"
  >("idle");
  const [contractMismatch, setContractMismatch] = useState<OpenGeniApiContractMismatchError | null>(
    null,
  );
  const callbackRef = useRef(onWorkspaceControlEvent);
  const interactionCallbackRef = useRef(onWorkspaceInteractionEvent);
  const reconcilersRef = useRef(new Map<string, Map<string, () => Promise<void>>>());
  const reconcileInFlightRef = useRef(new Map<string, Promise<void>>());
  const workspaceControlSequencesRef = useRef(new Map<string, number>());
  const workspaceInteractionSequencesRef = useRef(new Map<string, number>());
  const pageLive = usePageLiveActivity();
  const supportsWorkspaceLiveStream =
    "streamWorkspaceLiveEvents" in client &&
    typeof client.streamWorkspaceLiveEvents === "function";
  callbackRef.current = onWorkspaceControlEvent;
  interactionCallbackRef.current = onWorkspaceInteractionEvent;

  const verifyApiContract = useCallback(async (): Promise<void> => {
    try {
      const config = await client.getClientConfig();
      if (config.apiContractRevision !== OPENGENI_API_CONTRACT_REVISION) {
        throw new OpenGeniApiContractMismatchError(
          OPENGENI_API_CONTRACT_REVISION,
          String(config.apiContractRevision || "(missing)"),
        );
      }
    } catch (error) {
      if (error instanceof OpenGeniApiContractMismatchError) {
        setContractMismatch(error);
        reloadForContractMismatchOnce(error);
      }
      throw error;
    }
  }, [client]);

  const registerSessionReconciler = useMemo(
    () =>
      (sessionId: string, key: string, reconcile: () => Promise<void>): (() => void) => {
        const sessionReconcilers = reconcilersRef.current.get(sessionId) ?? new Map();
        sessionReconcilers.set(key, reconcile);
        reconcilersRef.current.set(sessionId, sessionReconcilers);
        return () => {
          const current = reconcilersRef.current.get(sessionId);
          current?.delete(key);
          if (current?.size === 0) reconcilersRef.current.delete(sessionId);
        };
      },
    [],
  );
  const reconcileSession = useMemo(
    () =>
      (sessionId: string): Promise<void> => {
        const existing = reconcileInFlightRef.current.get(sessionId);
        if (existing) return existing;
        // This read also crosses the exact API-contract handshake before stale
        // state can be presented as live after a deployment.
        const promise = (async () => {
          await withTimeout(verifyApiContract(), 10_000, "API contract reconciliation");
          const callbacks = [...(reconcilersRef.current.get(sessionId)?.values() ?? [])];
          await withTimeout(
            Promise.all(callbacks.map((reconcile) => reconcile())).then(() => undefined),
            15_000,
            "session reconciliation",
          );
        })().finally(() => {
          if (reconcileInFlightRef.current.get(sessionId) === promise) {
            reconcileInFlightRef.current.delete(sessionId);
          }
        });
        reconcileInFlightRef.current.set(sessionId, promise);
        return promise;
      },
    [verifyApiContract],
  );

  useEffect(() => {
    if (!supportsWorkspaceLiveStream) return;
    const openLiveStream = client.streamWorkspaceLiveEvents!;
    setWorkspaceControlEvent(null);
    setWorkspaceInteractionEvent(null);
    if (!pageLive) {
      setWorkspaceControlConnectionState("idle");
      setWorkspaceInteractionConnectionState("idle");
      return;
    }
    const controller = new AbortController();
    const setConnectionState = (state: StreamConnectionState) => {
      setWorkspaceControlConnectionState(state);
      setWorkspaceInteractionConnectionState(state);
    };
    setConnectionState("connecting");
    void (async () => {
      try {
        await verifyApiContract();
        const workspace = await client.getWorkspace(workspaceId);
        const controlAfter = Math.max(
          workspaceControlSequencesRef.current.get(workspaceId) ?? 0,
          workspace.inferenceControl.revision,
        );
        const interactionAfter = workspaceInteractionSequencesRef.current.get(workspaceId) ?? 0;
        workspaceControlSequencesRef.current.set(workspaceId, controlAfter);
        const stream = openLiveStream.call(client, workspaceId, {
          controlAfter,
          interactionAfter,
          signal: controller.signal,
          onStateChange: setConnectionState,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          if (event.type === "workspace.control.changed") {
            workspaceControlSequencesRef.current.set(
              workspaceId,
              Math.max(workspaceControlSequencesRef.current.get(workspaceId) ?? 0, event.sequence),
            );
            setWorkspaceControlEvent((current) =>
              !current || event.sequence > current.sequence ? event : current,
            );
            callbackRef.current?.(event);
          } else {
            workspaceInteractionSequencesRef.current.set(
              workspaceId,
              Math.max(
                workspaceInteractionSequencesRef.current.get(workspaceId) ?? 0,
                event.sequence,
              ),
            );
            setWorkspaceInteractionEvent((current) =>
              !current || event.sequence > current.sequence ? event : current,
            );
            interactionCallbackRef.current?.(event);
          }
        }
      } catch (error) {
        if (error instanceof OpenGeniApiContractMismatchError) {
          setContractMismatch(error);
          reloadForContractMismatchOnce(error);
        }
        if (!controller.signal.aborted) {
          setWorkspaceControlConnectionState("error");
          setWorkspaceInteractionConnectionState("error");
        }
      }
    })();
    return () => controller.abort();
  }, [client, pageLive, supportsWorkspaceLiveStream, verifyApiContract, workspaceId]);

  useEffect(() => {
    if (supportsWorkspaceLiveStream) return;
    if (!pageLive) {
      setWorkspaceControlConnectionState("idle");
      return;
    }
    const controller = new AbortController();
    setWorkspaceControlConnectionState("connecting");
    void (async () => {
      try {
        await verifyApiContract();
        const workspace = await client.getWorkspace(workspaceId);
        const resumeAfter = Math.max(
          workspaceControlSequencesRef.current.get(workspaceId) ?? 0,
          workspace.inferenceControl.revision,
        );
        workspaceControlSequencesRef.current.set(workspaceId, resumeAfter);
        const stream = client.streamWorkspaceControlEvents(workspaceId, {
          after: resumeAfter,
          signal: controller.signal,
          onStateChange: setWorkspaceControlConnectionState,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          workspaceControlSequencesRef.current.set(
            workspaceId,
            Math.max(workspaceControlSequencesRef.current.get(workspaceId) ?? 0, event.sequence),
          );
          setWorkspaceControlEvent((current) =>
            !current || event.sequence > current.sequence ? event : current,
          );
          callbackRef.current?.(event);
        }
      } catch (error) {
        if (error instanceof OpenGeniApiContractMismatchError) {
          setContractMismatch(error);
          reloadForContractMismatchOnce(error);
        }
        if (!controller.signal.aborted) setWorkspaceControlConnectionState("error");
      }
    })();
    return () => controller.abort();
  }, [client, pageLive, supportsWorkspaceLiveStream, verifyApiContract, workspaceId]);

  useEffect(() => {
    if (supportsWorkspaceLiveStream) return;
    setWorkspaceInteractionEvent(null);
    if (!pageLive) {
      setWorkspaceInteractionConnectionState("idle");
      return;
    }
    const controller = new AbortController();
    setWorkspaceInteractionConnectionState("connecting");
    void (async () => {
      try {
        await verifyApiContract();
        const resumeAfter = workspaceInteractionSequencesRef.current.get(workspaceId) ?? 0;
        const stream = client.streamWorkspaceInteractionRevisions(workspaceId, {
          after: resumeAfter,
          signal: controller.signal,
          onStateChange: setWorkspaceInteractionConnectionState,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          workspaceInteractionSequencesRef.current.set(
            workspaceId,
            Math.max(
              workspaceInteractionSequencesRef.current.get(workspaceId) ?? 0,
              event.sequence,
            ),
          );
          setWorkspaceInteractionEvent((current) =>
            !current || event.sequence > current.sequence ? event : current,
          );
          interactionCallbackRef.current?.(event);
        }
      } catch (error) {
        if (error instanceof OpenGeniApiContractMismatchError) {
          setContractMismatch(error);
          reloadForContractMismatchOnce(error);
        }
        if (!controller.signal.aborted) setWorkspaceInteractionConnectionState("error");
      }
    })();
    return () => controller.abort();
  }, [client, pageLive, supportsWorkspaceLiveStream, verifyApiContract, workspaceId]);

  const value = useMemo(
    () => ({
      client,
      workspaceId,
      workspaceControlEvent,
      workspaceControlConnectionState,
      workspaceInteractionEvent,
      workspaceInteractionConnectionState,
      registerSessionReconciler,
      reconcileSession,
    }),
    [
      client,
      workspaceId,
      workspaceControlEvent,
      workspaceControlConnectionState,
      workspaceInteractionEvent,
      workspaceInteractionConnectionState,
      registerSessionReconciler,
      reconcileSession,
    ],
  );
  return (
    <OpenGeniContext.Provider value={value}>
      {children}
      {contractMismatch ? <ApiContractMismatchScreen mismatch={contractMismatch} /> : null}
    </OpenGeniContext.Provider>
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function ApiContractMismatchScreen({ mismatch }: { mismatch: OpenGeniApiContractMismatchError }) {
  return (
    <div
      className="og-root fixed inset-0 z-[2147483647] grid place-items-center bg-og-bg/95 p-6 backdrop-blur-sm"
      role="alert"
      aria-live="assertive"
      data-opengeni-api-contract-mismatch
    >
      <div className="w-full max-w-md rounded-xl border border-og-border bg-og-surface p-6 shadow-2xl">
        <p className="text-og-menu font-semibold text-og-fg">OpenGeni updated</p>
        <p className="mt-2 text-og-menu leading-6 text-og-muted">
          This tab cannot safely continue with the new server version. Reload it before sending or
          controlling work.
        </p>
        <p className="mt-3 font-mono text-og-control text-og-subtle">
          Client {mismatch.expected} · API {mismatch.actual}
        </p>
        <button
          type="button"
          className="mt-5 inline-flex h-9 items-center rounded-md bg-og-fg px-3 text-og-menu font-medium text-og-bg"
          onClick={() => window.location.reload()}
        >
          Reload now
        </button>
      </div>
    </div>
  );
}

function reloadForContractMismatchOnce(mismatch: OpenGeniApiContractMismatchError): void {
  if (typeof window === "undefined" || typeof sessionStorage === "undefined") return;
  const key = `${CONTRACT_RELOAD_STORAGE_PREFIX}${mismatch.actual}`;
  if (sessionStorage.getItem(key) === OPENGENI_API_CONTRACT_REVISION) return;
  sessionStorage.setItem(key, OPENGENI_API_CONTRACT_REVISION);
  window.setTimeout(() => window.location.reload(), 150);
}
