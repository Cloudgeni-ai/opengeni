import type {
  ComputerAction,
  ComputerFrame,
  ComputerObservation,
  ComputerSession,
  ComputerTarget,
  InteractionIntervention,
  InteractionSemanticNode,
} from "@opengeni/sdk/interaction";
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
import type { EmbeddedComputerInteractionClientOverride } from "../session-context";
import { InteractionInterventionBanner } from "./interaction-intervention-banner";

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
  const liveSessions = useMemo(
    () => registry.sessions.filter((session) => isLiveComputer(session)),
    [registry.sessions],
  );
  const relevant = useMemo(
    () => registry.relevantSessions.filter((session) => isLiveComputer(session)),
    [registry.relevantSessions],
  );
  const [selection, setSelection] = useState<ComputerSelection>(null);
  const interventions = useInteractionInterventions({
    ...override,
    enabled,
    resourceKind: "computer_session",
  });
  const [creating, setCreating] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const previousSessionIdRef = useRef(sessionId);
  const handledRequestRef = useRef<string | null>(null);
  const seenInterventionIdsRef = useRef(new Set<string>());

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
    const preferred = relevant[0] ?? liveSessions[0] ?? null;
    if (!preferred) {
      if (selection) setSelection(null);
      return;
    }
    if (!selectedStillLive || !selection) {
      setSelection({ sessionId: preferred.id, pinned: false });
      return;
    }
    if (!selection.pinned && relevant[0] && selection.sessionId !== relevant[0].id) {
      setSelection({ sessionId: relevant[0].id, pinned: false });
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
    enabled: enabled && selection !== null && controllerReady && computer.selectedTarget !== null,
    stream: { format: "jpeg", quality: 82, maxWidth: 1_920, maxHeight: 1_200 },
    ...(webSocketFactory ? { webSocketFactory } : {}),
  });
  const displayedFrame =
    frames.frame &&
    frames.frame.computerSessionId === selection?.sessionId &&
    frames.frame.targetId === computer.selectedTarget?.id
      ? frames.frame
      : null;
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
        .catch((cause) => notifyError(cause, "Could not update the computer request."));
    },
    [interventions, notifyError, onNotify],
  );

  const createComputer = useCallback(() => {
    if (creating) return;
    setCreating(true);
    void createSession({ sessionId, name: "Computer" })
      .then((response) => {
        setSelection({ sessionId: response.session.id, pinned: false });
      })
      .catch((cause) => notifyError(cause, "Could not open a computer."))
      .finally(() => setCreating(false));
  }, [createSession, creating, notifyError, sessionId]);

  const perform = useCallback(
    async (action: ComputerAction, frame: ComputerFrame | null): Promise<void> => {
      if (action.type === "pointer") {
        if (!frame) throw new Error("Computer view is not ready for pointer input.");
        await actFromFrame(action, frame);
      } else {
        await act(action);
      }
    },
    [act, actFromFrame],
  );

  if (!enabled) return null;
  if (registry.loading && liveSessions.length === 0) {
    return (
      <ComputerNotice
        icon={<LoaderCircleIcon className="size-4 animate-spin" />}
        text="Finding workspace computers…"
        {...(className ? { className } : {})}
      />
    );
  }
  if (liveSessions.length === 0) {
    if (renderEmpty) return renderEmpty(createComputer, creating);
    return (
      <div className={cn("grid h-full place-items-center bg-og-bg p-6", className)}>
        <div className="max-w-sm text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-og-lg border border-og-border bg-og-surface-1 text-og-muted">
            <MonitorIcon className="size-5" />
          </span>
          <p className="mt-3 text-og-menu font-medium text-og-fg">No computer open</p>
          <p className="mt-1 text-og-control leading-5 text-og-muted">
            Open this agent&apos;s desktop, or switch to any computer another workspace agent uses.
          </p>
          <button
            type="button"
            onClick={createComputer}
            disabled={creating}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-og-sm bg-og-accent-deep px-3 text-og-control font-medium text-og-accent-fg transition hover:brightness-110 disabled:opacity-50"
          >
            {creating ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            Open computer
          </button>
          {registry.error ? (
            <p className="mt-3 text-og-control text-og-status-error">{registry.error.message}</p>
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
            .catch((cause) => notifyError(cause, "Could not open the requested computer view."))
        }
        onResolve={resolveIntervention}
      />
      {selectedRegistrySession && !controllerReady ? (
        <ComputerLifecyclePanel session={selectedRegistrySession} onRefresh={registry.refresh} />
      ) : (
        <>
          <ComputerTargetRail
            targets={computer.targets}
            selectedTargetId={computer.selectedTarget?.id ?? null}
            loading={computer.loading}
            onSelect={(targetId) =>
              void computer
                .selectTarget(targetId)
                .catch((cause) => notifyError(cause, "Could not switch computer views."))
            }
          />
          <div className="flex min-h-0 flex-1">
            <ComputerViewport
              frame={machineLocked ? null : displayedFrame}
              observation={computer.observation}
              target={computer.selectedTarget}
              machineLocked={machineLocked}
              connectionState={frames.state}
              connectionError={frames.error ?? computer.error}
              mutating={computer.mutating}
              onAction={perform}
              onReconnect={frames.reconnect}
              onError={(cause) => notifyError(cause, "Computer input failed.")}
            />
            {showControls ? (
              <ComputerSemanticPanel
                observation={computer.observation}
                mutating={computer.mutating}
                onAction={(action) =>
                  void perform(action, null).catch((cause) =>
                    notifyError(cause, "Computer action failed."),
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
          <span className="truncate font-medium">{selected?.name ?? "Computer"}</span>
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
              <PlusIcon className="size-3.5" /> New computer
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
        aria-label="Refresh computers"
      >
        <RefreshCwIcon className={cn("size-3.5", props.refreshing && "animate-spin")} />
      </button>
      <button
        type="button"
        onClick={props.onCreate}
        disabled={props.creating}
        className="grid size-7 place-items-center rounded-og-sm text-og-muted transition hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-40"
        aria-label="Open a new computer"
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
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-og-border bg-og-surface-0 px-2"
      aria-label="Computer views"
    >
      {props.targets.map((target) => (
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
      {!props.loading && props.targets.length === 0 ? (
        <span className="text-og-xs text-og-subtle">Waiting for apps and screens…</span>
      ) : null}
    </div>
  );
}

function ComputerLifecyclePanel(props: {
  session: ComputerSession;
  onRefresh: () => Promise<void>;
}) {
  const failed = ["failed", "lost", "repair_required"].includes(props.session.lifecycle);
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-og-bg p-6">
      <div className="max-w-sm text-center">
        {failed ? (
          <CircleAlertIcon className="mx-auto size-5 text-og-status-error" />
        ) : (
          <LoaderCircleIcon className="mx-auto size-5 animate-spin text-og-muted" />
        )}
        <p className="mt-3 text-og-menu font-medium text-og-fg">
          {failed ? "Computer needs attention" : lifecycleLabel(props.session.lifecycle)}
        </p>
        <p className="mt-1 text-og-control leading-5 text-og-muted">
          {props.session.failureCode ??
            "The computer is being prepared on its placement. It will appear here when ready."}
        </p>
        {failed ? (
          <button
            type="button"
            onClick={() => void props.onRefresh()}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-og-sm border border-og-border bg-og-surface-1 px-3 text-og-control font-medium text-og-fg transition hover:bg-og-surface-2"
          >
            <RotateCcwIcon className="size-3.5" /> Check again
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
  onAction: (action: ComputerAction, frame: ComputerFrame | null) => Promise<void>;
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
  const actionRef = useRef(props.onAction);
  const errorRef = useRef(props.onError);
  const actionTailRef = useRef<Promise<void>>(Promise.resolve());
  actionRef.current = props.onAction;
  errorRef.current = props.onError;

  useEffect(() => {
    const frame = props.frame;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const blob = new Blob([frame.data.slice().buffer], { type: frame.mediaType });
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

  const enqueue = useCallback((action: ComputerAction, frame: ComputerFrame | null) => {
    actionTailRef.current = actionTailRef.current
      .catch(() => undefined)
      .then(async () => await actionRef.current(action, frame))
      .catch((cause) => errorRef.current(cause));
  }, []);

  const point = useCallback(
    (frame: ComputerFrame, clientX: number, clientY: number) =>
      computerPoint(canvasRef.current, frame, clientX, clientY),
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
    const frame = props.frame;
    if (!frame) return;
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
    const key = computerKey(event);
    if (!key) return;
    event.preventDefault();
    enqueue({ type: "keyboard", action: "press", value: key }, null);
  };

  const input = (value: string) => {
    if (!value) return;
    enqueue({ type: "keyboard", action: "type", value }, null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const showCanvas = props.frame !== null && !props.machineLocked;
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
        aria-label={`Interactive ${props.target?.kind ?? "computer"} view`}
      />
      <textarea
        ref={inputRef}
        defaultValue=""
        onInput={(event) => input(event.currentTarget.value)}
        onKeyDown={keyDown}
        className="pointer-events-none absolute left-1/2 top-1/2 size-px resize-none overflow-hidden opacity-0"
        aria-label="Computer keyboard input"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
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
    </div>
  );
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
            Reconnect
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
          {nodes.map((node) => {
            const action = semanticAction(node);
            return (
              <button
                key={node.ref}
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
          })}
        </div>
      )}
    </aside>
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
            ? "Window · native actions can stay in the background"
            : (props.target?.kind ?? "Computer")}
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
  if (node.actions.includes("focus")) {
    return {
      type: "semantic",
      locator: { kind: "ref", ref: node.ref },
      action: "focus",
    };
  }
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
  if (!context) throw new Error("Computer canvas is unavailable.");
  context.drawImage(image, 0, 0, width, height);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Computer frame image could not be decoded."));
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

function computerKey(event: KeyboardEvent<HTMLTextAreaElement>): string | null {
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
      return "Computer needs your help";
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
      return "Computer";
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
      return "Cloud computer";
  }
}

function lifecycleLabel(lifecycle: ComputerSession["lifecycle"]): string {
  switch (lifecycle) {
    case "starting":
      return "Opening computer…";
    case "suspending":
      return "Pausing computer…";
    case "suspended":
      return "Computer paused";
    case "restoring":
      return "Restoring computer…";
    case "ending":
      return "Closing computer…";
    default:
      return "Connecting to computer…";
  }
}

function computerConnectionLabel(state: string): string {
  switch (state) {
    case "attaching":
      return "Opening computer view…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Disconnected";
    default:
      return "Waiting for computer…";
  }
}
