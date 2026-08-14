import type {
  ComputerAction,
  ComputerClipboard,
  ComputerFrame,
  ComputerObservation,
  ComputerSession,
  ComputerTarget,
  InteractionIntervention,
  InteractionSemanticNode,
} from "@opengeni/sdk/interaction";
import { interactionControlFailureFromError } from "@opengeni/sdk/interaction";
import type { DesktopStreamCapability } from "@opengeni/sdk";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  KeyboardIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  MonitorIcon,
  MousePointer2Icon,
  PanelsTopLeftIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ComputerFrameWebSocketFactory,
  useComputerFrameStream,
} from "../hooks/use-computer-frame-stream";
import { useComputerSession } from "../hooks/use-computer-session";
import { useComputerSessions } from "../hooks/use-computer-sessions";
import { useInteractionInterventions } from "../hooks/use-interaction-interventions";
import { cn } from "../lib/cn";
import { copyTextToClipboard } from "../lib/clipboard";
import type { EmbeddedComputerInteractionClientOverride } from "../session-context";
import { InteractionInterventionBanner } from "./interaction-intervention-banner";
import { DesktopViewer } from "./desktop-viewer";

export type ComputerViewerNotification = { kind: "error" | "info"; message: string };

export type ComputerViewerProps = EmbeddedComputerInteractionClientOverride & {
  /** Selected OpenGeni agent/session. Peer ComputerSessions remain visible. */
  sessionId: string;
  enabled?: boolean | undefined;
  className?: string | undefined;
  onNotify?: ((notification: ComputerViewerNotification) => void) | undefined;
  /** Tests/demos only. Production uses the browser's native WebSocket. */
  webSocketFactory?: ComputerFrameWebSocketFactory | undefined;
  renderEmpty?: ((create: () => void, creating: boolean) => ReactNode) | undefined;
  /** Host navigation request for one exact ComputerSession. */
  requestedComputerSessionId?: string | null | undefined;
  requestedComputerRequestId?: string | number | null | undefined;
};

type ComputerSelection = { sessionId: string; pinned: boolean } | null;
type PointerStart = { x: number; y: number; pointerId: number; frame: ComputerFrame };

/** Full ComputerSession surface: workspace discovery, peer switching, app/window/
 * screen navigation, semantic controls, exact-frame input, and live media. */
export function ComputerViewer({
  sessionId,
  enabled = true,
  className,
  onNotify,
  webSocketFactory,
  renderEmpty,
  requestedComputerSessionId,
  requestedComputerRequestId,
  ...override
}: ComputerViewerProps) {
  const registry = useComputerSessions({ ...override, sessionId, enabled });
  const createSession = registry.create;
  const refreshRegistry = registry.refresh;
  const liveRelevant = useMemo(
    () => registry.relevantSessions.filter((session) => isLiveComputer(session)),
    [registry.relevantSessions],
  );
  const recentRelevantFailure = useMemo(
    () =>
      liveRelevant.length === 0
        ? (registry.relevantSessions.find((session) =>
            ["failed", "lost"].includes(session.lifecycle),
          ) ?? null)
        : null,
    [liveRelevant.length, registry.relevantSessions],
  );
  const liveSessions = useMemo(() => {
    const sessions = registry.sessions.filter((session) => isLiveComputer(session));
    return recentRelevantFailure ? [...sessions, recentRelevantFailure] : sessions;
  }, [recentRelevantFailure, registry.sessions]);
  const relevant = useMemo(
    () =>
      liveRelevant.length > 0 ? liveRelevant : recentRelevantFailure ? [recentRelevantFailure] : [],
    [liveRelevant, recentRelevantFailure],
  );
  const [selection, setSelection] = useState<ComputerSelection>(null);
  const interventions = useInteractionInterventions({
    ...override,
    enabled,
    resourceKind: "computer_session",
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<Error | null>(null);
  const [showControls, setShowControls] = useState(false);
  const previousSessionIdRef = useRef(sessionId);
  const handledRequestRef = useRef<string | null>(null);
  const seenInterventionIdsRef = useRef(new Set<string>());
  const createInFlightRef = useRef(false);
  const autoCreateSessionRef = useRef<string | null>(null);
  const emptyCatalogConfirmationRef = useRef<string | null>(null);

  const notifyError = useCallback(
    (cause: unknown, fallback: string) => {
      onNotify?.({
        kind: "error",
        message: cause instanceof Error ? cause.message : fallback,
      });
    },
    [onNotify],
  );

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    handledRequestRef.current = null;
    autoCreateSessionRef.current = null;
    emptyCatalogConfirmationRef.current = null;
    setCreateError(null);
    setSelection(null);
  }, [sessionId]);

  useEffect(() => {
    const requested = requestedComputerSessionId
      ? (liveSessions.find((session) => session.id === requestedComputerSessionId) ?? null)
      : null;
    const requestKey = requested
      ? `${requestedComputerRequestId ?? "default"}:${requested.id}`
      : null;
    if (requested && requestKey && handledRequestRef.current !== requestKey) {
      handledRequestRef.current = requestKey;
      setSelection({ sessionId: requested.id, pinned: true });
      return;
    }

    const selectedStillLive = liveSessions.some((session) => session.id === selection?.sessionId);
    // Peer computers remain one click away, but never become the implicit
    // computer for another agent. Otherwise opening a sandbox's Computer tab
    // can silently select—and send input to—a connected user's Mac.
    if (selection?.pinned && selectedStillLive) return;
    const preferred = relevant[0] ?? null;
    if (!preferred) {
      if (selection) setSelection(null);
      return;
    }
    if (!selectedStillLive || !selection?.pinned) {
      if (selection?.sessionId !== preferred.id || selection.pinned) {
        setSelection({ sessionId: preferred.id, pinned: false });
      }
    }
  }, [liveSessions, relevant, requestedComputerRequestId, requestedComputerSessionId, selection]);

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
  const computer = useComputerSession({
    ...override,
    computerSessionId: selection?.sessionId ?? null,
    enabled: enabled && selection !== null && controllerReady,
  });
  const act = computer.act;
  const actFromFrame = computer.actFromFrame;
  const refreshComputer = computer.refresh;
  const frames = useComputerFrameStream({
    ...override,
    computerSessionId: selection?.sessionId ?? null,
    targetId: computer.selectedTarget?.id ?? null,
    enabled:
      enabled &&
      selection !== null &&
      controllerReady &&
      computer.selectedTarget !== null &&
      isComputerFrameTarget(computer.selectedTarget),
    stream: {
      format: "jpeg",
      quality: 78,
      maxWidth: 1_920,
      maxHeight: 1_200,
      everyNthFrame: 1,
    },
    ...(webSocketFactory ? { webSocketFactory } : {}),
  });
  const displayedFrame =
    frames.frame &&
    frames.frame.computerSessionId === selection?.sessionId &&
    frames.frame.targetId === computer.selectedTarget?.id
      ? frames.frame
      : null;
  const rfbStream =
    frames.attachment?.stream.kind === "direct_rfb" ? frames.attachment.stream : null;
  const rfbCapability = useMemo<DesktopStreamCapability | null>(() => {
    if (!rfbStream || !frames.attachment) return null;
    const bounds = computer.selectedTarget?.bounds;
    return {
      transport: "vnc-ws",
      client: "novnc",
      mode: "interactive",
      url: rfbStream.url,
      token: null,
      expiresAt: frames.attachment.expiresAt,
      resolution: [bounds?.width ?? 1_440, bounds?.height ?? 900],
      unredacted: true,
      requiresAcknowledgment: false,
      acknowledged: true,
      shared: false,
      sharedSessionIds: [],
      reason: null,
    };
  }, [computer.selectedTarget?.bounds, frames.attachment, rfbStream]);
  const machineLocked = selectedRegistrySession?.failureCode === "machine_locked";
  const currentIds = useMemo(() => new Set(relevant.map((session) => session.id)), [relevant]);

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
        .catch((cause) => notifyError(cause, "Could not update the desktop request."));
    },
    [interventions, notifyError, onNotify],
  );

  const createComputer = useCallback(() => {
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    setCreateError(null);
    setCreating(true);
    void createSession({ sessionId, name: "Desktop" })
      .then((response) => {
        setSelection({ sessionId: response.session.id, pinned: false });
      })
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error("Could not open a desktop.");
        setCreateError(error);
        notifyError(error, "Could not open a desktop.");
      })
      .finally(() => {
        createInFlightRef.current = false;
        setCreating(false);
      });
  }, [createSession, notifyError, sessionId]);

  useEffect(() => {
    // Once this task's Desktop has been observed, a later transient empty
    // registry snapshot must not create a second one. This can happen while the
    // lazy surface is disabled/re-enabled or while an invalidation refresh
    // briefly races the association projection. The existing Desktop remains
    // the task's authority; explicit New desktop is still available.
    if (relevant.length > 0) {
      autoCreateSessionRef.current = sessionId;
      emptyCatalogConfirmationRef.current = null;
    }
  }, [relevant.length, sessionId]);

  useEffect(() => {
    if (
      !enabled ||
      registry.loading ||
      registry.refreshing ||
      registry.error ||
      relevant.length > 0 ||
      autoCreateSessionRef.current === sessionId
    ) {
      return;
    }
    // A lazy surface can momentarily publish an empty settled projection while
    // its initial catalog and a workspace invalidation cross. Confirm the empty
    // result with one authoritative refresh before creating anything. A real
    // empty catalog creates on the following render; an existing association
    // appears and cancels this path.
    if (emptyCatalogConfirmationRef.current !== sessionId) {
      emptyCatalogConfirmationRef.current = sessionId;
      void refreshRegistry();
      return;
    }
    autoCreateSessionRef.current = sessionId;
    createComputer();
  }, [
    createComputer,
    enabled,
    refreshRegistry,
    registry.error,
    registry.loading,
    registry.refreshing,
    relevant.length,
    sessionId,
  ]);

  const perform = useCallback(
    async (action: ComputerAction, frame: ComputerFrame | null): Promise<void> => {
      if (action.type === "pointer") {
        if (!frame) throw new Error("Desktop view is not ready for pointer input.");
        await actFromFrame(action, frame);
      } else {
        await act(action);
      }
    },
    [act, actFromFrame],
  );

  const copyFromRfb = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (!rfbStream || computer.session?.capabilities?.clipboard !== true) return;
      event.preventDefault();
      event.stopPropagation();
      void perform({ type: "clipboard", operation: "copy" }, null)
        .then(() => computer.readClipboard())
        .then(async (clipboard) => {
          if (clipboard.text && !(await copyTextToClipboard(clipboard.text))) {
            throw new Error("Desktop text could not be copied to the local clipboard");
          }
        })
        .catch((cause) => notifyError(cause, "Could not copy from the desktop."));
    },
    [computer, notifyError, perform, rfbStream],
  );

  const pasteIntoRfb = useCallback(
    (text: string): boolean => {
      if (!rfbStream || computer.session?.capabilities?.clipboard !== true) return false;
      // Keep paste on the canonical ComputerSession action path. RFB
      // ClientCutText synchronization varies by server and can acknowledge a
      // local paste without ever updating the remote graphical seat. These two
      // awaited actions run against the exact selected ComputerSession/target.
      // Read-after-write is the causal readiness barrier on X11: clipboard
      // ownership is asynchronous, so a successful write response alone does
      // not prove that the graphical seat can already serve the selection.
      void (async () => {
        await perform({ type: "clipboard", operation: "write", text }, null);
        assertExactComputerClipboard(await computer.readClipboard(), text);
        await perform({ type: "clipboard", operation: "paste" }, null);
      })().catch((cause) => notifyError(cause, "Could not paste into the desktop."));
      return true;
    },
    [computer, notifyError, perform, rfbStream],
  );

  if (!enabled) return null;
  if (registry.loading && liveSessions.length === 0) {
    return (
      <ComputerNotice
        icon={<LoaderCircleIcon className="size-4 animate-spin" />}
        text="Finding workspace desktops…"
        {...(className ? { className } : {})}
      />
    );
  }
  if (liveSessions.length === 0) {
    if (renderEmpty) return renderEmpty(createComputer, creating);
    const error = createError ?? registry.error;
    return (
      <div className={cn("grid h-full place-items-center bg-og-bg p-6", className)}>
        <div className="max-w-sm text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-og-lg border border-og-border bg-og-surface-1 text-og-muted">
            {error ? (
              <CircleAlertIcon className="size-5 text-og-status-error" />
            ) : (
              <LoaderCircleIcon className="size-5 animate-spin" />
            )}
          </span>
          <p className="mt-3 text-og-menu font-medium text-og-fg">
            {error ? "Desktop didn’t open" : "Opening desktop…"}
          </p>
          <p className="mt-1 text-og-control leading-5 text-og-muted">
            {error?.message ?? "Preparing this agent’s desktop. It will appear here when ready."}
          </p>
          {error ? (
            <button
              type="button"
              onClick={createError ? createComputer : () => void refreshRegistry()}
              disabled={creating || registry.refreshing}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-og-sm bg-og-accent-deep px-3 text-og-control font-medium text-og-accent-fg transition hover:brightness-110 disabled:opacity-50"
            >
              {creating || registry.refreshing ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <RotateCcwIcon className="size-3.5" />
              )}
              Try again
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden bg-og-bg", className)}>
      <ComputerToolbar
        sessions={liveSessions}
        relevantSessionIds={currentIds}
        selectedSessionId={selection?.sessionId ?? null}
        creating={creating}
        refreshing={registry.refreshing}
        interventionCounts={interventionCounts}
        onSelect={(computerSessionId) =>
          setSelection({ sessionId: computerSessionId, pinned: true })
        }
        onFollow={() => {
          if (relevant[0]) setSelection({ sessionId: relevant[0].id, pinned: false });
        }}
        onCreate={createComputer}
        onRefresh={() => void Promise.all([refreshRegistry(), refreshComputer()])}
      />
      <InteractionInterventionBanner
        interventions={selectedInterventions}
        activeTargetId={computer.selectedTarget?.id ?? null}
        mutating={interventions.mutating}
        onOpen={(intervention) =>
          void computer
            .selectTarget(intervention.targetId)
            .catch((cause) => notifyError(cause, "Could not open the requested desktop view."))
        }
        onResolve={resolveIntervention}
      />
      {!selectedRegistrySession ? (
        <ComputerUnselectedPanel
          peerCount={liveSessions.length}
          creating={creating}
          error={createError}
          onCreate={createComputer}
        />
      ) : !controllerReady ? (
        <ComputerLifecyclePanel
          session={selectedRegistrySession}
          creating={creating}
          onRefresh={registry.refresh}
          onRetry={createComputer}
        />
      ) : (
        <>
          <ComputerTargetRail
            targets={computer.targets}
            selectedTargetId={computer.selectedTarget?.id ?? null}
            loading={computer.loading}
            onSelect={(targetId) =>
              void computer
                .selectTarget(targetId)
                .catch((cause) => notifyError(cause, "Could not switch desktop views."))
            }
          />
          <div className="flex min-h-0 flex-1">
            {rfbStream ? (
              <div className="relative min-h-0 flex-1 bg-black" onCopyCapture={copyFromRfb}>
                <DesktopViewer
                  capability={rfbCapability}
                  interactive
                  showControlToggle={false}
                  webSocketProtocols={rfbStream.protocols}
                  onPasteText={pasteIntoRfb}
                  targetPlatform={computer.session?.platform ?? null}
                  className="h-full"
                />
              </div>
            ) : (
              <ComputerViewport
                frame={machineLocked ? null : displayedFrame}
                observation={computer.observation}
                target={computer.selectedTarget}
                machineLocked={machineLocked}
                connectionState={frames.state}
                connectionError={frames.error ?? computer.error}
                mutating={computer.mutating}
                backgroundActions={computer.session?.capabilities?.backgroundActions === true}
                clipboardEnabled={computer.session?.capabilities?.clipboard === true}
                onAction={perform}
                onReadClipboard={computer.readClipboard}
                onReconnect={frames.reconnect}
                onError={(cause) => notifyError(cause, "Desktop input failed.")}
              />
            )}
            {showControls ? (
              <ComputerSemanticPanel
                observation={computer.observation}
                mutating={computer.mutating}
                onAction={(action) =>
                  void perform(action, null).catch((cause) =>
                    notifyError(cause, "Desktop action failed."),
                  )
                }
              />
            ) : null}
          </div>
          <ComputerStatusBar
            session={computer.session}
            target={computer.selectedTarget}
            connectionState={frames.state}
            refreshing={registry.refreshing}
            showControls={showControls}
            controlCount={semanticNodes(computer.observation).length}
            onToggleControls={() => setShowControls((current) => !current)}
          />
        </>
      )}
    </div>
  );
}

function ComputerUnselectedPanel(props: {
  peerCount: number;
  creating: boolean;
  error: Error | null;
  onCreate: () => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-og-bg p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-10 place-items-center rounded-og-md border border-og-border bg-og-surface-1 text-og-muted">
          {props.error ? (
            <CircleAlertIcon className="size-4.5 text-og-status-error" />
          ) : (
            <LoaderCircleIcon className="size-4.5 animate-spin" />
          )}
        </span>
        <p className="mt-3 text-og-menu font-medium text-og-fg">
          {props.error ? "Desktop didn’t open" : "Opening desktop…"}
        </p>
        <p className="mt-1 text-og-control leading-5 text-og-muted">
          {props.error?.message ??
            (props.peerCount === 1
              ? "Preparing this agent’s desktop. One peer desktop remains available from the menu."
              : `Preparing this agent’s desktop. ${props.peerCount} peer desktops remain available from the menu.`)}
        </p>
        {props.error ? (
          <button
            type="button"
            disabled={props.creating}
            onClick={props.onCreate}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-og-sm border border-og-border bg-og-surface-1 px-3 text-og-control font-medium text-og-fg transition hover:bg-og-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {props.creating ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <RotateCcwIcon className="size-3.5" />
            )}
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComputerToolbar(props: {
  sessions: ComputerSession[];
  relevantSessionIds: Set<string>;
  selectedSessionId: string | null;
  creating: boolean;
  refreshing: boolean;
  interventionCounts: Map<string, number>;
  onSelect: (id: string) => void;
  onFollow: () => void;
  onCreate: () => void;
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
          <MonitorIcon className="size-3.5 shrink-0 text-og-muted" />
          <span className="truncate font-medium">
            {selected?.name === "Computer" ? "Desktop" : (selected?.name ?? "Desktop")}
          </span>
          {(props.interventionCounts.get(selected?.id ?? "") ?? 0) > 0 ? (
            <span className="size-1.5 shrink-0 rounded-full bg-og-status-waiting" />
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0 text-og-subtle" />
        </summary>
        <div className="absolute left-0 top-8 z-30 w-72 overflow-hidden rounded-og-md border border-og-border bg-og-surface-1 p-1 shadow-xl">
          <ComputerSessionGroup
            label="Current agent"
            sessions={current}
            selectedId={props.selectedSessionId}
            interventionCounts={props.interventionCounts}
            onSelect={choose}
          />
          <ComputerSessionGroup
            label="Other agents"
            sessions={others}
            selectedId={props.selectedSessionId}
            interventionCounts={props.interventionCounts}
            onSelect={choose}
          />
          <div className="mt-1 flex gap-1 border-t border-og-border pt-1">
            {current.length > 0 ? (
              <MenuButton onClick={props.onFollow}>Follow agent</MenuButton>
            ) : null}
            <MenuButton onClick={props.onCreate} disabled={props.creating}>
              <PlusIcon className="size-3.5" /> New desktop
            </MenuButton>
          </div>
        </div>
      </details>
      <span className="min-w-0 flex-1 truncate text-og-xs text-og-subtle">
        {selected ? `${platformLabel(selected)} · ${placementLabel(selected)}` : ""}
      </span>
      <button
        type="button"
        onClick={props.onRefresh}
        className="grid size-7 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg"
        aria-label="Refresh desktops"
      >
        <RefreshCwIcon className={cn("size-3.5", props.refreshing && "animate-spin")} />
      </button>
      <button
        type="button"
        onClick={props.onCreate}
        disabled={props.creating}
        className="grid size-7 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-40"
        aria-label="Open a new desktop"
      >
        {props.creating ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <PlusIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}

function ComputerSessionGroup(props: {
  label: string;
  sessions: ComputerSession[];
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
                {platformLabel(session)} · {placementLabel(session)}
              </span>
            </span>
            {interventionCount > 0 ? (
              <span className="rounded-full bg-og-status-waiting/10 px-1.5 py-0.5 text-[10px] font-medium text-og-status-waiting">
                {interventionCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
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

function ComputerTargetRail(props: {
  targets: ComputerTarget[];
  selectedTargetId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const visualTargets = props.targets.filter(isRenderableComputerView);
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-og-border bg-og-surface-0 px-2"
      aria-label="Desktop views"
    >
      {visualTargets.map((target) => (
        <button
          key={target.id}
          type="button"
          onClick={() => props.onSelect(target.id)}
          className={cn(
            "flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-og-sm border px-2 text-og-control transition",
            target.id === props.selectedTargetId
              ? "border-og-border-strong bg-og-surface-2 text-og-fg"
              : "border-transparent text-og-muted hover:bg-og-surface-1 hover:text-og-fg",
          )}
          aria-pressed={target.id === props.selectedTargetId}
        >
          {target.kind === "screen" ? (
            <MonitorIcon className="size-3.5 shrink-0" />
          ) : (
            <PanelsTopLeftIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{target.title || target.applicationId || target.kind}</span>
          {target.focused ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-og-status-running"
              aria-label="Focused"
            />
          ) : null}
        </button>
      ))}
      {props.loading ? (
        <LoaderCircleIcon className="ml-1 size-3.5 animate-spin text-og-muted" />
      ) : null}
      {!props.loading && visualTargets.length === 0 ? (
        <span className="text-og-xs text-og-subtle">Waiting for apps and screens…</span>
      ) : null}
    </div>
  );
}

function isRenderableComputerView(target: ComputerTarget): boolean {
  if (target.kind === "screen") return true;
  if (target.kind !== "window" || !target.bounds) return false;
  // AX exposes applications and tiny utility/menu windows as valid semantic
  // targets. Keep those available to tools, but do not present them as visual
  // desktop tabs when they cannot form a useful live view.
  return target.bounds.width >= 160 && target.bounds.height >= 90;
}

function isComputerFrameTarget(target: ComputerTarget): boolean {
  return target.kind === "window" || target.kind === "screen";
}

function ComputerLifecyclePanel(props: {
  session: ComputerSession;
  creating: boolean;
  onRefresh: () => Promise<void>;
  onRetry: () => void;
}) {
  const failed = ["failed", "lost", "repair_required"].includes(props.session.lifecycle);
  const retryCreatesSession = ["failed", "lost"].includes(props.session.lifecycle);
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-og-bg p-6">
      <div className="max-w-sm text-center">
        {failed ? (
          <CircleAlertIcon className="mx-auto size-5 text-og-status-error" />
        ) : (
          <LoaderCircleIcon className="mx-auto size-5 animate-spin text-og-muted" />
        )}
        <p className="mt-3 text-og-menu font-medium text-og-fg">
          {failed ? "Desktop needs attention" : lifecycleLabel(props.session.lifecycle)}
        </p>
        <p className="mt-1 text-og-control leading-5 text-og-muted">
          {computerFailureMessage(props.session) ??
            "The desktop is being prepared on its placement. It will appear here when ready."}
        </p>
        {failed ? (
          <button
            type="button"
            onClick={() => (retryCreatesSession ? props.onRetry() : void props.onRefresh())}
            disabled={props.creating}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-og-sm border border-og-border bg-og-surface-1 px-3 text-og-control font-medium text-og-fg transition hover:bg-og-surface-2"
          >
            {props.creating ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <RotateCcwIcon className="size-3.5" />
            )}
            {retryCreatesSession ? "Try again" : "Check again"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComputerViewport(props: {
  frame: ComputerFrame | null;
  observation: ComputerObservation | null;
  target: ComputerTarget | null;
  machineLocked: boolean;
  connectionState: string;
  connectionError: Error | null;
  mutating: boolean;
  backgroundActions: boolean;
  clipboardEnabled: boolean;
  onAction: (action: ComputerAction, frame: ComputerFrame | null) => Promise<void>;
  onReadClipboard: () => Promise<ComputerClipboard>;
  onReconnect: () => void;
  onError: (cause: unknown) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pointerStartRef = useRef<PointerStart | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickRef = useRef<{
    at: number;
    x: number;
    y: number;
    frame: ComputerFrame;
  } | null>(null);
  const wheelRef = useRef<{
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    frame: ComputerFrame;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const pendingTextRef = useRef<{
    text: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const actionRef = useRef(props.onAction);
  const readClipboardRef = useRef(props.onReadClipboard);
  const errorRef = useRef(props.onError);
  const actionTailRef = useRef<Promise<void>>(Promise.resolve());
  const queuedFrameRef = useRef<ComputerFrame | null>(null);
  const decodingFrameRef = useRef(false);
  const mountedRef = useRef(true);
  actionRef.current = props.onAction;
  readClipboardRef.current = props.onReadClipboard;
  errorRef.current = props.onError;
  const rawInputEnabled =
    !props.backgroundActions || props.target?.kind === "screen" || props.target?.focused === true;

  const paintQueuedFrames = useCallback(() => {
    if (decodingFrameRef.current) return;
    decodingFrameRef.current = true;
    void (async () => {
      try {
        while (mountedRef.current) {
          const frame = queuedFrameRef.current;
          queuedFrameRef.current = null;
          if (!frame) break;
          let objectUrl: string | null = null;
          try {
            const blob = new Blob([frame.data.slice().buffer], { type: frame.mediaType });
            if (typeof createImageBitmap === "function") {
              const bitmap = await createImageBitmap(blob);
              try {
                const canvas = canvasRef.current;
                if (mountedRef.current && canvas) {
                  paintCanvas(canvas, bitmap, frame.width, frame.height);
                }
              } finally {
                bitmap.close();
              }
              continue;
            }
            objectUrl = URL.createObjectURL(blob);
            const image = await loadImage(objectUrl);
            const canvas = canvasRef.current;
            if (mountedRef.current && canvas) {
              paintCanvas(canvas, image, frame.width, frame.height);
            }
          } catch (cause) {
            if (mountedRef.current) errorRef.current(cause);
          } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
          }
        }
      } finally {
        decodingFrameRef.current = false;
        if (mountedRef.current && queuedFrameRef.current) paintQueuedFrames();
      }
    })();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queuedFrameRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!props.frame) return;
    queuedFrameRef.current = props.frame;
    paintQueuedFrames();
  }, [paintQueuedFrames, props.frame]);

  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      if (wheelRef.current?.timer) clearTimeout(wheelRef.current.timer);
      if (pendingTextRef.current?.timer) clearTimeout(pendingTextRef.current.timer);
    },
    [],
  );

  const enqueue = useCallback(
    (action: ComputerAction, frame: ComputerFrame | null, after?: () => Promise<void>) => {
      actionTailRef.current = actionTailRef.current
        .catch(() => undefined)
        .then(async () => {
          await actionRef.current(action, frame);
          await after?.();
        })
        .catch((cause) => errorRef.current(cause));
    },
    [],
  );

  const point = useCallback(
    (frame: ComputerFrame, clientX: number, clientY: number) =>
      computerPoint(canvasRef.current, frame, clientX, clientY),
    [],
  );

  const flushPendingText = useCallback(() => {
    const pending = pendingTextRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingTextRef.current = null;
    enqueue({ type: "keyboard", action: "type", value: pending.text }, null);
  }, [enqueue]);

  const flushPendingClick = useCallback(() => {
    const pending = lastClickRef.current;
    if (!pending) return;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
    lastClickRef.current = null;
    enqueue(
      {
        type: "pointer",
        frameId: pending.frame.frameId,
        action: "click",
        x: pending.x,
        y: pending.y,
      },
      pending.frame,
    );
  }, [enqueue]);

  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!props.frame || props.mutating || !rawInputEnabled || event.button !== 0) return;
    flushPendingText();
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
    if (!rawInputEnabled) return;
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const from = point(start.frame, start.x, start.y);
    const to = point(start.frame, event.clientX, event.clientY);
    if (!from || !to) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
      flushPendingClick();
      enqueue(
        {
          type: "pointer",
          frameId: start.frame.frameId,
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
      enqueue(
        {
          type: "pointer",
          frameId: start.frame.frameId,
          action: "double_click",
          x: to.x,
          y: to.y,
        },
        start.frame,
      );
      return;
    }
    lastClickRef.current = { at: now, x: to.x, y: to.y, frame: start.frame };
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      lastClickRef.current = null;
      enqueue(
        {
          type: "pointer",
          frameId: start.frame.frameId,
          action: "click",
          x: to.x,
          y: to.y,
        },
        start.frame,
      );
    }, 280);
  };

  const contextMenu = (event: MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (!rawInputEnabled) return;
    const frame = props.frame;
    if (!frame) return;
    flushPendingText();
    flushPendingClick();
    const at = point(frame, event.clientX, event.clientY);
    if (at) {
      enqueue(
        {
          type: "pointer",
          frameId: frame.frameId,
          action: "click",
          x: at.x,
          y: at.y,
          button: "right",
        },
        frame,
      );
    }
  };

  const wheel = (event: WheelEvent<HTMLCanvasElement>) => {
    if (!rawInputEnabled) return;
    const frame = props.frame;
    if (!frame) return;
    const at = point(frame, event.clientX, event.clientY);
    if (!at) return;
    flushPendingText();
    flushPendingClick();
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
        if (batch) {
          enqueue(
            {
              type: "pointer",
              frameId: batch.frame.frameId,
              action: "scroll",
              x: batch.x,
              y: batch.y,
              deltaX: batch.deltaX,
              deltaY: batch.deltaY,
            },
            batch.frame,
          );
        }
      }, 45),
    };
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!rawInputEnabled) return;
    const command = event.metaKey || event.ctrlKey;
    if (
      props.clipboardEnabled &&
      command &&
      !event.altKey &&
      ["c", "v"].includes(event.key.toLowerCase())
    ) {
      flushPendingText();
      return;
    }
    const key = computerKey(event);
    if (!key) return;
    event.preventDefault();
    flushPendingText();
    flushPendingClick();
    enqueue({ type: "keyboard", action: "press", value: key }, null);
  };

  const copy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.clipboardEnabled || !rawInputEnabled) return;
    event.preventDefault();
    flushPendingText();
    flushPendingClick();
    enqueue({ type: "clipboard", operation: "copy" }, null, async () => {
      const clipboard = await readClipboardRef.current();
      if (!clipboard.text) return;
      if (!(await copyTextToClipboard(clipboard.text))) {
        throw new Error("Desktop text could not be copied to the local clipboard");
      }
    });
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.clipboardEnabled || !rawInputEnabled) return;
    event.preventDefault();
    flushPendingText();
    flushPendingClick();
    const text = event.clipboardData.getData("text/plain");
    enqueue({ type: "clipboard", operation: "write", text }, null, async () => {
      assertExactComputerClipboard(await readClipboardRef.current(), text);
      await actionRef.current({ type: "clipboard", operation: "paste" }, null);
    });
  };

  const input = (value: string) => {
    if (!value || !rawInputEnabled) return;
    flushPendingClick();
    const pending = pendingTextRef.current;
    if (pending) {
      clearTimeout(pending.timer);
      pending.text += value;
      pending.timer = setTimeout(flushPendingText, 16);
    } else {
      pendingTextRef.current = {
        text: value,
        timer: setTimeout(flushPendingText, 16),
      };
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const showCanvas = props.frame !== null && !props.machineLocked;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className={cn(
          "absolute inset-0 m-auto max-h-full max-w-full touch-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent",
          !showCanvas && "invisible",
          !rawInputEnabled && "cursor-default",
        )}
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          pointerStartRef.current = null;
        }}
        onContextMenu={contextMenu}
        onWheel={wheel}
        aria-label={`Interactive ${props.target?.kind ?? "desktop"} view`}
      />
      <textarea
        ref={inputRef}
        defaultValue=""
        onInput={(event) => input(event.currentTarget.value)}
        onKeyDown={keyDown}
        onCopy={copy}
        onPaste={paste}
        className="pointer-events-none absolute left-1/2 top-1/2 size-px resize-none overflow-hidden opacity-0"
        aria-label="Desktop keyboard input"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!rawInputEnabled}
      />
      {!showCanvas ? (
        <ComputerViewportFallback
          observation={props.observation}
          machineLocked={props.machineLocked}
          connectionState={props.connectionState}
          error={props.connectionError}
          onAction={(action) => enqueue(action, null)}
          onReconnect={props.onReconnect}
        />
      ) : null}
      {props.mutating ? (
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-[11px] text-white/80 backdrop-blur">
          <LoaderCircleIcon className="size-3 animate-spin" /> Acting
        </div>
      ) : null}
      {showCanvas && !rawInputEnabled ? (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/70 py-1 pl-3 pr-1 text-[11px] text-white/80 backdrop-blur">
          <span>Background view · use native controls</span>
          {props.target ? (
            <button
              type="button"
              disabled={props.mutating}
              onClick={() => enqueue({ type: "focus", targetId: props.target!.id }, null)}
              className="rounded-full bg-white/10 px-2 py-0.5 font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
            >
              Control directly
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function assertExactComputerClipboard(clipboard: ComputerClipboard, expected: string): void {
  if (clipboard.truncated || clipboard.text !== expected) {
    throw new Error("Desktop clipboard did not accept the exact pasted text");
  }
}

function ComputerViewportFallback(props: {
  observation: ComputerObservation | null;
  machineLocked: boolean;
  connectionState: string;
  error: Error | null;
  onAction: (action: ComputerAction) => void;
  onReconnect: () => void;
}) {
  if (props.machineLocked) {
    return (
      <div className="absolute inset-0 grid place-items-center bg-og-bg p-6">
        <div className="max-w-sm text-center">
          <LockKeyholeIcon className="mx-auto size-6 text-og-muted" />
          <p className="mt-3 text-og-menu font-medium text-og-fg">Machine locked</p>
          <p className="mt-1 text-og-control leading-5 text-og-muted">
            Live frames and input stay private until someone unlocks the machine.
          </p>
        </div>
      </div>
    );
  }
  const controlFailure = interactionControlFailureFromError(props.error);
  const interactive = semanticNodes(props.observation)
    .filter((node) => semanticAction(node) !== null)
    .slice(0, 10);
  return (
    <div className="absolute inset-0 grid place-items-center bg-og-bg p-6">
      <div className="w-full max-w-md rounded-og-lg border border-og-border bg-og-surface-0 p-4 shadow-lg">
        <div className="flex items-center gap-2">
          {props.error ? (
            <CircleAlertIcon className="size-4 text-og-status-error" />
          ) : (
            <LoaderCircleIcon className="size-4 animate-spin text-og-muted" />
          )}
          <p className="text-og-menu font-medium text-og-fg">
            {props.error
              ? "Live view disconnected"
              : computerConnectionLabel(props.connectionState)}
          </p>
        </div>
        {props.error ? (
          <p className="mt-2 text-og-control leading-5 text-og-muted">
            {controlFailure?.message ?? props.error.message}
          </p>
        ) : null}
        {interactive.length > 0 ? (
          <div className="mt-3 border-t border-og-border pt-3">
            <p className="mb-2 text-og-xs text-og-subtle">Native controls remain available</p>
            <div className="flex flex-wrap gap-1.5">
              {interactive.map((node) => (
                <button
                  key={node.ref}
                  type="button"
                  onClick={() => {
                    const action = semanticAction(node);
                    if (action) props.onAction(action);
                  }}
                  className="rounded-og-sm border border-og-border bg-og-surface-1 px-2 py-1 text-og-control text-og-fg transition hover:bg-og-surface-2"
                >
                  {node.name || node.role}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {props.error ? (
          <button
            type="button"
            onClick={props.onReconnect}
            className="mt-3 text-og-control font-medium text-og-accent hover:underline"
          >
            {controlFailure?.retryable === false ? "Try again" : "Reconnect"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComputerSemanticPanel(props: {
  observation: ComputerObservation | null;
  mutating: boolean;
  onAction: (action: ComputerAction) => void;
}) {
  const nodes = semanticNodes(props.observation).slice(0, 100);
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-l border-og-border bg-og-surface-0 p-2">
      <div className="mb-2 flex items-center gap-1.5 px-1 text-og-xs font-medium uppercase tracking-[0.1em] text-og-subtle">
        <KeyboardIcon className="size-3" /> Native controls
      </div>
      {nodes.length === 0 ? (
        <p className="px-1 py-2 text-og-control leading-5 text-og-muted">
          This view has no accessibility controls. Use the live image instead.
        </p>
      ) : (
        <div className="space-y-0.5">
          {nodes.map((node) => (
            <ComputerSemanticControl
              key={node.ref}
              node={node}
              mutating={props.mutating}
              onAction={props.onAction}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function ComputerSemanticControl(props: {
  node: InteractionSemanticNode;
  mutating: boolean;
  onAction: (action: ComputerAction) => void;
}) {
  const { node } = props;
  const editable = node.actions.includes("set_value");
  const action = semanticAction(node);
  const observedValue = semanticValue(node) ?? "";
  const [value, setValue] = useState(() => observedValue);

  useEffect(() => {
    setValue(observedValue);
  }, [node.ref, observedValue]);

  if (editable) {
    return (
      <form
        className="rounded-og-sm px-2 py-1.5 hover:bg-og-surface-2"
        onSubmit={(event) => {
          event.preventDefault();
          props.onAction({
            type: "semantic",
            locator: { kind: "ref", ref: node.ref },
            action: "set_value",
            value,
          });
        }}
      >
        <label className="block truncate text-[10px] uppercase text-og-subtle">
          {node.name || node.identifier || node.role}
        </label>
        <div className="mt-1 flex gap-1">
          <input
            value={value}
            disabled={props.mutating}
            onChange={(event) => setValue(event.currentTarget.value)}
            className="min-w-0 flex-1 rounded-og-sm border border-og-border bg-og-surface-1 px-1.5 py-1 text-og-control text-og-fg outline-hidden focus:border-og-accent"
            aria-label={`Set ${node.name || node.identifier || node.role}`}
          />
          <button
            type="submit"
            disabled={props.mutating}
            className="rounded-og-sm border border-og-border bg-og-surface-1 px-2 text-og-control font-medium text-og-fg transition hover:bg-og-surface-2 disabled:opacity-50"
          >
            Set
          </button>
        </div>
      </form>
    );
  }

  return (
    <button
      type="button"
      disabled={!action || props.mutating}
      onClick={() => {
        if (action) props.onAction(action);
      }}
      className="flex w-full items-start gap-2 rounded-og-sm px-2 py-1.5 text-left transition hover:bg-og-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="mt-0.5 text-[10px] uppercase text-og-subtle">{node.role}</span>
      <span className="min-w-0 flex-1 truncate text-og-control text-og-fg">
        {node.name || semanticValue(node) || node.identifier || "Unnamed control"}
      </span>
    </button>
  );
}

function ComputerStatusBar(props: {
  session: ComputerSession | null;
  target: ComputerTarget | null;
  connectionState: string;
  refreshing: boolean;
  showControls: boolean;
  controlCount: number;
  onToggleControls: () => void;
}) {
  const screen = props.target?.kind === "screen";
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-og-border bg-og-surface-0 px-2 text-og-xs text-og-subtle">
      <span
        className={cn(
          "size-1.5 rounded-full",
          props.connectionState === "live" ? "bg-og-status-running" : "bg-og-muted",
        )}
      />
      <span>
        {props.connectionState === "live" ? "Live" : computerConnectionLabel(props.connectionState)}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {screen
          ? "Full screen · input may move pointer and focus"
          : props.session?.capabilities?.backgroundActions
            ? "Window · semantic controls stay in the background"
            : (props.target?.kind ?? "Desktop")}
      </span>
      {screen ? <MousePointer2Icon className="size-3" aria-hidden /> : null}
      {props.refreshing ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
      <button
        type="button"
        onClick={props.onToggleControls}
        aria-pressed={props.showControls}
        className={cn(
          "rounded px-1.5 py-0.5 transition hover:bg-og-surface-2 hover:text-og-fg",
          props.showControls && "bg-og-surface-2 text-og-fg",
        )}
      >
        Controls {props.controlCount}
      </button>
    </div>
  );
}

function ComputerNotice(props: { icon: ReactNode; text: string; className?: string }) {
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

function semanticNodes(observation: ComputerObservation | null): InteractionSemanticNode[] {
  if (observation?.semantic?.kind !== "snapshot") return [];
  const result: InteractionSemanticNode[] = [];
  const visit = (node: InteractionSemanticNode) => {
    result.push(node);
    node.children?.forEach(visit);
  };
  observation.semantic.roots.forEach(visit);
  return result;
}

function semanticAction(node: InteractionSemanticNode): ComputerAction | null {
  const invoke = ["invoke", "press", "click"].some((action) => node.actions.includes(action));
  if (invoke) {
    return {
      type: "semantic",
      locator: { kind: "ref", ref: node.ref },
      action: "invoke",
    };
  }
  // A row in the background-native controls panel must never become an
  // implicit foregrounding gesture. Focus remains available through the typed
  // SDK/tool action when the caller explicitly intends to take the shared seat.
  return null;
}

function semanticValue(node: InteractionSemanticNode): string | null {
  return typeof node.value === "string" ? node.value : null;
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
  if (!context) throw new Error("Desktop canvas is unavailable.");
  context.drawImage(image, 0, 0, width, height);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Desktop frame image could not be decoded."));
    image.src = url;
  });
}

function computerPoint(
  canvas: HTMLCanvasElement | null,
  frame: ComputerFrame,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.max(0, Math.min(frame.width - 1, ((clientX - rect.left) / rect.width) * frame.width)),
    y: Math.max(0, Math.min(frame.height - 1, ((clientY - rect.top) / rect.height) * frame.height)),
  };
}

export function computerKey(
  event: Pick<
    KeyboardEvent<HTMLTextAreaElement>,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >,
): string | null {
  if (["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key)) return null;
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
    "Home",
    "End",
    "PageUp",
    "PageDown",
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

function sameFrameFence(left: ComputerFrame, right: ComputerFrame): boolean {
  return (
    left.frameId === right.frameId &&
    left.computerSessionId === right.computerSessionId &&
    left.targetId === right.targetId &&
    left.targetGeneration === right.targetGeneration
  );
}

function isLiveComputer(session: ComputerSession): boolean {
  return !["ending", "ended", "failed", "lost"].includes(session.lifecycle);
}

function computerFailureMessage(session: ComputerSession): string | null {
  switch (session.failureCode) {
    case "machine_locked":
      return "Unlock the connected Mac, then try again.";
    case "controller_heartbeat_expired":
      return "The desktop connection was lost. Try opening it again.";
    case null:
      return null;
    default:
      return "The desktop could not be opened. Try again.";
  }
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
      return "Desktop needs your help";
  }
}

function platformLabel(session: ComputerSession): string {
  switch (session.platform) {
    case "macos":
      return "Mac";
    case "linux":
      return "Linux";
    case "windows":
      return "Windows";
    default:
      return "Desktop";
  }
}

function placementLabel(session: ComputerSession): string {
  switch (session.placement.kind) {
    case "sandbox_group":
      return "Agent sandbox";
    case "connected_machine":
      return "Connected machine";
    case "attached_device":
      return "Your machine";
    case "external_provider":
      return "Cloud desktop";
  }
}

function lifecycleLabel(lifecycle: ComputerSession["lifecycle"]): string {
  switch (lifecycle) {
    case "starting":
      return "Opening desktop…";
    case "suspending":
      return "Pausing desktop…";
    case "suspended":
      return "Desktop paused";
    case "restoring":
      return "Restoring desktop…";
    case "ending":
      return "Closing desktop…";
    default:
      return "Connecting to desktop…";
  }
}

function computerConnectionLabel(state: string): string {
  switch (state) {
    case "attaching":
      return "Opening desktop view…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Disconnected";
    default:
      return "Waiting for desktop…";
  }
}
