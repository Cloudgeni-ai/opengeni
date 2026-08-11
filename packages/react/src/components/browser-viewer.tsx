import type {
  AttachedBrowserDevice,
  BrowserAction,
  BrowserActionReceipt,
  BrowserDiagnosticBatch,
  BrowserDownload,
  BrowserDownloadSaveResponse,
  BrowserFrame,
  BrowserIdentity,
  BrowserObservation,
  BrowserSession,
  BrowserTarget,
  ComputerSession,
  InteractionIntervention,
  InteractionSemanticNode,
} from "@opengeni/sdk/interaction";
import {
  BugIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  DownloadIcon,
  FileCheck2Icon,
  Globe2Icon,
  LoaderCircleIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  UserRoundIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import {
  type FormEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useBrowserFrameStream,
  type BrowserFrameWebSocketFactory,
} from "../hooks/use-browser-frame-stream";
import { useAttachedBrowsers } from "../hooks/use-attached-browsers";
import { useBrowserIdentities } from "../hooks/use-browser-identities";
import { useBrowserDownloads } from "../hooks/use-browser-downloads";
import { useBrowserSession } from "../hooks/use-browser-session";
import { useBrowserSessions } from "../hooks/use-browser-sessions";
import { useInteractionInterventions } from "../hooks/use-interaction-interventions";
import { cn } from "../lib/cn";
import { copyTextToClipboard } from "../lib/clipboard";
import { formatBytes } from "../lib/format";
import type { EmbeddedBrowserInteractionClientOverride } from "../session-context";
import { InteractionInterventionBanner } from "./interaction-intervention-banner";

export type BrowserViewerNotification = {
  kind: "error" | "info";
  message: string;
};

export type BrowserViewerProps = EmbeddedBrowserInteractionClientOverride & {
  /** The selected OpenGeni agent/session. Peer BrowserSessions stay discoverable. */
  sessionId: string;
  enabled?: boolean | undefined;
  className?: string | undefined;
  onNotify?: ((notification: BrowserViewerNotification) => void) | undefined;
  /** Tests/demos only. Production uses the browser's native WebSocket. */
  webSocketFactory?: BrowserFrameWebSocketFactory | undefined;
  renderEmpty?: ((create: () => void, creating: boolean) => ReactNode) | undefined;
  /** Optional host capability for a headed managed browser. Browser-only
   * embedders remain valid and create headless sessions instead. */
  createLinkedComputer?:
    | ((name: string) => Promise<Pick<ComputerSession, "id" | "placement">>)
    | undefined;
  /** Navigate to the exact linked ComputerSession; never a lookalike desktop. */
  onOpenComputer?: ((computerSessionId: string) => void) | undefined;
};

type BrowserSelection = { sessionId: string; pinned: boolean } | null;
type BrowserLaunchChoice =
  | { kind: "clean" }
  | { kind: "fast" }
  | { kind: "profile"; identityId: string }
  | { kind: "attached"; device: AttachedBrowserDevice };
type PointerStart = {
  x: number;
  y: number;
  pointerId: number;
  frame: BrowserFrame;
};
type BrowserResumeAttempt = {
  operationId: string;
  running: boolean;
  terminal: boolean;
  error: Error | null;
};
type BrowserDiagnosticsView = {
  browserSessionId: string;
  targetId: string;
  loading: boolean;
  batch: BrowserDiagnosticBatch | null;
  error: Error | null;
};

/**
 * Complete browser-native session surface: workspace discovery, agent relevance,
 * browser/tab switching, live frames, semantic fallback, direct human input,
 * address navigation, diagnostics, and reconnect. Closing it never closes the browser.
 */
export function BrowserViewer({
  sessionId,
  enabled = true,
  className,
  onNotify,
  webSocketFactory,
  renderEmpty,
  createLinkedComputer,
  onOpenComputer,
  ...override
}: BrowserViewerProps) {
  const registry = useBrowserSessions({ ...override, sessionId, enabled });
  const attached = useAttachedBrowsers({ ...override, enabled });
  const profiles = useBrowserIdentities({ ...override, enabled });
  const createRegistryBrowser = registry.create;
  const loadProfileRevisions = profiles.revisions;
  const liveSessions = useMemo(
    () => registry.sessions.filter((session) => isLiveBrowser(session)),
    [registry.sessions],
  );
  const relevant = useMemo(
    () => registry.relevantSessions.filter((session) => isLiveBrowser(session)),
    [registry.relevantSessions],
  );
  const [selection, setSelection] = useState<BrowserSelection>(null);
  const interventions = useInteractionInterventions({
    ...override,
    enabled,
    resourceKind: "browser_session",
  });
  const [creating, setCreating] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [baseRevisionOrdinal, setBaseRevisionOrdinal] = useState<number | null>(null);
  const [resumeAttempt, setResumeAttempt] = useState<{
    sessionId: string;
    attempt: BrowserResumeAttempt;
  } | null>(null);
  const resumeAttemptsRef = useRef(new Map<string, BrowserResumeAttempt>());
  const previousSessionIdRef = useRef(sessionId);
  const seenInterventionIdsRef = useRef(new Set<string>());
  const diagnosticRequestRef = useRef(0);
  const [diagnosticsView, setDiagnosticsView] = useState<BrowserDiagnosticsView | null>(null);

  const notifyError = useCallback(
    (cause: unknown, fallback: string) => {
      const message = cause instanceof Error ? cause.message : fallback;
      onNotify?.({ kind: "error", message });
    },
    [onNotify],
  );

  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      setSelection(null);
    }
  }, [sessionId]);

  useEffect(() => {
    const selectedStillLive = liveSessions.some((session) => session.id === selection?.sessionId);
    const preferred = relevant[0] ?? liveSessions[0] ?? null;
    if (!preferred) {
      if (selection) setSelection(null);
      return;
    }
    if (!selectedStillLive || !selection?.pinned) {
      if (selection?.sessionId !== preferred.id || selection.pinned) {
        setSelection({ sessionId: preferred.id, pinned: false });
      }
    }
  }, [liveSessions, relevant, selection]);

  const selectedRegistrySession = useMemo(
    () => liveSessions.find((session) => session.id === selection?.sessionId) ?? null,
    [liveSessions, selection?.sessionId],
  );
  const interventionCounts = useMemo(
    () => countInterventions(interventions.interventions),
    [interventions.interventions],
  );
  const selectedInterventions = useMemo(
    () =>
      interventions.interventions.filter(
        (intervention) => intervention.resourceId === selection?.sessionId,
      ),
    [interventions.interventions, selection?.sessionId],
  );
  const controllerReady = selectedRegistrySession?.lifecycle === "active";
  const resumeSession = registry.resume;

  const wakeBrowser = useCallback(
    async (session: BrowserSession, retry = false): Promise<void> => {
      const current = resumeAttemptsRef.current.get(session.id);
      if (current?.running || (!retry && current)) return;
      const operationId = current && !current.terminal ? current.operationId : crypto.randomUUID();
      const attempt: BrowserResumeAttempt = {
        operationId,
        running: true,
        terminal: false,
        error: null,
      };
      resumeAttemptsRef.current.set(session.id, attempt);
      setResumeAttempt({ sessionId: session.id, attempt });
      try {
        const response = await resumeSession(session.id, operationId);
        if (response.operation.state !== "completed") {
          throw Object.assign(
            new Error(response.operation.error?.message ?? "Browser could not reopen."),
            { terminal: true },
          );
        }
        resumeAttemptsRef.current.delete(session.id);
        setResumeAttempt((visible) => (visible?.sessionId === session.id ? null : visible));
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const failed: BrowserResumeAttempt = {
          operationId,
          running: false,
          terminal:
            typeof cause === "object" && cause !== null && "terminal" in cause
              ? cause.terminal === true
              : false,
          error,
        };
        resumeAttemptsRef.current.set(session.id, failed);
        setResumeAttempt({ sessionId: session.id, attempt: failed });
        notifyError(error, "Could not reopen this browser.");
      }
    },
    [notifyError, resumeSession],
  );

  useEffect(() => {
    if (!selectedRegistrySession) return;
    if (selectedRegistrySession.lifecycle === "active") {
      resumeAttemptsRef.current.delete(selectedRegistrySession.id);
      setResumeAttempt((visible) =>
        visible?.sessionId === selectedRegistrySession.id ? null : visible,
      );
      return;
    }
    if (selectedRegistrySession.lifecycle === "suspended") {
      void wakeBrowser(selectedRegistrySession);
    }
  }, [selectedRegistrySession, wakeBrowser]);

  const browser = useBrowserSession({
    ...override,
    browserSessionId: selection?.sessionId ?? null,
    enabled: enabled && selection !== null && controllerReady,
  });
  const downloads = useBrowserDownloads({
    ...override,
    browserSessionId: selection?.sessionId ?? null,
    enabled:
      enabled &&
      diagnosticsView !== null &&
      controllerReady &&
      browser.session?.capabilities.downloads === true,
  });
  const loadBrowserDiagnostics = browser.diagnostics;

  useEffect(() => {
    for (const intervention of interventions.interventions) {
      if (seenInterventionIdsRef.current.has(intervention.id)) continue;
      seenInterventionIdsRef.current.add(intervention.id);
      onNotify?.({
        kind: "info",
        message: `${interventionTitle(intervention)}: ${intervention.reason}`,
      });
    }
  }, [interventions.interventions, onNotify]);

  const resolveIntervention = useCallback(
    (intervention: InteractionIntervention, outcome: "completed" | "dismissed") => {
      void interventions
        .resolve(intervention.id, {
          expectedVersion: intervention.version,
          outcome,
        })
        .then(() => {
          onNotify?.({
            kind: "info",
            message:
              outcome === "completed" ? "Agent notified. Continuing work." : "Request cancelled.",
          });
        })
        .catch((cause) => notifyError(cause, "Could not update the browser request."));
    },
    [interventions, notifyError, onNotify],
  );
  const frames = useBrowserFrameStream({
    ...override,
    browserSessionId: selection?.sessionId ?? null,
    targetId: browser.selectedTarget?.id ?? null,
    enabled:
      enabled &&
      selection !== null &&
      controllerReady &&
      browser.selectedTarget !== null &&
      browser.session?.capabilities.liveFrames === true,
    stream: { format: "jpeg", quality: 76, maxWidth: 1_920, maxHeight: 1_200 },
    ...(webSocketFactory ? { webSocketFactory } : {}),
  });
  const displayedFrame = frameMatchesObservation(frames.frame, browser.observation)
    ? frames.frame
    : null;
  const supportsLiveFrames = browser.session?.capabilities.liveFrames === true;
  const displayConnectionState = supportsLiveFrames
    ? frames.state === "live" && !displayedFrame
      ? "connecting"
      : frames.state
    : "semantic";
  const selectedProfile = useMemo(
    () =>
      profiles.identities.find(
        (identity) =>
          identity.id === (browser.session?.identityId ?? selectedRegistrySession?.identityId),
      ) ?? null,
    [browser.session?.identityId, profiles.identities, selectedRegistrySession?.identityId],
  );

  useEffect(() => {
    diagnosticRequestRef.current += 1;
    setDiagnosticsView(null);
  }, [browser.session?.id, browser.selectedTarget?.id]);

  const loadDiagnostics = useCallback(() => {
    const browserSessionId = browser.session?.id;
    const targetId = browser.selectedTarget?.id;
    if (!browserSessionId || !targetId) return;
    const requestId = diagnosticRequestRef.current + 1;
    diagnosticRequestRef.current = requestId;
    setDiagnosticsView((current) => ({
      browserSessionId,
      targetId,
      loading: true,
      batch:
        current?.browserSessionId === browserSessionId && current.targetId === targetId
          ? current.batch
          : null,
      error: null,
    }));
    void loadBrowserDiagnostics({ limit: 100 })
      .then((batch) => {
        if (diagnosticRequestRef.current !== requestId) return;
        setDiagnosticsView({ browserSessionId, targetId, loading: false, batch, error: null });
      })
      .catch((cause) => {
        if (diagnosticRequestRef.current !== requestId) return;
        setDiagnosticsView({
          browserSessionId,
          targetId,
          loading: false,
          batch: null,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      });
  }, [browser.selectedTarget?.id, browser.session?.id, loadBrowserDiagnostics]);

  const closeDiagnostics = useCallback(() => {
    diagnosticRequestRef.current += 1;
    setDiagnosticsView(null);
  }, []);

  const refreshDiagnostics = useCallback(() => {
    loadDiagnostics();
    if (browser.session?.capabilities.downloads) void downloads.refresh();
  }, [browser.session?.capabilities.downloads, downloads, loadDiagnostics]);

  const saveDownload = useCallback(
    async (
      downloadId: string,
      destinationPath: string,
      overwrite: boolean,
    ): Promise<BrowserDownloadSaveResponse> => {
      const response = await downloads.saveToWorkspace(downloadId, destinationPath, { overwrite });
      onNotify?.({
        kind: "info",
        message: `${response.download.filename} saved to ${response.destinationPath}.`,
      });
      return response;
    },
    [downloads, onNotify],
  );

  useEffect(() => {
    const identityId = browser.session?.identityId ?? selectedRegistrySession?.identityId;
    const revisionId = browser.session?.baseRevisionId ?? selectedRegistrySession?.baseRevisionId;
    if (!identityId || !revisionId) {
      setBaseRevisionOrdinal(null);
      return;
    }
    let disposed = false;
    setBaseRevisionOrdinal(null);
    void loadProfileRevisions(identityId)
      .then((response) => {
        if (!disposed) {
          setBaseRevisionOrdinal(
            response.revisions.find((revision) => revision.id === revisionId)?.ordinal ?? null,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [
    browser.session?.baseRevisionId,
    browser.session?.identityId,
    loadProfileRevisions,
    selectedRegistrySession?.baseRevisionId,
    selectedRegistrySession?.identityId,
  ]);

  const createBrowser = useCallback(
    (choice: BrowserLaunchChoice = { kind: "clean" }) => {
      if (creating) return;
      const identity =
        choice.kind === "profile"
          ? profiles.identities.find((candidate) => candidate.id === choice.identityId)
          : null;
      const device = choice.kind === "attached" ? choice.device : null;
      const fast = choice.kind === "fast";
      const browserName =
        device?.profileLabel ??
        device?.name ??
        (identity ? `${identity.name} browser` : fast ? "Fast browser" : "Browser");
      setCreating(true);
      void (async () => {
        const linkedComputer =
          !device && !fast && createLinkedComputer
            ? await createLinkedComputer(`${browserName} computer`)
            : null;
        const response = await createRegistryBrowser({
          sessionId,
          name: browserName,
          ...(fast ? { engine: "lightpanda" as const, headless: true } : {}),
          ...(device
            ? {
                headless: false,
                placement: {
                  kind: "attached_device" as const,
                  deviceId: device.id,
                },
              }
            : {}),
          ...(linkedComputer
            ? {
                headless: false,
                linkedComputerSessionId: linkedComputer.id,
                placement: linkedComputer.placement,
              }
            : {}),
          ...(identity ? { identityId: identity.id } : {}),
        });
        setSelection({ sessionId: response.session.id, pinned: true });
      })()
        .catch((cause) => notifyError(cause, "Could not open a browser."))
        .finally(() => setCreating(false));
    },
    [
      createLinkedComputer,
      createRegistryBrowser,
      creating,
      notifyError,
      profiles.identities,
      sessionId,
    ],
  );

  const saveProfileVersion = useCallback(
    async (newProfileName?: string): Promise<boolean> => {
      const session = browser.session;
      if (!session || savingProfile || !session.capabilities.identityPublication) return false;
      setSavingProfile(true);
      try {
        let identity = selectedProfile;
        if (!identity) {
          const name = newProfileName?.trim() ?? "";
          if (!name) return false;
          identity = (await profiles.create({ name })).identity;
        }
        const response = await profiles.publish(session.id, {
          identityId: identity.id,
          expectedHeadGeneration: identity.headGeneration,
          advanceDefault: true,
        });
        setBaseRevisionOrdinal(response.revision.ordinal);
        await Promise.all([browser.refresh(), registry.refresh()]);
        onNotify?.({
          kind: "info",
          message:
            response.outcome === "saved_as_default"
              ? `${response.identity.name} version ${response.revision.ordinal} saved for future browsers.`
              : `${response.identity.name} version ${response.revision.ordinal} saved. Another version remains the default.`,
        });
        return true;
      } catch (cause) {
        notifyError(cause, "Could not save this browser profile.");
        return false;
      } finally {
        setSavingProfile(false);
      }
    },
    [browser, notifyError, onNotify, profiles, registry, savingProfile, selectedProfile],
  );

  if (!enabled) return null;
  if (registry.loading && liveSessions.length === 0) {
    return (
      <BrowserNotice
        icon={<LoaderCircleIcon className="animate-spin" />}
        text="Finding browsers…"
        {...(className ? { className } : {})}
      />
    );
  }
  if (liveSessions.length === 0) {
    if (renderEmpty) return <>{renderEmpty(() => createBrowser(), creating)}</>;
    return (
      <div
        className={cn("flex h-full min-h-0 items-center justify-center bg-og-bg p-6", className)}
      >
        <div className="max-w-sm text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-og-md border border-og-border bg-og-surface-1 text-og-muted">
            <Globe2Icon className="size-4.5" />
          </span>
          <p className="mt-3 text-og-menu font-medium text-og-fg">No browser open</p>
          <p className="mt-1 text-og-control leading-5 text-og-muted">
            A browser appears here when this agent—or another agent in the workspace—opens one.
          </p>
          <BrowserLaunchMenu
            attachedDevices={attached.devices}
            identities={profiles.identities}
            creating={creating}
            onCreate={createBrowser}
            prominent
          />
          {registry.error ? (
            <p className="mt-3 text-og-control text-og-status-error">{registry.error.message}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("relative flex h-full min-h-0 flex-col overflow-hidden bg-og-bg", className)}
    >
      <BrowserToolbar
        sessions={liveSessions}
        relevantSessionIds={new Set(relevant.map((session) => session.id))}
        selectedSessionId={selection?.sessionId ?? null}
        identities={profiles.identities}
        attachedDevices={attached.devices}
        selectedProfile={selectedProfile}
        baseRevisionOrdinal={baseRevisionOrdinal}
        creating={creating}
        savingProfile={savingProfile}
        refreshing={registry.refreshing || attached.refreshing}
        interventionCounts={interventionCounts}
        onSelect={(browserSessionId) => setSelection({ sessionId: browserSessionId, pinned: true })}
        onFollow={() => {
          const preferred = relevant[0];
          if (preferred) setSelection({ sessionId: preferred.id, pinned: false });
        }}
        onCreate={createBrowser}
        onSaveProfile={saveProfileVersion}
        onRefresh={() => void Promise.all([registry.refresh(), attached.refresh()])}
      />
      <InteractionInterventionBanner
        interventions={selectedInterventions}
        activeTargetId={browser.selectedTarget?.id ?? null}
        mutating={interventions.mutating}
        onOpen={(intervention) =>
          void browser
            .selectTarget(intervention.targetId)
            .catch((cause) => notifyError(cause, "Could not open the requested browser tab."))
        }
        onResolve={resolveIntervention}
      />
      {selectedRegistrySession && !controllerReady ? (
        <BrowserLifecyclePanel
          session={selectedRegistrySession}
          attempt={
            resumeAttempt?.sessionId === selectedRegistrySession.id ? resumeAttempt.attempt : null
          }
          onResume={() => void wakeBrowser(selectedRegistrySession, true)}
        />
      ) : (
        <>
          <BrowserTabs
            targets={browser.targets}
            selectedTargetId={browser.selectedTarget?.id ?? null}
            mutating={browser.mutating || savingProfile}
            tabControl={browser.session?.capabilities.tabs === true}
            onSelect={(targetId) =>
              void browser
                .selectTarget(targetId)
                .catch((cause) => notifyError(cause, "Could not switch tabs."))
            }
            onClose={(targetId) =>
              void browser
                .closeTarget(targetId)
                .catch((cause) => notifyError(cause, "Could not close the tab."))
            }
            onOpen={() =>
              void browser
                .openTarget()
                .catch((cause) => notifyError(cause, "Could not open a tab."))
            }
          />
          <BrowserAddressBar
            target={browser.selectedTarget}
            loading={browser.loading || browser.mutating || savingProfile}
            onNavigate={(url) =>
              void browser
                .act({ type: "navigate", url })
                .catch((cause) => notifyError(cause, "Could not navigate."))
            }
            onReload={() => {
              const url = browser.selectedTarget?.url;
              if (url)
                void browser
                  .act({ type: "navigate", url })
                  .catch((cause) => notifyError(cause, "Could not reload."));
            }}
          />
          <BrowserViewport
            frame={displayedFrame}
            connectionState={displayConnectionState}
            supportsLiveFrames={supportsLiveFrames}
            connectionError={frames.error}
            observation={browser.observation}
            mutating={browser.mutating || savingProfile}
            activityLabel={savingProfile ? "Saving browser version…" : undefined}
            clipboardEnabled={browser.session?.capabilities.clipboard === true}
            onAction={async (action, frame) => {
              const receipt = frame
                ? await browser.actFromFrame(action, frame)
                : await browser.act(action);
              if (receipt.state !== "completed") {
                throw new Error(receipt.error?.message ?? "Browser input did not complete.");
              }
              return receipt;
            }}
            onReadClipboard={browser.readClipboard}
            onReconnect={frames.reconnect}
            onError={(cause) => notifyError(cause, "Browser input failed.")}
          />
          <BrowserStatusBar
            session={browser.session}
            profile={selectedProfile}
            target={browser.selectedTarget}
            observation={browser.observation}
            connectionState={displayConnectionState}
            refreshing={registry.refreshing}
            diagnosticsOpen={diagnosticsView !== null}
            onOpenComputer={
              browser.session?.linkedComputerSessionId && onOpenComputer
                ? () => {
                    const computerSessionId = browser.session?.linkedComputerSessionId;
                    if (computerSessionId) onOpenComputer(computerSessionId);
                  }
                : undefined
            }
            onDiagnostics={diagnosticsView ? closeDiagnostics : loadDiagnostics}
          />
        </>
      )}
      {diagnosticsView ? (
        <BrowserDiagnosticsDrawer
          session={browser.session}
          profile={selectedProfile}
          target={browser.selectedTarget}
          observation={browser.observation}
          baseRevisionOrdinal={baseRevisionOrdinal}
          state={diagnosticsView}
          downloads={downloads.downloads}
          downloadsEnabled={browser.session?.capabilities.downloads === true}
          downloadsLoading={downloads.loading}
          downloadsRefreshing={downloads.refreshing}
          downloadsError={downloads.error}
          savingDownloadIds={downloads.savingDownloadIds}
          onSaveDownload={saveDownload}
          onRefreshDownloads={() => void downloads.refresh()}
          onRefresh={refreshDiagnostics}
          onClose={closeDiagnostics}
        />
      ) : null}
    </div>
  );
}

function BrowserLifecyclePanel(props: {
  session: BrowserSession;
  attempt: BrowserResumeAttempt | null;
  onResume: () => void;
}) {
  const failed = props.attempt?.error ?? null;
  const label = failed
    ? "Browser could not reopen"
    : props.session.lifecycle === "suspending"
      ? "Saving browser state…"
      : props.session.lifecycle === "restoring" || props.attempt?.running
        ? "Opening browser…"
        : props.session.lifecycle === "starting"
          ? "Starting browser…"
          : "Browser is sleeping";
  const detail = failed
    ? failed.message
    : props.session.lifecycle === "suspended"
      ? "Its private state is saved. Opening it creates a fresh, isolated browser process."
      : "The browser will reconnect here when it is ready.";
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-og-bg p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-10 place-items-center rounded-og-md border border-og-border bg-og-surface-1 text-og-muted">
          {failed ? (
            <CircleAlertIcon className="size-4.5 text-og-status-error" />
          ) : (
            <LoaderCircleIcon className="size-4.5 animate-spin" />
          )}
        </span>
        <p className="mt-3 text-og-menu font-medium text-og-fg">{label}</p>
        <p className="mt-1 text-og-control leading-5 text-og-muted">{detail}</p>
        {failed || (props.session.lifecycle === "suspended" && !props.attempt?.running) ? (
          <button
            type="button"
            onClick={props.onResume}
            className="mt-4 inline-flex h-8 items-center rounded-og-sm border border-og-border bg-og-surface-1 px-3 text-og-control font-medium text-og-fg transition hover:bg-og-surface-2"
          >
            Open browser
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BrowserToolbar(props: {
  sessions: BrowserSession[];
  relevantSessionIds: Set<string>;
  selectedSessionId: string | null;
  attachedDevices: AttachedBrowserDevice[];
  identities: BrowserIdentity[];
  selectedProfile: BrowserIdentity | null;
  baseRevisionOrdinal: number | null;
  creating: boolean;
  savingProfile: boolean;
  refreshing: boolean;
  interventionCounts: Map<string, number>;
  onSelect: (id: string) => void;
  onFollow: () => void;
  onCreate: (choice?: BrowserLaunchChoice) => void;
  onSaveProfile: (newProfileName?: string) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const selected = props.sessions.find((session) => session.id === props.selectedSessionId);
  const current = props.sessions.filter((session) => props.relevantSessionIds.has(session.id));
  const others = props.sessions.filter((session) => !props.relevantSessionIds.has(session.id));
  const choose = (id: string) => {
    props.onSelect(id);
    detailsRef.current?.removeAttribute("open");
  };
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-og-border bg-og-surface-0 px-2">
      <details ref={detailsRef} className="relative min-w-0">
        <summary className="flex h-7 max-w-52 cursor-pointer list-none items-center gap-2 rounded-og-sm px-2 text-og-control text-og-fg transition hover:bg-og-surface-2 [&::-webkit-details-marker]:hidden">
          <Globe2Icon className="size-3.5 shrink-0 text-og-muted" />
          <span className="truncate font-medium">{selected?.name ?? "Browser"}</span>
          {(props.interventionCounts.get(selected?.id ?? "") ?? 0) > 0 ? (
            <span className="size-1.5 shrink-0 rounded-full bg-og-status-waiting" />
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0 text-og-subtle" />
        </summary>
        <div className="absolute left-0 top-8 z-30 w-72 overflow-hidden rounded-og-md border border-og-border bg-og-surface-1 p-1 shadow-xl">
          <BrowserSessionGroup
            label="Current agent"
            sessions={current}
            identities={props.identities}
            selectedId={props.selectedSessionId}
            interventionCounts={props.interventionCounts}
            onSelect={choose}
          />
          <BrowserSessionGroup
            label="Other agents"
            sessions={others}
            identities={props.identities}
            selectedId={props.selectedSessionId}
            interventionCounts={props.interventionCounts}
            onSelect={choose}
          />
          <div className="mt-1 flex gap-1 border-t border-og-border pt-1">
            {current.length > 0 ? (
              <MenuButton onClick={props.onFollow}>Follow agent</MenuButton>
            ) : null}
            <MenuButton onClick={() => props.onCreate()} disabled={props.creating}>
              <PlusIcon className="size-3.5" /> New browser
            </MenuButton>
          </div>
        </div>
      </details>
      <span className="min-w-0 flex-1 truncate text-og-xs text-og-subtle">
        {placementLabel(selected)}
      </span>
      <BrowserProfileMenu
        session={selected ?? null}
        identity={props.selectedProfile}
        baseRevisionOrdinal={props.baseRevisionOrdinal}
        saving={props.savingProfile}
        onSave={props.onSaveProfile}
      />
      <button
        type="button"
        onClick={props.onRefresh}
        className="grid size-7 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg"
        aria-label="Refresh browsers"
      >
        <RefreshCwIcon className={cn("size-3.5", props.refreshing && "animate-spin")} />
      </button>
      <BrowserLaunchMenu
        attachedDevices={props.attachedDevices}
        identities={props.identities}
        creating={props.creating}
        onCreate={props.onCreate}
      />
    </div>
  );
}

function BrowserSessionGroup(props: {
  label: string;
  sessions: BrowserSession[];
  identities: BrowserIdentity[];
  selectedId: string | null;
  interventionCounts: Map<string, number>;
  onSelect: (id: string) => void;
}) {
  if (props.sessions.length === 0) return null;
  return (
    <div className="py-1">
      <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-og-subtle">
        {props.label}
      </p>
      {props.sessions.map((session) => {
        const identity = props.identities.find((candidate) => candidate.id === session.identityId);
        const interventionCount = props.interventionCounts.get(session.id) ?? 0;
        return (
          <button
            key={session.id}
            type="button"
            onClick={() => props.onSelect(session.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-og-sm px-2 py-1.5 text-left transition hover:bg-og-surface-2",
              session.id === props.selectedId && "bg-og-surface-2",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                session.lifecycle === "active" ? "bg-og-status-running" : "bg-og-muted",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-og-control text-og-fg">{session.name}</span>
              <span className="block truncate text-og-xs text-og-subtle">
                {identity ? `${identity.name} · ` : ""}
                {placementLabel(session)}
              </span>
            </span>
            {interventionCount > 0 ? (
              <span className="rounded-full bg-og-status-waiting/12 px-1.5 py-0.5 text-[10px] font-medium text-og-status-waiting">
                {interventionCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function BrowserLaunchMenu(props: {
  attachedDevices: AttachedBrowserDevice[];
  identities: BrowserIdentity[];
  creating: boolean;
  onCreate: (choice?: BrowserLaunchChoice) => void;
  prominent?: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const choose = (choice?: BrowserLaunchChoice) => {
    detailsRef.current?.removeAttribute("open");
    props.onCreate(choice);
  };
  return (
    <details ref={detailsRef} className={cn("relative", props.prominent && "mt-4 inline-block")}>
      <summary
        onClick={(event) => {
          if (props.creating) event.preventDefault();
        }}
        className={cn(
          "cursor-pointer list-none items-center justify-center gap-1.5 text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg [&::-webkit-details-marker]:hidden",
          props.prominent
            ? "inline-flex h-8 rounded-og-sm border border-og-border bg-og-surface-1 px-3 text-og-control font-medium text-og-fg"
            : "grid size-7 place-items-center rounded-og-sm",
          props.creating && "pointer-events-none opacity-50",
        )}
        aria-label="New browser"
      >
        {props.creating ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <PlusIcon className="size-3.5" />
        )}
        {props.prominent ? "New browser" : null}
        {props.prominent ? <ChevronDownIcon className="size-3" /> : null}
      </summary>
      <div
        className={cn(
          "absolute z-40 w-72 overflow-hidden rounded-og-md border border-og-border bg-og-surface-1 p-1 text-left shadow-xl",
          props.prominent ? "left-1/2 top-10 -translate-x-1/2" : "right-0 top-8",
        )}
      >
        {props.attachedDevices.length > 0 ? (
          <div className="pb-1">
            <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-og-subtle">
              Connected Chrome
            </p>
            {props.attachedDevices.map((device) => (
              <button
                key={device.id}
                type="button"
                onClick={() => choose({ kind: "attached", device })}
                className="flex w-full items-center gap-2 rounded-og-sm px-2 py-2 text-left transition hover:bg-og-surface-2"
              >
                <MonitorIcon className="size-3.5 shrink-0 text-og-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-og-control text-og-fg">
                    {device.profileLabel ?? device.name}
                  </span>
                  <span className="block truncate text-og-xs text-og-subtle">
                    {device.browserName} · {device.tabCount} open{" "}
                    {device.tabCount === 1 ? "tab" : "tabs"}
                  </span>
                </span>
                <span className="size-1.5 shrink-0 rounded-full bg-og-status-running" />
              </button>
            ))}
          </div>
        ) : null}
        <p
          className={cn(
            "px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-og-subtle",
            props.attachedDevices.length > 0 && "border-t border-og-border",
          )}
        >
          Open isolated browser
        </p>
        <button
          type="button"
          onClick={() => choose({ kind: "clean" })}
          className="flex w-full items-center gap-2 rounded-og-sm px-2 py-2 text-left transition hover:bg-og-surface-2"
        >
          <Globe2Icon className="size-3.5 text-og-muted" />
          <span>
            <span className="block text-og-control text-og-fg">Clean browser</span>
            <span className="block text-og-xs text-og-subtle">No saved profile</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => choose({ kind: "fast" })}
          className="flex w-full items-center gap-2 rounded-og-sm px-2 py-2 text-left transition hover:bg-og-surface-2"
        >
          <ZapIcon className="size-3.5 text-og-muted" />
          <span>
            <span className="block text-og-control text-og-fg">Fast semantic browser</span>
            <span className="block text-og-xs text-og-subtle">Headless · optimized for agents</span>
          </span>
        </button>
        {props.identities.length > 0 ? (
          <div className="mt-1 border-t border-og-border pt-1">
            {props.identities.map((identity) => (
              <button
                key={identity.id}
                type="button"
                onClick={() => choose({ kind: "profile", identityId: identity.id })}
                className="flex w-full items-center gap-2 rounded-og-sm px-2 py-2 text-left transition hover:bg-og-surface-2"
              >
                <UserRoundIcon className="size-3.5 text-og-muted" />
                <span className="min-w-0">
                  <span className="block truncate text-og-control text-og-fg">{identity.name}</span>
                  <span className="block text-og-xs text-og-subtle">
                    {identity.defaultRevisionId
                      ? `${identity.revisionCount} saved version${identity.revisionCount === 1 ? "" : "s"}`
                      : "Ready for first sign-in"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function BrowserProfileMenu(props: {
  session: BrowserSession | null;
  identity: BrowserIdentity | null;
  baseRevisionOrdinal: number | null;
  saving: boolean;
  onSave: (newProfileName?: string) => Promise<boolean>;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const nameInputId = useId();
  const [name, setName] = useState("");
  const attached = props.session?.placement.kind === "attached_device";
  const canSave = props.session?.capabilities.identityPublication ?? false;
  const save = async (newProfileName?: string) => {
    if (await props.onSave(newProfileName)) {
      setName("");
      detailsRef.current?.removeAttribute("open");
    }
  };
  const versionLabel = attached
    ? "live"
    : props.identity
      ? props.baseRevisionOrdinal
        ? `v${props.baseRevisionOrdinal}`
        : props.session?.baseRevisionId
          ? "saved"
          : "unsaved"
      : "temporary";
  return (
    <details ref={detailsRef} className="relative min-w-0">
      <summary className="flex h-7 max-w-40 cursor-pointer list-none items-center gap-1.5 rounded-og-sm px-2 text-og-xs text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg [&::-webkit-details-marker]:hidden">
        {props.saving ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : attached ? (
          <MonitorIcon className="size-3" />
        ) : (
          <UserRoundIcon className="size-3" />
        )}
        <span className="truncate">
          {attached ? props.session?.name : (props.identity?.name ?? "Temporary")}
        </span>
        {attached || props.identity ? (
          <span className="shrink-0 text-og-subtle">· {versionLabel}</span>
        ) : null}
        <ChevronDownIcon className="size-3 shrink-0 text-og-subtle" />
      </summary>
      <div className="absolute right-0 top-8 z-40 w-72 rounded-og-md border border-og-border bg-og-surface-1 p-3 shadow-xl">
        <div className="flex items-start gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-og-sm bg-og-surface-2 text-og-muted">
            {attached ? (
              <MonitorIcon className="size-3.5" />
            ) : (
              <UserRoundIcon className="size-3.5" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-og-control font-medium text-og-fg">
              {attached ? props.session?.name : (props.identity?.name ?? "Temporary browser")}
            </p>
            <p className="mt-0.5 text-og-xs leading-4 text-og-subtle">
              {attached
                ? "This session drives the existing Chrome profile and its current login state."
                : props.identity
                  ? props.baseRevisionOrdinal
                    ? `Started from version ${props.baseRevisionOrdinal}.`
                    : "Not saved yet."
                  : "This browser is not reusable yet."}
            </p>
          </div>
        </div>
        {canSave ? (
          props.identity ? (
            <button
              type="button"
              onClick={() => void save()}
              disabled={props.saving}
              className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-og-sm border border-og-border bg-og-surface-2 px-3 text-og-control font-medium text-og-fg transition hover:bg-og-surface-3 disabled:opacity-50"
            >
              {props.saving ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <SaveIcon className="size-3.5" />
              )}
              {props.saving ? "Saving browser version…" : "Save new version"}
            </button>
          ) : (
            <form
              className="mt-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) void save(name);
              }}
            >
              <label className="text-og-xs font-medium text-og-muted" htmlFor={nameInputId}>
                Profile name
              </label>
              <div className="mt-1 flex gap-1.5">
                <input
                  id={nameInputId}
                  value={name}
                  onInput={(event) => setName(event.currentTarget.value)}
                  maxLength={200}
                  placeholder="Work"
                  className="h-8 min-w-0 flex-1 rounded-og-sm border border-og-border bg-og-bg px-2 text-og-control text-og-fg placeholder:text-og-subtle focus:border-og-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent"
                />
                <button
                  type="submit"
                  disabled={!name.trim() || props.saving}
                  className="inline-flex h-8 items-center gap-1 rounded-og-sm bg-og-accent px-2.5 text-og-control font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                >
                  {props.saving ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <SaveIcon className="size-3.5" />
                  )}
                  Save
                </button>
              </div>
            </form>
          )
        ) : (
          <p className="mt-3 rounded-og-sm bg-og-surface-2 px-2.5 py-2 text-og-xs text-og-subtle">
            {attached
              ? "Chrome keeps this profile's state directly; OpenGeni does not copy it automatically."
              : "This browser cannot save reusable profile state."}
          </p>
        )}
        {canSave ? (
          <p className="mt-2 text-[10px] leading-4 text-og-subtle">
            Saving briefly restarts this browser. Other open browsers are unchanged.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function MenuButton(props: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex h-7 flex-1 items-center justify-center gap-1 rounded-og-sm px-2 text-og-control text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-50"
    >
      {props.children}
    </button>
  );
}

function BrowserTabs(props: {
  targets: BrowserTarget[];
  selectedTargetId: string | null;
  mutating: boolean;
  tabControl: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
}) {
  const pages = props.targets.filter((target) => target.kind === "page" || target.kind === "popup");
  return (
    <div className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-og-border bg-og-surface-0 px-1 pt-1">
      {pages.map((target) => (
        <div
          key={target.id}
          className={cn(
            "group flex h-8 min-w-24 max-w-48 items-center rounded-t-og-sm border border-b-0 border-transparent px-2",
            target.id === props.selectedTargetId
              ? "border-og-border bg-og-bg text-og-fg"
              : "text-og-muted hover:bg-og-surface-1",
          )}
        >
          <button
            type="button"
            onClick={() => props.onSelect(target.id)}
            className="min-w-0 flex-1 truncate text-left text-og-control"
          >
            {target.title || shortUrl(target.url)}
          </button>
          {props.tabControl ? (
            <button
              type="button"
              onClick={() => props.onClose(target.id)}
              disabled={props.mutating}
              className="ml-1 grid size-4 shrink-0 place-items-center rounded opacity-0 transition hover:bg-og-surface-3 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30"
              aria-label={`Close ${target.title || "tab"}`}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
      {props.tabControl ? (
        <button
          type="button"
          onClick={props.onOpen}
          disabled={props.mutating}
          className="mb-1 grid size-6 shrink-0 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-40"
          aria-label="New tab"
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function BrowserAddressBar(props: {
  target: BrowserTarget | null;
  loading: boolean;
  onNavigate: (url: string) => void;
  onReload: () => void;
}) {
  const [draft, setDraft] = useState(props.target?.url ?? "");
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(props.target?.url ?? "");
  }, [props.target?.id, props.target?.url]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeBrowserAddress(draft);
    if (normalized) props.onNavigate(normalized);
  };
  return (
    <form
      onSubmit={submit}
      className="flex h-10 shrink-0 items-center gap-1.5 border-b border-og-border bg-og-bg px-2"
    >
      <button
        type="button"
        onClick={props.onReload}
        disabled={!props.target || props.loading}
        className="grid size-7 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-35"
        aria-label="Reload"
      >
        <RefreshCwIcon className={cn("size-3.5", props.loading && "animate-spin")} />
      </button>
      <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-og-sm border border-og-border bg-og-surface-0 px-2 focus-within:border-og-accent/60">
        <Globe2Icon className="size-3 shrink-0 text-og-subtle" />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
          }}
          disabled={!props.target}
          className="min-w-0 flex-1 bg-transparent text-og-control text-og-fg placeholder:text-og-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent disabled:opacity-50"
          aria-label="Address"
          spellCheck={false}
          placeholder="Search or enter address"
        />
      </div>
    </form>
  );
}

function BrowserViewport(props: {
  frame: BrowserFrame | null;
  connectionState: string;
  supportsLiveFrames: boolean;
  connectionError: Error | null;
  observation: ReturnType<typeof useBrowserSession>["observation"];
  mutating: boolean;
  clipboardEnabled: boolean;
  activityLabel?: string | undefined;
  onAction: (action: BrowserAction, frame: BrowserFrame | null) => Promise<BrowserActionReceipt>;
  onReadClipboard: () => Promise<{ text: string }>;
  onReconnect: () => void;
  onError: (cause: unknown) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const pointerStartRef = useRef<PointerStart | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickRef = useRef<{
    at: number;
    x: number;
    y: number;
    frame: BrowserFrame;
  } | null>(null);
  const wheelRef = useRef<{
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    frame: BrowserFrame;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const actionRef = useRef(props.onAction);
  const readClipboardRef = useRef(props.onReadClipboard);
  const errorRef = useRef(props.onError);
  const actionTailRef = useRef<Promise<void>>(Promise.resolve());
  actionRef.current = props.onAction;
  readClipboardRef.current = props.onReadClipboard;
  errorRef.current = props.onError;

  useEffect(() => {
    const frame = props.frame;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const blob = new Blob([frame.data.slice().buffer], {
          type: frame.mediaType,
        });
        if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(blob);
          if (cancelled) {
            bitmap.close();
            return;
          }
          paintCanvas(canvas, bitmap, frame.width, frame.height);
          bitmap.close();
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        const image = await loadImage(objectUrl);
        if (!cancelled) paintCanvas(canvas, image, frame.width, frame.height);
      } catch (cause) {
        if (!cancelled) errorRef.current(cause);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.frame]);

  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      if (wheelRef.current?.timer) clearTimeout(wheelRef.current.timer);
    },
    [],
  );

  const enqueue = useCallback(
    (
      action: BrowserAction,
      frame: BrowserFrame | null,
      after?: (receipt: BrowserActionReceipt) => Promise<void>,
    ) => {
      actionTailRef.current = actionTailRef.current
        .catch(() => undefined)
        .then(async () => {
          const receipt = await actionRef.current(action, frame);
          await after?.(receipt);
        })
        .catch((cause) => errorRef.current(cause));
    },
    [],
  );

  const point = useCallback(
    (frame: BrowserFrame, clientX: number, clientY: number) =>
      browserPoint(canvasRef.current, frame, clientX, clientY),
    [],
  );

  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!props.frame || props.mutating) return;
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      frame: props.frame,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    inputRef.current?.focus({ preventScroll: true });
  };

  const pointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const from = point(start.frame, start.x, start.y);
    const to = point(start.frame, event.clientX, event.clientY);
    if (!from || !to) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
      enqueue(
        {
          type: "pointer",
          action: "drag",
          x: from.x,
          y: from.y,
          endX: to.x,
          endY: to.y,
        },
        start.frame,
      );
      return;
    }
    const now = Date.now();
    const previous = lastClickRef.current;
    if (
      previous &&
      now - previous.at < 280 &&
      Math.hypot(previous.x - to.x, previous.y - to.y) < 6 &&
      sameFrameFence(previous.frame, start.frame)
    ) {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      lastClickRef.current = null;
      enqueue({ type: "pointer", action: "double_click", x: to.x, y: to.y }, start.frame);
      return;
    }
    lastClickRef.current = { at: now, x: to.x, y: to.y, frame: start.frame };
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      lastClickRef.current = null;
      enqueue({ type: "pointer", action: "click", x: to.x, y: to.y }, start.frame);
    }, 280);
  };

  const contextMenu = (event: MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const frame = props.frame;
    if (!frame) return;
    const at = point(frame, event.clientX, event.clientY);
    if (at) enqueue({ type: "pointer", action: "click", x: at.x, y: at.y, button: "right" }, frame);
  };

  const wheel = (event: WheelEvent<HTMLCanvasElement>) => {
    const frame = props.frame;
    if (!frame) return;
    const at = point(frame, event.clientX, event.clientY);
    if (!at) return;
    event.preventDefault();
    const pending = wheelRef.current;
    if (pending?.timer) clearTimeout(pending.timer);
    wheelRef.current = {
      x: at.x,
      y: at.y,
      deltaX: (pending && sameFrameFence(pending.frame, frame) ? pending.deltaX : 0) + event.deltaX,
      deltaY: (pending && sameFrameFence(pending.frame, frame) ? pending.deltaY : 0) + event.deltaY,
      frame,
      timer: setTimeout(() => {
        const batch = wheelRef.current;
        wheelRef.current = null;
        if (batch)
          enqueue(
            {
              type: "pointer",
              action: "scroll",
              x: batch.x,
              y: batch.y,
              deltaX: batch.deltaX,
              deltaY: batch.deltaY,
            },
            batch.frame,
          );
      }, 45),
    };
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const command = event.metaKey || event.ctrlKey;
    if (
      props.clipboardEnabled &&
      command &&
      !event.altKey &&
      ["c", "v"].includes(event.key.toLowerCase())
    ) {
      return;
    }
    const key = browserKey(event);
    if (!key) return;
    event.preventDefault();
    enqueue({ type: "press", key }, props.frame);
  };

  const copy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.clipboardEnabled) return;
    event.preventDefault();
    enqueue({ type: "clipboard", operation: "copy" }, props.frame, async () => {
      const clipboard = await readClipboardRef.current();
      if (clipboard.text.length === 0) return;
      if (!(await copyTextToClipboard(clipboard.text))) {
        throw new Error("Browser text could not be copied to the local clipboard");
      }
    });
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.clipboardEnabled) return;
    event.preventDefault();
    enqueue(
      {
        type: "clipboard",
        operation: "paste",
        text: event.clipboardData.getData("text/plain"),
      },
      props.frame,
    );
  };

  const input = (value: string, nativeComposing = false) => {
    if (composingRef.current || nativeComposing) return;
    if (!value) return;
    enqueue({ type: "type", text: value }, props.frame);
    if (inputRef.current) inputRef.current.value = "";
  };

  const compositionStart = () => {
    composingRef.current = true;
  };

  const compositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    input(event.currentTarget.value || event.data);
  };

  const showCanvas = props.frame !== null;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className={cn(
          "absolute inset-0 m-auto max-h-full max-w-full touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent",
          !showCanvas && "invisible",
        )}
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          pointerStartRef.current = null;
        }}
        onContextMenu={contextMenu}
        onWheel={wheel}
        aria-label="Interactive browser page"
      />
      <textarea
        ref={inputRef}
        defaultValue=""
        onInput={(event) =>
          input(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing)
        }
        onCompositionStart={compositionStart}
        onCompositionEnd={compositionEnd}
        onKeyDown={keyDown}
        onCopy={copy}
        onPaste={paste}
        className="pointer-events-none absolute left-1/2 top-1/2 size-px resize-none overflow-hidden opacity-0"
        aria-label="Browser keyboard input"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {!showCanvas ? (
        <SemanticBrowserFallback
          observation={props.observation}
          connectionState={props.connectionState}
          supportsLiveFrames={props.supportsLiveFrames}
          error={props.connectionError}
          onAction={(action) => enqueue(action, null)}
          onReconnect={props.onReconnect}
        />
      ) : null}
      {props.mutating ? (
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-[11px] text-white/80 backdrop-blur">
          <LoaderCircleIcon className="size-3 animate-spin" /> {props.activityLabel ?? "Acting"}
        </div>
      ) : null}
    </div>
  );
}

function SemanticBrowserFallback(props: {
  observation: ReturnType<typeof useBrowserSession>["observation"];
  connectionState: string;
  supportsLiveFrames: boolean;
  error: Error | null;
  onAction: (action: BrowserAction) => void;
  onReconnect: () => void;
}) {
  const nodes = semanticNodes(
    props.observation?.semantic?.kind === "snapshot" ? props.observation.semantic.roots : [],
  );
  const interactive = nodes.filter((node) => node.actions.includes("click")).slice(0, 8);
  return (
    <div className="absolute inset-0 grid place-items-center bg-og-bg p-6">
      <div className="w-full max-w-md rounded-og-lg border border-og-border bg-og-surface-0 p-4 shadow-lg">
        <div className="flex items-center gap-2">
          {props.error ? (
            <CircleAlertIcon className="size-4 text-og-status-error" />
          ) : !props.supportsLiveFrames ? (
            <ZapIcon className="size-4 text-og-muted" />
          ) : (
            <LoaderCircleIcon className="size-4 animate-spin text-og-muted" />
          )}
          <p className="text-og-menu font-medium text-og-fg">
            {props.error
              ? "Live view disconnected"
              : props.supportsLiveFrames
                ? browserConnectionLabel(props.connectionState)
                : "Semantic browser"}
          </p>
        </div>
        {interactive.length > 0 ? (
          <div className="mt-3 border-t border-og-border pt-3">
            <p className="mb-2 text-og-xs text-og-subtle">
              {props.supportsLiveFrames
                ? "Page controls remain available"
                : "Available page controls"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {interactive.map((node) => (
                <button
                  key={node.ref}
                  type="button"
                  onClick={() =>
                    props.onAction({
                      type: "click",
                      locator: { kind: "ref", ref: node.ref },
                    })
                  }
                  className="rounded-og-sm border border-og-border bg-og-surface-1 px-2 py-1 text-og-control text-og-fg transition hover:bg-og-surface-2"
                >
                  {node.name || node.role}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {props.error && props.supportsLiveFrames ? (
          <button
            type="button"
            onClick={props.onReconnect}
            className="mt-3 text-og-control font-medium text-og-accent hover:underline"
          >
            Reconnect
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BrowserStatusBar(props: {
  session: BrowserSession | null;
  profile: BrowserIdentity | null;
  target: BrowserTarget | null;
  observation: ReturnType<typeof useBrowserSession>["observation"];
  connectionState: string;
  refreshing: boolean;
  diagnosticsOpen: boolean;
  onOpenComputer?: (() => void) | undefined;
  onDiagnostics: () => void;
}) {
  const errors =
    (props.observation?.diagnostics.consoleErrorCount ?? 0) +
    (props.observation?.diagnostics.pageErrorCount ?? 0);
  const failed = props.observation?.diagnostics.failedRequestCount ?? 0;
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-t border-og-border bg-og-surface-0 px-2 text-og-xs text-og-subtle">
      <span
        className={cn(
          "size-1.5 rounded-full",
          props.connectionState === "live" || props.connectionState === "semantic"
            ? "bg-og-status-running"
            : "bg-og-muted",
        )}
      />
      <span>
        {props.connectionState === "live"
          ? "Live"
          : props.connectionState === "semantic"
            ? "Semantic"
            : browserConnectionLabel(props.connectionState)}
      </span>
      <span>{props.profile?.name ?? "Temporary browser"}</span>
      <span className="min-w-0 flex-1 truncate">{props.target?.title}</span>
      {props.refreshing ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
      {props.onOpenComputer ? (
        <button
          type="button"
          onClick={props.onOpenComputer}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-og-surface-2 hover:text-og-fg"
          aria-label="Open this browser window in Computer"
        >
          <MonitorIcon className="size-3" />
          Computer
        </button>
      ) : null}
      <button
        type="button"
        onClick={props.onDiagnostics}
        aria-expanded={props.diagnosticsOpen}
        aria-controls="browser-diagnostics-drawer"
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-og-surface-2 hover:text-og-fg",
          props.diagnosticsOpen && "bg-og-surface-2 text-og-fg",
        )}
      >
        <BugIcon className="size-3" />
        {errors + failed > 0 ? errors + failed : "Debug"}
      </button>
    </div>
  );
}

function BrowserDiagnosticsDrawer(props: {
  session: BrowserSession | null;
  profile: BrowserIdentity | null;
  target: BrowserTarget | null;
  observation: BrowserObservation | null;
  baseRevisionOrdinal: number | null;
  state: BrowserDiagnosticsView;
  downloads: BrowserDownload[];
  downloadsEnabled: boolean;
  downloadsLoading: boolean;
  downloadsRefreshing: boolean;
  downloadsError: Error | null;
  savingDownloadIds: string[];
  onSaveDownload: (
    downloadId: string,
    destinationPath: string,
    overwrite: boolean,
  ) => Promise<BrowserDownloadSaveResponse>;
  onRefreshDownloads: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const session = props.session;
  const diagnostics = props.observation?.diagnostics;
  const semanticMode = props.observation?.semantic
    ? "Semantic page structure available"
    : props.observation?.screenshot
      ? "Visual fallback in use"
      : "Waiting for page observation";
  return (
    <aside
      id="browser-diagnostics-drawer"
      role="region"
      aria-label="Browser diagnostics"
      className="absolute bottom-7 right-0 top-10 z-40 flex w-full max-w-md flex-col border-l border-og-border bg-og-surface-0 shadow-2xl"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-og-border px-3">
        <BugIcon className="size-4 text-og-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-og-control font-semibold text-og-fg">Browser diagnostics</p>
          <p className="truncate text-og-xs text-og-subtle">
            {props.target?.title || shortUrl(props.target?.url ?? "") || "Current tab"}
          </p>
        </div>
        <button
          type="button"
          onClick={props.onRefresh}
          disabled={props.state.loading}
          className="grid size-7 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-40"
          aria-label="Refresh browser diagnostics"
        >
          <RefreshCwIcon className={cn("size-3.5", props.state.loading && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={props.onClose}
          className="grid size-7 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg"
          aria-label="Close browser diagnostics"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-og-border p-3" aria-labelledby="browser-runtime-title">
          <h3
            id="browser-runtime-title"
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-og-subtle"
          >
            Runtime
          </h3>
          <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-og-xs">
            <DiagnosticFact label="Engine" value={browserEngineLabel(session)} />
            <DiagnosticFact label="Driver" value={session?.driverId ?? "Unavailable"} />
            <DiagnosticFact label="Placement" value={placementLabel(session ?? undefined)} />
            <DiagnosticFact
              label="Profile"
              value={
                props.profile
                  ? `${props.profile.name}${props.baseRevisionOrdinal ? ` · v${props.baseRevisionOrdinal}` : ""}`
                  : "Temporary"
              }
            />
            <DiagnosticFact
              label="Controller"
              value={shortGeneration(session?.controller?.controllerGeneration)}
            />
            <DiagnosticFact
              label="Network"
              value={session?.networkRouteId ? "Custom route" : "Placement default"}
            />
            <DiagnosticFact label="Observation" value={semanticMode} />
          </dl>
        </section>

        <section className="border-b border-og-border p-3" aria-labelledby="browser-page-title">
          <h3
            id="browser-page-title"
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-og-subtle"
          >
            Current page
          </h3>
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <DiagnosticCount label="Console errors" value={diagnostics?.consoleErrorCount ?? 0} />
            <DiagnosticCount label="Page errors" value={diagnostics?.pageErrorCount ?? 0} />
            <DiagnosticCount label="Failed requests" value={diagnostics?.failedRequestCount ?? 0} />
            <DiagnosticCount label="Downloads" value={diagnostics?.downloadCount ?? 0} />
          </dl>
          {session?.failureCode ? (
            <p className="mt-2 rounded-og-sm border border-og-status-error/30 bg-og-status-error/5 px-2.5 py-2 text-og-xs text-og-status-error">
              Browser state: {session.failureCode}
            </p>
          ) : null}
        </section>

        {props.downloadsEnabled ? (
          <BrowserDownloadsPanel
            downloads={props.downloads}
            loading={props.downloadsLoading}
            refreshing={props.downloadsRefreshing}
            error={props.downloadsError}
            savingDownloadIds={props.savingDownloadIds}
            onSave={props.onSaveDownload}
            onRefresh={props.onRefreshDownloads}
          />
        ) : null}

        <section className="p-3" aria-labelledby="browser-events-title">
          <div className="flex items-center justify-between gap-2">
            <h3
              id="browser-events-title"
              className="text-[10px] font-semibold uppercase tracking-[0.14em] text-og-subtle"
            >
              Recent events
            </h3>
            {props.state.batch?.truncated ? (
              <span className="text-[10px] text-og-subtle">Newest 100</span>
            ) : null}
          </div>
          {props.state.loading && !props.state.batch ? (
            <div className="flex items-center gap-2 py-6 text-og-control text-og-muted">
              <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading diagnostics…
            </div>
          ) : props.state.error ? (
            <div className="py-5">
              <p className="text-og-control text-og-status-error">{props.state.error.message}</p>
              <button
                type="button"
                onClick={props.onRefresh}
                className="mt-2 text-og-control font-medium text-og-accent hover:underline"
              >
                Try again
              </button>
            </div>
          ) : props.state.batch?.entries.length ? (
            <ol className="mt-2 space-y-2">
              {props.state.batch.entries.map((entry) => (
                <li
                  key={entry.sequence}
                  className="rounded-og-sm border border-og-border bg-og-bg p-2.5"
                >
                  <div className="flex items-center gap-2 text-[10px] text-og-subtle">
                    <span
                      className={cn(
                        "font-semibold uppercase tracking-wide",
                        diagnosticTone(entry.level),
                      )}
                    >
                      {diagnosticKindLabel(entry.kind)}
                    </span>
                    <span className="ml-auto">{formatDiagnosticTime(entry.occurredAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-og-xs leading-5 text-og-fg">
                    {entry.message}
                  </p>
                  {entry.url || entry.filename || entry.method || entry.status ? (
                    <p className="mt-1 truncate font-og-mono text-[10px] text-og-subtle">
                      {[entry.method, entry.status, entry.filename, entry.url]
                        .filter((value) => value !== null)
                        .join(" · ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-og-control text-og-muted">No diagnostics for this tab.</p>
          )}
        </section>
      </div>
    </aside>
  );
}

function BrowserDownloadsPanel(props: {
  downloads: BrowserDownload[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  savingDownloadIds: string[];
  onSave: (
    downloadId: string,
    destinationPath: string,
    overwrite: boolean,
  ) => Promise<BrowserDownloadSaveResponse>;
  onRefresh: () => void;
}) {
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});
  const [savedPaths, setSavedPaths] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saving = useMemo(() => new Set(props.savingDownloadIds), [props.savingDownloadIds]);

  const save = (download: BrowserDownload) => {
    const destinationPath = (paths[download.id] ?? defaultDownloadDestination(download)).trim();
    if (!destinationPath || saving.has(download.id)) return;
    setErrors((current) => ({ ...current, [download.id]: "" }));
    void props
      .onSave(download.id, destinationPath, overwrite[download.id] ?? false)
      .then((response) => {
        setSavedPaths((current) => ({ ...current, [download.id]: response.destinationPath }));
      })
      .catch((cause) => {
        setErrors((current) => ({
          ...current,
          [download.id]: cause instanceof Error ? cause.message : "Could not save this download.",
        }));
      });
  };

  return (
    <section className="border-b border-og-border p-3" aria-labelledby="browser-downloads-title">
      <div className="flex items-center gap-2">
        <DownloadIcon className="size-3.5 text-og-muted" />
        <h3
          id="browser-downloads-title"
          className="text-[10px] font-semibold uppercase tracking-[0.14em] text-og-subtle"
        >
          Downloads
        </h3>
        {props.refreshing ? (
          <LoaderCircleIcon className="ml-auto size-3 animate-spin text-og-muted" />
        ) : null}
      </div>

      {props.loading ? (
        <div className="flex items-center gap-2 py-5 text-og-control text-og-muted">
          <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading downloads…
        </div>
      ) : props.error ? (
        <div className="py-4">
          <p className="text-og-control text-og-status-error">{props.error.message}</p>
          <button
            type="button"
            onClick={props.onRefresh}
            className="mt-2 text-og-control font-medium text-og-accent hover:underline"
          >
            Try again
          </button>
        </div>
      ) : props.downloads.length === 0 ? (
        <p className="py-4 text-og-control text-og-muted">No files downloaded yet.</p>
      ) : (
        <ol className="mt-2 space-y-2">
          {props.downloads.map((download) => {
            const destinationPath = paths[download.id] ?? defaultDownloadDestination(download);
            const isSaving = saving.has(download.id);
            const isSaved = savedPaths[download.id] === destinationPath;
            return (
              <li
                key={download.id}
                className="rounded-og-sm border border-og-border bg-og-bg p-2.5"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-og-surface-2 text-og-muted">
                    {isSaved ? (
                      <FileCheck2Icon className="size-3.5 text-og-status-success" />
                    ) : (
                      <DownloadIcon className="size-3.5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-og-xs font-medium text-og-fg"
                      title={download.filename}
                    >
                      {download.filename}
                    </p>
                    <p className="mt-0.5 text-[10px] text-og-subtle">
                      {downloadStatusLabel(download)}
                    </p>
                  </div>
                </div>

                {download.status === "completed" ? (
                  <div className="mt-2">
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={destinationPath}
                        onInput={(event) => {
                          const value = event.currentTarget.value;
                          setPaths((current) => ({ ...current, [download.id]: value }));
                          setErrors((current) => ({ ...current, [download.id]: "" }));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") save(download);
                        }}
                        disabled={isSaving}
                        aria-label={`Workspace path for ${download.filename}`}
                        className="h-7 min-w-0 flex-1 rounded-og-sm border border-og-border bg-og-surface-0 px-2 font-og-mono text-[10px] text-og-fg transition focus:border-og-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent disabled:opacity-50"
                      />
                      <button
                        type="button"
                        onClick={() => save(download)}
                        disabled={
                          isSaving ||
                          !destinationPath.trim() ||
                          (isSaved && !overwrite[download.id])
                        }
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-og-sm border border-og-border bg-og-surface-1 px-2 text-[10px] font-medium text-og-fg transition hover:bg-og-surface-2 disabled:opacity-40"
                      >
                        {isSaving ? (
                          <LoaderCircleIcon className="size-3 animate-spin" />
                        ) : (
                          <SaveIcon className="size-3" />
                        )}
                        {isSaving
                          ? "Saving"
                          : isSaved
                            ? "Saved"
                            : overwrite[download.id]
                              ? "Replace"
                              : "Save"}
                      </button>
                    </div>
                    <label className="mt-1.5 flex w-fit items-center gap-1.5 text-[10px] text-og-subtle">
                      <input
                        type="checkbox"
                        checked={overwrite[download.id] ?? false}
                        onChange={(event) => {
                          setOverwrite((current) => ({
                            ...current,
                            [download.id]: event.currentTarget.checked,
                          }));
                          setErrors((current) => ({ ...current, [download.id]: "" }));
                        }}
                        disabled={isSaving}
                        className="size-3 accent-og-accent"
                      />
                      Replace an existing workspace file
                    </label>
                    {errors[download.id] ? (
                      <p className="mt-1.5 break-words text-[10px] text-og-status-error">
                        {errors[download.id]}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function downloadStatusLabel(download: BrowserDownload): string {
  if (download.status === "completed") return formatBytes(download.receivedBytes);
  if (download.status === "in_progress") {
    const received = formatBytes(download.receivedBytes);
    return download.totalBytes === null
      ? `Downloading · ${received}`
      : `Downloading · ${received} of ${formatBytes(download.totalBytes)}`;
  }
  if (download.status === "cancelled") return "Cancelled";
  if (download.status === "unavailable") return "No longer available";
  return "Download failed";
}

function defaultDownloadDestination(download: BrowserDownload): string {
  const leaf = download.filename.split(/[\\/]/u).at(-1)?.trim() ?? "";
  const portable = leaf
    .normalize("NFC")
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, "-")
    .replace(/[ .]+$/u, "");
  if (portable.length === 0 || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(portable)) {
    return `download-${download.id.slice(0, 8)}`;
  }
  return portable;
}

function DiagnosticFact(props: { label: string; value: string }) {
  return (
    <>
      <dt className="text-og-subtle">{props.label}</dt>
      <dd className="min-w-0 truncate text-og-fg" title={props.value}>
        {props.value}
      </dd>
    </>
  );
}

function DiagnosticCount(props: { label: string; value: number }) {
  return (
    <div className="rounded-og-sm border border-og-border bg-og-bg px-2.5 py-2">
      <dt className="text-[10px] text-og-subtle">{props.label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-og-sm font-semibold",
          props.value ? "text-og-fg" : "text-og-muted",
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}

function browserEngineLabel(session: BrowserSession | null): string {
  if (!session) return "Unavailable";
  const version = session.engineVersion ? ` ${session.engineVersion}` : "";
  return `${session.engine}${version} · ${session.headless ? "headless" : "headed"}`;
}

function shortGeneration(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function diagnosticKindLabel(kind: BrowserDiagnosticBatch["entries"][number]["kind"]): string {
  switch (kind) {
    case "console":
      return "Console";
    case "page_error":
      return "Page error";
    case "failed_request":
      return "Request";
    case "download":
      return "Download";
  }
}

function diagnosticTone(level: BrowserDiagnosticBatch["entries"][number]["level"]): string {
  if (level === "error") return "text-og-status-error";
  if (level === "warning") return "text-og-status-waiting";
  return "text-og-muted";
}

function formatDiagnosticTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function BrowserNotice(props: { icon: ReactNode; text: string; className?: string }) {
  return (
    <div
      className={cn(
        "grid h-full place-items-center bg-og-bg text-og-control text-og-muted",
        props.className,
      )}
    >
      <div className="flex items-center gap-2">
        {props.icon}
        {props.text}
      </div>
    </div>
  );
}

function paintCanvas(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  width: number,
  height: number,
): void {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Browser canvas is unavailable.");
  context.drawImage(image, 0, 0, width, height);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Browser frame image could not be decoded."));
    image.src = url;
  });
}

function browserPoint(
  canvas: HTMLCanvasElement | null,
  frame: BrowserFrame | null,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!canvas || !frame) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const pixelX = ((clientX - rect.left) / rect.width) * frame.width;
  const pixelY = ((clientY - rect.top) / rect.height) * frame.height;
  return {
    x: Math.max(0, pixelX / frame.deviceScaleFactor),
    y: Math.max(0, pixelY / frame.deviceScaleFactor),
  };
}

function browserKey(event: KeyboardEvent<HTMLTextAreaElement>): string | null {
  const special = new Set([
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]);
  const modified = event.altKey || event.ctrlKey || event.metaKey;
  if (!modified && !special.has(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key === " " ? "Space" : event.key);
  return parts.join("+");
}

function normalizeBrowserAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return ["http:", "https:", "about:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function semanticNodes(roots: readonly InteractionSemanticNode[]): InteractionSemanticNode[] {
  const result: InteractionSemanticNode[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    if (node.children) stack.push(...[...node.children].reverse());
  }
  return result;
}

function frameMatchesObservation(
  frame: BrowserFrame | null,
  observation: BrowserObservation | null,
): frame is BrowserFrame {
  return Boolean(
    frame &&
    observation &&
    frame.browserSessionId === observation.browserSessionId &&
    frame.controllerGeneration === observation.target.controllerGeneration &&
    frame.targetId === observation.target.id &&
    frame.targetGeneration === observation.target.targetGeneration &&
    frame.documentGeneration === observation.target.documentGeneration &&
    frame.frameId === observation.frameId,
  );
}

function sameFrameFence(left: BrowserFrame, right: BrowserFrame): boolean {
  return (
    left.browserSessionId === right.browserSessionId &&
    left.controllerGeneration === right.controllerGeneration &&
    left.targetId === right.targetId &&
    left.targetGeneration === right.targetGeneration &&
    left.documentGeneration === right.documentGeneration &&
    left.frameId === right.frameId
  );
}

function isLiveBrowser(session: BrowserSession): boolean {
  return !["ending", "ended", "failed", "lost"].includes(session.lifecycle);
}

function countInterventions(
  interventions: readonly InteractionIntervention[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const intervention of interventions) {
    counts.set(intervention.resourceId, (counts.get(intervention.resourceId) ?? 0) + 1);
  }
  return counts;
}

function interventionTitle(intervention: InteractionIntervention): string {
  switch (intervention.kind) {
    case "manual_login":
      return "Sign in needed";
    case "mfa":
      return "Verification needed";
    case "external_action":
    case "confirmation":
      return "Action needed";
    case "other":
      return "Browser needs your help";
  }
}

function placementLabel(session: BrowserSession | undefined): string {
  if (!session) return "";
  switch (session.placement.kind) {
    case "sandbox_group":
      return "Agent sandbox";
    case "connected_machine":
      return "Connected machine";
    case "attached_device":
      return "Your browser";
    case "external_provider":
      return "Cloud browser";
  }
}

function browserConnectionLabel(state: string): string {
  switch (state) {
    case "attaching":
      return "Opening browser…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Disconnected";
    case "semantic":
      return "Semantic";
    default:
      return "Waiting for browser…";
  }
}

function shortUrl(value: string): string {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}
