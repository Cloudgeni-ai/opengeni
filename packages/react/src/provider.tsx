import { ToolDetailsProvider } from "./timeline/tool-details";
import type { ToolDetails } from "./timeline/tool-presentation";
import {
  OpenGeniApiContractMismatchError,
  OPENGENI_API_CONTRACT_REVISION,
  type StreamConnectionState,
  type WorkspaceControlEvent,
  type WorkspaceInteractionRevisionEvent,
  type WorkspaceSessionListEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionClientLike } from "./client";
import { usePageLiveActivity } from "./hooks/internal";
import { useRetainedReads } from "./hooks/shared-query";
import { OpenGeniContext } from "./session-context";
import { ErrorMessageContext, type ErrorMessageFormatter } from "./lib/error-message";
import { joinClientConfigRead } from "./lib/client-config-read";
import {
  OpenGeniMessagesProvider,
  useOpenGeniText,
  type OpenGeniMessages,
} from "./messages/runtime";

export type { ErrorMessageFormatter } from "./lib/error-message";

export { useOpenGeni, useOpenGeniClient } from "./session-context";
export type { ClientOverride, OpenGeniContextValue } from "./session-context";
const CONTRACT_RELOAD_STORAGE_PREFIX = "opengeni.reloadForApiContract:";

export type OpenGeniProviderProps = {
  client: SessionClientLike;
  workspaceId: string;
  onWorkspaceControlEvent?: ((event: WorkspaceControlEvent) => void) | undefined;
  onWorkspaceInteractionEvent?: ((event: WorkspaceInteractionRevisionEvent) => void) | undefined;
  /**
   * Stale-tab protection for the stock Opengeni web app: when the server's API
   * contract revision differs from this bundle's, cover the page and reload it
   * once. Off by default, because an embedded product's page must never be
   * blocked or reloaded when Opengeni deploys; there a mismatch is ignored and
   * the SDK's tolerant-reader compatibility applies.
   */
  reloadOnApiContractChange?: boolean | undefined;
  /**
   * Keep subscription account lists and usage readings (`useCodexAccounts`,
   * `useSuperGrokAccounts`) and the last view of each conversation left (its
   * event tail and session projections) for `client` after the components that
   * read them unmount, so returning to them renders the last rows at once and
   * re-reads in the background. Off by default: then readers mounted together share one
   * request, but nothing is served to a later mount. Opt in only when every
   * signed-in person gets their own `client` object (the stock Opengeni console
   * creates a new client on every identity change). Retained rows are dropped
   * when `client` changes or this provider unmounts.
   */
  retainReadsAcrossMounts?: boolean | undefined;
  /** Host-owned error copy. Receives the original diagnostic error and neutral default copy. */
  formatError?: ErrorMessageFormatter | undefined;
  /**
   * BCP 47 locale of the host UI. Selects plural forms, and the language of dates,
   * times and numbers the components format. Defaults to the runtime locale.
   */
  locale?: string | undefined;
  /**
   * Your text for any subset of the catalog keys (see `englishMessages`), so every
   * component shows the host's own words and language. Missing keys fall back to English.
   */
  messages?: OpenGeniMessages | undefined;
  /**
   * The product name people know, shown wherever the built-in text names the product.
   * Default "Opengeni".
   */
  productName?: string | undefined;
  /**
   * How much of each tool call the chat shows. `"full"` (default) shows commands,
   * arguments, output and diffs. `"plain"` keeps every step visible with its plain
   * name and status but never shows raw arguments, output or JSON: for products
   * whose people are not developers.
   */
  toolDetails?: ToolDetails | undefined;
  children?: ReactNode;
};

/**
 * Supplies the Opengeni client + workspace to all hooks below it. Hooks also
 * accept `{ client, workspaceId }` overrides per call for multi-workspace UIs.
 */
export function OpenGeniProvider({
  client,
  workspaceId,
  onWorkspaceControlEvent,
  onWorkspaceInteractionEvent,
  reloadOnApiContractChange = false,
  retainReadsAcrossMounts = false,
  formatError,
  locale,
  messages,
  productName,
  toolDetails = "full",
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
  const [workspaceSessionListEvent, setWorkspaceSessionListEvent] =
    useState<WorkspaceSessionListEvent | null>(null);
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
    "streamWorkspaceLiveEvents" in client && typeof client.streamWorkspaceLiveEvents === "function";
  callbackRef.current = onWorkspaceControlEvent;
  interactionCallbackRef.current = onWorkspaceInteractionEvent;

  useRetainedReads(client, retainReadsAcrossMounts);

  const strictContract = reloadOnApiContractChange;
  const verifyApiContract = useCallback(async (): Promise<void> => {
    try {
      // Joins a config read already in flight (the conversation flags read the
      // same endpoint on mount) instead of sending a second request.
      const config = await joinClientConfigRead(client);
      if (strictContract && config.apiContractRevision !== OPENGENI_API_CONTRACT_REVISION) {
        throw new OpenGeniApiContractMismatchError(
          OPENGENI_API_CONTRACT_REVISION,
          String(config.apiContractRevision || "(missing)"),
        );
      }
    } catch (error) {
      if (error instanceof OpenGeniApiContractMismatchError) {
        // Embedded hosts: a revision difference is not a reason to block or reload the page.
        if (!strictContract) return;
        setContractMismatch(error);
        reloadForContractMismatchOnce(error);
      }
      throw error;
    }
  }, [client, strictContract]);

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
      (sessionId: string, options: { initialOpen?: boolean | undefined } = {}): Promise<void> => {
        const existing = reconcileInFlightRef.current.get(sessionId);
        if (existing) return existing;
        // This read also crosses the exact API-contract handshake before stale
        // state can be presented as live after a deployment.
        const promise = (async () => {
          await withTimeout(verifyApiContract(), 10_000, "API contract reconciliation");
          // Each projection was read alongside the tail this first open follows.
          if (options.initialOpen) return;
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
    setWorkspaceSessionListEvent(null);
    if (!pageLive) {
      setWorkspaceControlConnectionState("idle");
      setWorkspaceInteractionConnectionState("idle");
      return;
    }
    const controller = new AbortController();
    const setConnectionState = (state: StreamConnectionState) => {
      setWorkspaceControlConnectionState(state);
      setWorkspaceInteractionConnectionState(state);
      if (state !== "live") setWorkspaceSessionListEvent(null);
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
          } else if (event.type === "workspace.interaction.changed") {
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
          } else if (event.workspaceId === workspaceId) {
            setWorkspaceSessionListEvent(event);
          }
        }
      } catch (error) {
        if (strictContract && error instanceof OpenGeniApiContractMismatchError) {
          setContractMismatch(error);
          reloadForContractMismatchOnce(error);
        }
        if (!controller.signal.aborted) {
          setWorkspaceControlConnectionState("error");
          setWorkspaceInteractionConnectionState("error");
          setWorkspaceSessionListEvent(null);
        }
      }
    })();
    return () => controller.abort();
  }, [
    client,
    pageLive,
    strictContract,
    supportsWorkspaceLiveStream,
    verifyApiContract,
    workspaceId,
  ]);

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
        if (strictContract && error instanceof OpenGeniApiContractMismatchError) {
          setContractMismatch(error);
          reloadForContractMismatchOnce(error);
        }
        if (!controller.signal.aborted) setWorkspaceControlConnectionState("error");
      }
    })();
    return () => controller.abort();
  }, [
    client,
    pageLive,
    strictContract,
    supportsWorkspaceLiveStream,
    verifyApiContract,
    workspaceId,
  ]);

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
        if (strictContract && error instanceof OpenGeniApiContractMismatchError) {
          setContractMismatch(error);
          reloadForContractMismatchOnce(error);
        }
        if (!controller.signal.aborted) setWorkspaceInteractionConnectionState("error");
      }
    })();
    return () => controller.abort();
  }, [
    client,
    pageLive,
    strictContract,
    supportsWorkspaceLiveStream,
    verifyApiContract,
    workspaceId,
  ]);

  const value = useMemo(
    () => ({
      client,
      workspaceId,
      workspaceControlEvent,
      workspaceControlConnectionState,
      workspaceInteractionEvent,
      workspaceInteractionConnectionState,
      workspaceSessionListEvent,
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
      workspaceSessionListEvent,
      registerSessionReconciler,
      reconcileSession,
    ],
  );
  return (
    <OpenGeniMessagesProvider locale={locale} messages={messages} productName={productName}>
      <ErrorMessageContext.Provider value={formatError}>
        <OpenGeniContext.Provider value={value}>
          <ToolDetailsProvider value={toolDetails}>
            {children}
            {contractMismatch ? <ApiContractMismatchScreen mismatch={contractMismatch} /> : null}
          </ToolDetailsProvider>
        </OpenGeniContext.Provider>
      </ErrorMessageContext.Provider>
    </OpenGeniMessagesProvider>
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
  const t = useOpenGeniText();
  return (
    <div
      className="og-root fixed inset-0 z-[2147483647] grid place-items-center bg-og-bg/95 p-6 backdrop-blur-sm"
      role="alert"
      aria-live="assertive"
      data-opengeni-api-contract-mismatch
    >
      <div className="w-full max-w-md rounded-xl border border-og-border bg-og-surface p-6 shadow-2xl">
        <p className="text-og-menu font-semibold text-og-fg">{t("provider.opengeniUpdated")}</p>
        <p className="mt-2 text-og-menu leading-6 text-og-muted">
          {t("provider.thisTabCannotSafelyContinue")}
        </p>
        <p className="mt-3 font-mono text-og-control text-og-subtle">
          {t("provider.clientExpectedApiActual", {
            expected: mismatch.expected,
            actual: mismatch.actual,
          })}
        </p>
        <button
          type="button"
          className="mt-5 inline-flex h-9 items-center rounded-md border border-og-primary-border bg-og-primary text-og-primary-fg hover:bg-og-primary-hover px-3 text-og-menu font-medium"
          onClick={() => window.location.reload()}
        >
          {t("provider.reloadNow")}
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
