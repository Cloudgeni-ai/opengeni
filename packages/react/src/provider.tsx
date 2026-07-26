import {
  OpenGeniApiContractMismatchError,
  OPENGENI_API_CONTRACT_REVISION,
  type StreamConnectionState,
  type WorkspaceControlEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionClientLike } from "./client";
import { OpenGeniContext } from "./session-context";

export { useOpenGeni, useOpenGeniClient } from "./session-context";
export type { ClientOverride, OpenGeniContextValue } from "./session-context";
const CONTRACT_RELOAD_STORAGE_PREFIX = "opengeni.reloadForApiContract:";

export type OpenGeniProviderProps = {
  client: SessionClientLike;
  workspaceId: string;
  onWorkspaceControlEvent?: ((event: WorkspaceControlEvent) => void) | undefined;
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
  children,
}: OpenGeniProviderProps) {
  const [workspaceControlEvent, setWorkspaceControlEvent] = useState<WorkspaceControlEvent | null>(
    null,
  );
  const [workspaceControlConnectionState, setWorkspaceControlConnectionState] = useState<
    StreamConnectionState | "idle" | "error"
  >("idle");
  const [contractMismatch, setContractMismatch] = useState<OpenGeniApiContractMismatchError | null>(
    null,
  );
  const callbackRef = useRef(onWorkspaceControlEvent);
  const reconcilersRef = useRef(new Map<string, Map<string, () => Promise<void>>>());
  callbackRef.current = onWorkspaceControlEvent;

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
      async (sessionId: string): Promise<void> => {
        // This read also crosses the exact API-contract handshake before stale
        // state can be presented as live after a deployment.
        await verifyApiContract();
        const callbacks = [...(reconcilersRef.current.get(sessionId)?.values() ?? [])];
        await Promise.all(callbacks.map((reconcile) => reconcile()));
      },
    [verifyApiContract],
  );

  useEffect(() => {
    const controller = new AbortController();
    setWorkspaceControlEvent(null);
    setWorkspaceControlConnectionState("connecting");
    void (async () => {
      try {
        await verifyApiContract();
        const workspace = await client.getWorkspace(workspaceId);
        const stream = client.streamWorkspaceControlEvents(workspaceId, {
          after: workspace.inferenceControl.revision,
          signal: controller.signal,
          onStateChange: setWorkspaceControlConnectionState,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) return;
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
  }, [client, verifyApiContract, workspaceId]);

  const value = useMemo(
    () => ({
      client,
      workspaceId,
      workspaceControlEvent,
      workspaceControlConnectionState,
      registerSessionReconciler,
      reconcileSession,
    }),
    [
      client,
      workspaceId,
      workspaceControlEvent,
      workspaceControlConnectionState,
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

function ApiContractMismatchScreen({ mismatch }: { mismatch: OpenGeniApiContractMismatchError }) {
  return (
    <div
      className="og-root fixed inset-0 z-[2147483647] grid place-items-center bg-og-bg/95 p-6 backdrop-blur-sm"
      role="alert"
      aria-live="assertive"
      data-opengeni-api-contract-mismatch
    >
      <div className="w-full max-w-md rounded-xl border border-og-border bg-og-surface p-6 shadow-2xl">
        <p className="text-sm font-semibold text-og-fg">OpenGeni updated</p>
        <p className="mt-2 text-sm leading-6 text-og-muted">
          This tab cannot safely continue with the new server version. Reload it before sending or
          controlling work.
        </p>
        <p className="mt-3 font-mono text-xs text-og-subtle">
          Client {mismatch.expected} · API {mismatch.actual}
        </p>
        <button
          type="button"
          className="mt-5 inline-flex h-9 items-center rounded-md bg-og-fg px-3 text-sm font-medium text-og-bg"
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
