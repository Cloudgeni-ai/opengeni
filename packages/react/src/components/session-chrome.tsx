/**
 * SessionChrome — compact merged session signals above the composer.
 *
 * Built-in session chrome for production and embeds. Token-themed
 * (`--og-session-chrome-*`); hosts override on `.og-session-chrome` or an ancestor.
 *
 * ## Host tokens
 * Defaults live in `tokens.css`.
 *
 * | Token | Role |
 * | --- | --- |
 * | `--og-session-chrome-surface` / `-open` | Dock fill (collapsed / expanded) |
 * | `--og-session-chrome-border` / `-open` | Dock edge |
 * | `--og-session-chrome-highlight` / `-ring` | Sliding chip selection fill + edge |
 * | `--og-session-chrome-shadow` / `-open` | Elevation |
 * | `--og-session-chrome-radius` | Dock corner radius |
 * | `--og-session-chrome-chip-min-height` | Signal chip height |
 * | `--og-session-chrome-chip-pad-x` / `--og-session-chrome-chip-gap` | Chip padding / rail gap |
 * | `--og-session-chrome-rail-pad` | Outer rail inset |
 * | `--og-session-chrome-panel-pad-x` / `-y` | Expanded panel padding |
 * | `--og-session-chrome-panel-max-height` | Cap for expanded body (scrolls inside) |
 * | `--og-session-chrome-duration` / `--og-session-chrome-ease` | Expand + pill motion |
 * | `--og-session-chrome-crossfade-duration` | Segment content opacity crossfade |
 * | `--og-session-chrome-row-hover` | Inbox / queue row hover wash |
 *
 * Inbox and queue stay separate segments. Clear queue actions wire to
 * `UseTurnQueueResult` (`editTurn` / `steerTurn` / `moveTurn` / `removeTurn`).
 * Inbox has no product dismiss API; pass `onDismissIncoming` when the host
 * wants a visible action (dev harness may use a local dummy).
 *
 * Segment switches keep the panel shell mounted and crossfade content while
 * animating measured height — no `mode="wait"` unmount flash.
 */
import type {
  EffectiveSessionControl,
  SessionGoal,
  SessionPendingInputPreview,
  SessionStatus,
  SessionTurn,
} from "@opengeni/sdk";
import {
  AudioLinesIcon,
  BotIcon,
  InboxIcon,
  ListOrderedIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { ComposerOptimisticMessage, ComposerState } from "../hooks/use-composer";
import type { UseGoalResult } from "../hooks/use-goal";
import type { UseTurnQueueResult } from "../hooks/use-turn-queue";
import { cn } from "../lib/cn";
import { requestQueueDraftEdit } from "./queue-draft-policy";

export type SessionChromeSignalId = "incoming" | "steering" | "queue" | "goal" | "agents";

export type SessionChromeSignalTone = "neutral" | "accent" | "waiting" | "running";

export type SessionChromeAgentsSignal = {
  count: number;
  detail?: string | undefined;
  tone?: SessionChromeSignalTone | undefined;
};

export type SessionChromeProps = {
  queue: UseTurnQueueResult;
  /** Needed for queue edit → composer checkout. Omit with `readOnly`. */
  composer?: ComposerState | undefined;
  goal?: UseGoalResult | null | undefined;
  /** Expanded agents body (host supplies tree / list). */
  agentsPanel?: ReactNode;
  /** Chip summary; when `count > 0` the agents segment appears. */
  agentsSignal?: SessionChromeAgentsSignal | undefined;
  /**
   * Optional inbox dismiss. Product pending-inputs have no remove API — hosts
   * (and the gallery) may still pass a handler so the action is visible.
   */
  onDismissIncoming?: ((inputId: string) => void) | undefined;
  /** Current durable session status, when the host can explain queue admission. */
  sessionStatus?: SessionStatus | null | undefined;
  readOnly?: boolean | undefined;
  className?: string | undefined;
  /** Controlled active segment; omit for uncontrolled. */
  active?: SessionChromeSignalId | null | undefined;
  defaultActive?: SessionChromeSignalId | null | undefined;
  onActiveChange?: ((next: SessionChromeSignalId | null) => void) | undefined;
};

type GoalPillState =
  | "pursuing"
  | "scheduled"
  | "blocked"
  | "held"
  | "paused"
  | "invariant_broken"
  | "completed";

type QueuedTurnPresentation = {
  kind: "prompt" | "realtime_voice" | "realtime_voice_handoff";
  text: string;
};

const GOAL_LABEL: Record<GoalPillState, string> = {
  pursuing: "Pursuing",
  scheduled: "Scheduled",
  blocked: "Blocked",
  held: "Held",
  paused: "Paused",
  invariant_broken: "Needs attention",
  completed: "Done",
};

function queuedTurnPresentation(turn: SessionTurn): QueuedTurnPresentation {
  const realtimeDelegation = objectValue(turn.metadata.realtimeDelegation);
  const inputTranscript = realtimeDelegation?.inputTranscript;
  if (typeof inputTranscript === "string" && inputTranscript.trim()) {
    return { kind: "realtime_voice", text: inputTranscript.trim() };
  }
  if (objectValue(turn.metadata.realtimeTailFlush)) {
    return { kind: "realtime_voice_handoff", text: "Remaining voice context" };
  }
  return { kind: "prompt", text: turn.prompt };
}

function isSteeringTurn(turn: SessionTurn): boolean {
  return turn.metadata.delivery === "steer";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Select pill state from the goal's authoritative continuation projection. */
export function sessionChromeGoalPillState(
  goalStatus: "active" | "paused" | "completed",
  continuation: SessionGoal["continuation"] | null | undefined,
): GoalPillState {
  if (goalStatus === "completed") return "completed";
  if (goalStatus === "paused") return "paused";
  if (!continuation) return "invariant_broken";
  if (continuation.state === "running") {
    return continuation.reason === "goal_turn_running"
      ? "pursuing"
      : continuation.reason === "human_turn_running"
        ? "blocked"
        : "invariant_broken";
  }
  if (continuation.state === "scheduled") return "scheduled";
  if (continuation.state === "blocked") {
    return continuation.reason === "workstream_paused" ? "held" : "blocked";
  }
  return "invariant_broken";
}

function formatCoarseElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function useLiveElapsed(
  startIso: string | null | undefined,
  live: boolean,
  endIso?: string | null,
) {
  const start = startIso ? Date.parse(startIso) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live]);
  if (!Number.isFinite(start)) return null;
  const end = live ? now : endIso ? Date.parse(endIso) : now;
  return formatCoarseElapsed((Number.isFinite(end) ? end : now) - start);
}

function pendingKindLabel(kind: SessionPendingInputPreview["kind"]): string {
  switch (kind) {
    case "child_terminal_result":
      return "Child result";
    case "agent_steer_instruction":
      return "Steer";
    case "scheduled_occurrence":
      return "Schedule";
    case "goal_continuation":
      return "Goal wake";
    case "agent_message":
      return "Update";
    default:
      return "Incoming";
  }
}

function toneClass(tone: SessionChromeSignalTone, selected: boolean): string {
  switch (tone) {
    case "accent":
      return "text-og-accent";
    case "waiting":
      return "text-og-status-waiting";
    case "running":
      return "text-og-status-running";
    default:
      return selected ? "text-og-fg" : "text-og-fg-subtle";
  }
}

export function SessionChrome({
  queue,
  composer,
  goal,
  agentsPanel,
  agentsSignal,
  onDismissIncoming,
  sessionStatus,
  readOnly = false,
  className,
  active: activeControlled,
  defaultActive = null,
  onActiveChange,
}: SessionChromeProps) {
  const reactId = useId();
  const panelId = `og-session-chrome-panel-${reactId}`;
  const reduceMotion = useReducedMotion();
  const record = goal?.goal ?? null;
  const incoming = queue.pendingInputs;
  const turns = queue.queue;
  const queueIssue = queue.mutationError ?? queue.error;
  const composerSteering = composer?.steering ?? null;
  const composerOptimisticMessages = composer?.optimisticMessages;
  const { steering, queuedTurns } = useMemo(() => {
    const pendingQueueSteer =
      turns.find((turn) => queue.pendingByTurn[turn.id] === "steer") ?? null;
    const durableQueueSteer =
      !pendingQueueSteer && turns[0] && isSteeringTurn(turns[0]) ? turns[0] : null;
    const currentSteering =
      composerSteering?.phase === "submitting"
        ? composerSteering
        : pendingQueueSteer
          ? {
              phase: "submitting" as const,
              text: queuedTurnPresentation(pendingQueueSteer).text,
              turnId: pendingQueueSteer.id,
            }
          : durableQueueSteer
            ? {
                phase: "accepted" as const,
                text: queuedTurnPresentation(durableQueueSteer).text,
                turnId: durableQueueSteer.id,
              }
            : composerSteering;
    const currentTurnId = currentSteering?.turnId ?? null;
    return {
      steering: currentSteering,
      queuedTurns: currentTurnId ? turns.filter((turn) => turn.id !== currentTurnId) : turns,
    };
  }, [composerSteering, queue.pendingByTurn, turns]);
  const optimisticQueuedMessages = useMemo(() => {
    const durableTriggerIds = new Set(turns.map((turn) => turn.triggerEventId));
    return (composerOptimisticMessages ?? []).filter(
      (message) =>
        message.state !== "failed" &&
        (!message.triggerEventId || !durableTriggerIds.has(message.triggerEventId)),
    );
  }, [composerOptimisticMessages, turns]);
  const stoppingKind =
    composer?.stoppingAttempt ??
    (queue.stoppingPreviousAttempt
      ? queue.effectiveControl?.state === "paused"
        ? "current"
        : "previous"
      : null);
  const stopping = stoppingKind !== null;
  const canMutateQueue = !readOnly && composer !== undefined;

  const liveGoal =
    record?.status === "active" &&
    record.continuation?.state === "running" &&
    record.continuation.reason === "goal_turn_running";
  const elapsed = useLiveElapsed(
    record?.createdAt,
    Boolean(liveGoal),
    !liveGoal ? record?.updatedAt : null,
  );
  const goalState = record ? sessionChromeGoalPillState(record.status, record.continuation) : null;

  const signals = useMemo(() => {
    const rows: Array<{
      id: SessionChromeSignalId;
      label: string;
      detail?: string | undefined;
      tone: SessionChromeSignalTone;
      icon: ReactNode;
    }> = [];
    if (incoming.length > 0) {
      const detail = incoming[0]?.summary;
      rows.push({
        id: "incoming",
        label: `${incoming.length} in`,
        ...(detail ? { detail } : {}),
        tone: incoming.some(
          (item) => item.classification === "action_required" || item.classification === "failure",
        )
          ? "waiting"
          : "neutral",
        icon: <InboxIcon className="size-3" />,
      });
    }
    if (steering || stopping) {
      rows.push({
        id: "steering",
        label: stopping
          ? stoppingKind === "current"
            ? "Stopping current work…"
            : "Stopping previous work…"
          : "Changing direction…",
        ...(steering?.text ? { detail: steering.text } : {}),
        tone: stopping ? "waiting" : "accent",
        icon:
          steering?.phase === "submitting" || stopping ? (
            <Loader2Icon className="size-3 animate-og-spin" />
          ) : (
            <ZapIcon className="size-3" />
          ),
      });
    }
    if (queuedTurns.length > 0 || optimisticQueuedMessages.length > 0 || queueIssue) {
      const first = queuedTurns[0]
        ? queuedTurnPresentation(queuedTurns[0])
        : optimisticQueuedMessages[0]
          ? { kind: "prompt" as const, text: optimisticQueuedMessages[0].text }
          : undefined;
      const presentationCount = queuedTurns.length + optimisticQueuedMessages.length;
      const allVoiceRequests =
        optimisticQueuedMessages.length === 0 &&
        queuedTurns.length > 0 &&
        queuedTurns.every((turn) => queuedTurnPresentation(turn).kind === "realtime_voice");
      const onlyVoiceHandoff = presentationCount === 1 && first?.kind === "realtime_voice_handoff";
      const voiceOnly = allVoiceRequests || onlyVoiceHandoff;
      const detail = first?.text;
      const sendingCount = optimisticQueuedMessages.filter(
        (message) => message.state === "sending",
      ).length;
      const queuedCount = presentationCount - sendingCount;
      rows.push({
        id: "queue",
        label: queueIssue
          ? queue.mutationError
            ? "Queue action failed"
            : "Queue unavailable"
          : sendingCount > 0
            ? queuedCount > 0
              ? `${queuedCount} queued · ${sendingCount} sending`
              : sendingCount === 1
                ? "Sending prompt…"
                : `${sendingCount} prompts sending…`
            : allVoiceRequests
              ? queuedTurns.length === 1
                ? "Voice request queued"
                : `${queuedTurns.length} voice requests queued`
              : onlyVoiceHandoff
                ? "Voice handoff queued"
                : `${presentationCount} queued prompt${presentationCount === 1 ? "" : "s"}`,
        ...(queueIssue ? { detail: queueIssue.message } : detail ? { detail } : {}),
        tone: queueIssue ? "waiting" : "neutral",
        icon: queueIssue ? (
          <TriangleAlertIcon className="size-3" />
        ) : voiceOnly ? (
          <AudioLinesIcon className="size-3" />
        ) : (
          <ListOrderedIcon className="size-3" />
        ),
      });
    }
    if (record && goalState) {
      const waiting = goalState === "blocked" || goalState === "held" || goalState === "paused";
      rows.push({
        id: "goal",
        label: GOAL_LABEL[goalState],
        detail: elapsed ? `${elapsed} · ${record.text}` : record.text,
        tone: waiting
          ? "waiting"
          : goalState === "pursuing" || goalState === "scheduled"
            ? "accent"
            : "neutral",
        icon:
          goalState === "blocked" || goalState === "invariant_broken" ? (
            <TriangleAlertIcon className="size-3" />
          ) : goalState === "paused" || goalState === "held" ? (
            <PauseIcon className="size-3" />
          ) : (
            <ZapIcon className="size-3" />
          ),
      });
    }
    if (agentsSignal && agentsSignal.count > 0) {
      const detail = agentsSignal.detail;
      rows.push({
        id: "agents",
        label: `${agentsSignal.count} agent${agentsSignal.count === 1 ? "" : "s"}`,
        ...(detail ? { detail } : {}),
        tone: agentsSignal.tone ?? "neutral",
        icon: <BotIcon className="size-3" />,
      });
    }
    return rows;
  }, [
    agentsSignal,
    elapsed,
    goalState,
    incoming,
    optimisticQueuedMessages,
    queuedTurns,
    queue.mutationError,
    queueIssue,
    record,
    steering,
    stopping,
    stoppingKind,
  ]);

  const [activeUncontrolled, setActiveUncontrolled] = useState<SessionChromeSignalId | null>(
    defaultActive,
  );
  const active = activeControlled !== undefined ? activeControlled : activeUncontrolled;
  const setActive = useCallback(
    (next: SessionChromeSignalId | null) => {
      if (activeControlled === undefined) setActiveUncontrolled(next);
      onActiveChange?.(next);
    },
    [activeControlled, onActiveChange],
  );
  const [replaceDraftFor, setReplaceDraftFor] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    turnId: string;
    baseVersion: number | null;
    turnIds: string[];
  } | null>(null);
  // A pending Steer must acknowledge immediately. Keep the complete prior queue
  // for one deferred render so renumbering thousands of later rows cannot delay
  // the truthful "Changing direction" receipt.
  const deferredQueuedTurns = useDeferredValue(queuedTurns);
  const panelQueuedTurns = steering?.phase === "submitting" ? deferredQueuedTurns : queuedTurns;
  const displayedQueuedTurns = useMemo(() => {
    if (!pendingMove || (queue.snapshot?.version ?? null) !== pendingMove.baseVersion) {
      return panelQueuedTurns;
    }
    const byId = new Map(panelQueuedTurns.map((turn) => [turn.id, turn]));
    const projected = pendingMove.turnIds.map((turnId) => byId.get(turnId));
    if (projected.some((turn) => !turn) || projected.length !== panelQueuedTurns.length) {
      return panelQueuedTurns;
    }
    return projected as SessionTurn[];
  }, [panelQueuedTurns, pendingMove, queue.snapshot?.version]);

  const chipRefs = useRef<Partial<Record<SessionChromeSignalId, HTMLButtonElement | null>>>({});
  const railRef = useRef<HTMLDivElement | null>(null);
  const panelBodyRef = useRef<HTMLDivElement | null>(null);
  const [pill, setPill] = useState({ left: 0, top: 0, width: 0, height: 0, opacity: 0 });
  const [panelHeight, setPanelHeight] = useState(0);

  const signalIds = signals.map((signal) => signal.id).join(",");
  useEffect(() => {
    if (active && !signalIds.split(",").includes(active)) {
      if (activeControlled === undefined) setActiveUncontrolled(null);
      onActiveChange?.(null);
    }
  }, [active, activeControlled, onActiveChange, signalIds]);

  useEffect(() => {
    if (active !== "queue" || !replaceDraftFor) return;
    if (!queuedTurns.some((turn) => turn.id === replaceDraftFor)) {
      setReplaceDraftFor(null);
    }
  }, [active, queuedTurns, replaceDraftFor]);

  useEffect(() => {
    const rail = railRef.current;
    const measure = () => {
      if (!rail || !active) {
        setPill((prev) => (prev.opacity === 0 ? prev : { ...prev, opacity: 0 }));
        return;
      }
      const chip = chipRefs.current[active];
      if (!chip) return;
      // Measure against the chip's own box so a wrapped multi-row rail never
      // stretches the highlight into a tall stripe across every signal.
      const railBox = rail.getBoundingClientRect();
      const chipBox = chip.getBoundingClientRect();
      setPill({
        left: chipBox.left - railBox.left,
        top: chipBox.top - railBox.top,
        width: chipBox.width,
        height: chipBox.height,
        opacity: 1,
      });
    };
    measure();
    if (!rail) return;
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    for (const chip of Object.values(chipRefs.current)) {
      if (chip) observer.observe(chip);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, signals]);

  const open = active !== null;

  useLayoutEffect(() => {
    if (!open) {
      setPanelHeight(0);
      return;
    }
    const node = panelBodyRef.current;
    if (!node) return;
    setPanelHeight(node.offsetHeight);
  }, [
    open,
    active,
    incoming,
    queuedTurns,
    optimisticQueuedMessages,
    record,
    goalState,
    agentsPanel,
    agentsSignal,
    steering,
  ]);

  useEffect(() => {
    if (!open) return;
    const node = panelBodyRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setPanelHeight(node.offsetHeight);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, active]);

  const shellDuration = reduceMotion ? 0 : 0.22;
  const crossfadeDuration = reduceMotion ? 0 : 0.18;
  const ease = [0.22, 1, 0.36, 1] as const;

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message the agent"]',
      );
      input?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      input?.focus();
    });
  }, []);
  const editQueueItem = queue.editTurn;
  const moveQueueItem = queue.moveTurn;
  const steerQueueItem = queue.steerTurn;
  const removeQueueItem = queue.removeTurn;
  const editQueueTurn = useCallback(
    async (turnId: string, replaceDraft: boolean) => {
      if (!composer) return;
      const restored = await editQueueItem(turnId, {
        expectedDraftRevision: composer.draftRevision,
        replaceDraft,
      });
      if (!restored) return;
      composer.applyDraft(restored);
      setReplaceDraftFor(null);
      setActive(null);
      focusComposer();
    },
    [composer, editQueueItem, focusComposer, setActive],
  );
  const moveQueueTurn = useCallback(
    async (turnId: string, beforeTurnId: string | null) => {
      const sourceIndex = queuedTurns.findIndex((turn) => turn.id === turnId);
      if (sourceIndex < 0) return;
      const ordered = [...queuedTurns];
      const [moving] = ordered.splice(sourceIndex, 1);
      if (!moving) return;
      const targetIndex =
        beforeTurnId === null
          ? ordered.length
          : ordered.findIndex((turn) => turn.id === beforeTurnId);
      ordered.splice(targetIndex < 0 ? ordered.length : targetIndex, 0, moving);
      setPendingMove({
        turnId,
        baseVersion: queue.snapshot?.version ?? null,
        turnIds: ordered.map((turn) => turn.id),
      });
      try {
        await moveQueueItem(turnId, beforeTurnId);
      } finally {
        setPendingMove((current) => (current?.turnId === turnId ? null : current));
      }
    },
    [moveQueueItem, queue.snapshot?.version, queuedTurns],
  );
  const steerQueueTurn = useCallback(
    (turnId: string) => {
      void steerQueueItem(turnId);
    },
    [steerQueueItem],
  );
  const removeQueueTurn = useCallback(
    (turnId: string) => {
      void removeQueueItem(turnId);
    },
    [removeQueueItem],
  );
  const requestQueueTurnEdit = useCallback(
    (turn: SessionTurn) => {
      if (!composer) return;
      requestQueueDraftEdit(
        composer,
        () => setReplaceDraftFor(turn.id),
        () => {
          void editQueueTurn(turn.id, false);
        },
      );
    },
    [composer, editQueueTurn],
  );
  const cancelQueueDraftReplace = useCallback(() => setReplaceDraftFor(null), []);
  const confirmQueueDraftReplace = useCallback(() => {
    if (replaceDraftFor) void editQueueTurn(replaceDraftFor, true);
  }, [editQueueTurn, replaceDraftFor]);

  const panelBody =
    active === "incoming" ? (
      <IncomingPanel inputs={incoming} onDismiss={onDismissIncoming} />
    ) : active === "steering" && (steering || stopping) ? (
      <SteeringPanel
        phase={stopping ? "stopping" : (steering?.phase ?? "accepted")}
        stoppingKind={stoppingKind}
        text={steering?.text}
      />
    ) : active === "queue" ? (
      <QueuePanel
        turns={displayedQueuedTurns}
        optimisticMessages={optimisticQueuedMessages}
        sessionStatus={sessionStatus}
        effectiveControl={queue.effectiveControl}
        stoppingPreviousAttempt={queue.stoppingPreviousAttempt}
        readOnly={!canMutateQueue}
        mutationFor={queue.mutationFor}
        error={queueIssue?.message ?? null}
        mutationFailed={queue.mutationError !== null}
        onDismissError={queue.mutationError ? queue.clearMutationError : undefined}
        onRetry={() => void queue.refresh()}
        replaceDraftFor={replaceDraftFor}
        onCancelReplace={cancelQueueDraftReplace}
        onConfirmReplace={
          canMutateQueue && composer && replaceDraftFor ? confirmQueueDraftReplace : undefined
        }
        onEdit={canMutateQueue && composer ? requestQueueTurnEdit : undefined}
        onSteer={canMutateQueue ? steerQueueTurn : undefined}
        onRemove={canMutateQueue ? removeQueueTurn : undefined}
        onMove={canMutateQueue ? moveQueueTurn : undefined}
      />
    ) : active === "goal" && record && goalState && goal ? (
      <GoalPanel goal={goal} state={goalState} elapsed={elapsed} readOnly={readOnly} />
    ) : active === "agents" ? (
      <div data-og-session-chrome-panel="agents">
        {agentsPanel ?? <p className="text-og-xs text-og-fg-muted">No agent details.</p>}
      </div>
    ) : null;

  if (signals.length === 0) return null;

  const panelShell = (
    <motion.div
      id={panelId}
      data-og-session-chrome-panel-shell=""
      initial={false}
      animate={{ height: open ? panelHeight : 0, opacity: open ? 1 : 0 }}
      transition={{ duration: shellDuration, ease }}
      className="overflow-hidden"
    >
      <div
        ref={panelBodyRef}
        className="relative overflow-y-auto overscroll-contain border-t border-og-border/50"
        style={{
          maxHeight: "var(--og-session-chrome-panel-max-height)",
          paddingInline: "var(--og-session-chrome-panel-pad-x)",
          paddingBlock: "var(--og-session-chrome-panel-pad-y)",
        }}
      >
        <AnimatePresence initial={false}>
          {active && panelBody ? (
            <motion.div
              key={active}
              data-og-session-chrome-panel-frame={active}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1, position: "relative" }}
              exit={
                reduceMotion
                  ? { opacity: 1, position: "relative" }
                  : {
                      opacity: 0,
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                    }
              }
              transition={{ duration: crossfadeDuration, ease }}
            >
              {panelBody}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );

  return (
    <>
      <div
        className={cn("og-session-chrome og-root w-full", className)}
        data-testid="session-chrome"
        data-og-session-chrome=""
        data-og-session-chrome-open={open ? "true" : "false"}
      >
        <div
          className={cn(
            "relative overflow-hidden border",
            "transition-[background-color,border-color,box-shadow] motion-reduce:transition-none",
          )}
          style={{
            borderRadius: "var(--_og-session-chrome-radius)",
            background: open
              ? "var(--_og-session-chrome-surface-open)"
              : "var(--_og-session-chrome-surface)",
            borderColor: open
              ? "var(--_og-session-chrome-border-open)"
              : "var(--_og-session-chrome-border)",
            boxShadow: open
              ? "var(--og-session-chrome-shadow-open)"
              : "var(--og-session-chrome-shadow)",
            transitionDuration: "var(--og-session-chrome-duration)",
            transitionTimingFunction: "var(--_og-session-chrome-ease)",
          }}
        >
          <div
            className="relative"
            style={{
              paddingTop: "var(--og-session-chrome-rail-pad)",
              paddingBottom: "var(--og-session-chrome-rail-pad)",
              paddingLeft: "var(--og-session-chrome-rail-pad)",
              paddingRight: "var(--og-session-chrome-rail-pad)",
            }}
          >
            <div
              ref={railRef}
              className="relative flex flex-wrap items-center"
              style={{
                gap: "var(--og-session-chrome-chip-gap)",
              }}
            >
              <motion.div
                aria-hidden
                className="pointer-events-none absolute left-0 top-0 rounded-og-md"
                style={{
                  background: "var(--_og-session-chrome-highlight)",
                  boxShadow: "inset 0 0 0 1px var(--_og-session-chrome-highlight-ring)",
                }}
                initial={false}
                animate={{
                  x: pill.left,
                  y: pill.top,
                  width: pill.width,
                  height: pill.height,
                  opacity: pill.opacity,
                }}
                transition={{ duration: shellDuration, ease }}
              />
              {signals.map((signal) => {
                const selected = active === signal.id;
                return (
                  <button
                    key={signal.id}
                    type="button"
                    ref={(node) => {
                      chipRefs.current[signal.id] = node;
                    }}
                    aria-expanded={selected}
                    aria-controls={panelId}
                    aria-label={selected ? `Close ${signal.label}` : undefined}
                    data-testid={`session-chrome-${signal.id}`}
                    data-og-session-chrome-signal={signal.id}
                    onClick={() => setActive(selected ? null : signal.id)}
                    className={cn(
                      "group relative z-[1] inline-flex min-h-[var(--og-session-chrome-chip-min-height)] max-w-full items-center gap-1 rounded-og-md py-1 text-left text-og-xs outline-hidden",
                      // Coarse pointers keep a 44px target (session-pins acceptance).
                      "pointer-coarse:min-h-11",
                      "transition-colors duration-150 motion-reduce:transition-none",
                      "hover:text-og-fg focus-visible:bg-og-surface-3/50",
                      selected ? "text-og-fg" : "text-og-fg-muted",
                    )}
                    style={{ paddingInline: "var(--og-session-chrome-chip-pad-x)" }}
                  >
                    <span className={cn("shrink-0", toneClass(signal.tone, selected))}>
                      {signal.icon}
                    </span>
                    <span className="shrink-0 font-medium text-og-fg">{signal.label}</span>
                    {signal.detail ? (
                      <>
                        <span aria-hidden className="shrink-0 text-og-fg-subtle/60">
                          ·
                        </span>
                        <span className="min-w-0 max-w-[8.5rem] truncate text-og-fg sm:max-w-[12rem]">
                          {signal.detail}
                        </span>
                      </>
                    ) : null}
                    {selected ? (
                      <span
                        data-testid="session-chrome-close"
                        className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-og-sm text-og-fg-subtle transition-colors group-hover:text-og-fg pointer-coarse:size-5"
                        aria-hidden
                      >
                        <XIcon className="size-3" />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
          {panelShell}
        </div>
      </div>
    </>
  );
}

function IncomingPanel({
  inputs,
  onDismiss,
}: {
  inputs: SessionPendingInputPreview[];
  onDismiss?: ((inputId: string) => void) | undefined;
}) {
  return (
    <ul
      className="flex flex-col gap-0.5"
      aria-label="Incoming updates"
      data-og-session-chrome-panel="incoming"
    >
      {inputs.map((input) => (
        <li
          key={input.id}
          className="group flex items-start gap-1.5 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--_og-session-chrome-row-hover)]"
        >
          <span
            className={cn(
              "mt-px shrink-0 rounded px-1 py-px text-[10px] font-medium leading-4",
              input.classification === "action_required" || input.classification === "failure"
                ? "bg-og-status-waiting/12 text-og-status-waiting"
                : "bg-og-surface-3/80 text-og-fg-muted",
            )}
          >
            {pendingKindLabel(input.kind)}
          </span>
          <p className="min-w-0 flex-1 text-og-xs leading-4 text-og-fg">{input.summary}</p>
          {onDismiss ? (
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
              <IconAction
                label={`Dismiss incoming ${pendingKindLabel(input.kind)}`}
                icon="delete"
                onClick={() => onDismiss(input.id)}
                danger
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SteeringPanel({
  phase,
  stoppingKind,
  text,
}: {
  phase: "submitting" | "accepted" | "stopping";
  stoppingKind?: "current" | "previous" | null | undefined;
  text?: string | undefined;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-og-sm px-1.5 py-1"
      role="status"
      aria-live="polite"
      data-og-session-chrome-panel="steering"
    >
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-og-accent-soft text-og-accent">
        {phase === "submitting" || phase === "stopping" ? (
          <Loader2Icon className="size-3 animate-og-spin" aria-hidden="true" />
        ) : (
          <ZapIcon className="size-3" aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0">
        {text ? (
          <p className="truncate text-og-xs font-medium leading-4 text-og-fg">{text}</p>
        ) : null}
        <p className={cn(text && "mt-0.5", "text-[10px] leading-4 text-og-fg-muted")}>
          {phase === "submitting"
            ? "Sending your latest direction…"
            : phase === "stopping"
              ? stoppingKind === "previous"
                ? "Direction saved. Waiting for the previous command to stop safely."
                : "Waiting for the current command to stop safely."
              : "Direction accepted. The agent will continue from it."}
        </p>
      </div>
    </div>
  );
}

/** Truthful explanation of the durable condition ahead of a queued prompt. */
export function sessionChromeQueueWaitCopy(
  sessionStatus: SessionStatus | null | undefined,
  effectiveControl: EffectiveSessionControl | null,
  stoppingPreviousAttempt: boolean,
): string | null {
  if (stoppingPreviousAttempt) {
    return "Waiting for the previous command to stop safely before the next prompt starts.";
  }
  if (effectiveControl?.state === "paused") {
    const blocker = effectiveControl.primaryBlocker;
    const pausedBy = blocker ? `Paused by ${blocker.displayName}.` : "This workstream is paused.";
    const reason = blocker?.reason?.trim();
    const reasonCopy = reason ? ` ${reason.replace(/[.!?]+$/, "")}.` : "";
    return `${pausedBy}${reasonCopy} Resume it before queued prompts can run.`;
  }
  switch (sessionStatus) {
    case "running":
      return "Runs after the current turn. Use Steer on a prompt to change direction now.";
    case "requires_action":
      return "Waiting for your response before the next prompt can start.";
    case "recovering":
      return "Restoring the session before the next prompt can start.";
    case "waiting_capacity":
      return "Waiting for available capacity before the next prompt can start.";
    case "queued":
      return "Waiting for the next turn to start.";
    case "idle":
      return "Ready to start the next prompt.";
    default:
      return null;
  }
}

function QueueWaitStatus({
  createdAt,
  sessionStatus,
  effectiveControl,
  stoppingPreviousAttempt,
}: {
  createdAt: string | undefined;
  sessionStatus: SessionStatus | null | undefined;
  effectiveControl: EffectiveSessionControl | null;
  stoppingPreviousAttempt: boolean;
}) {
  const copy = sessionChromeQueueWaitCopy(sessionStatus, effectiveControl, stoppingPreviousAttempt);
  const elapsed = useLiveElapsed(createdAt, Boolean(copy && createdAt));
  if (!copy) return null;
  return (
    <p
      className="rounded-og-sm bg-og-surface-2/60 px-2 py-1.5 text-[10px] leading-4 text-og-fg-muted"
      data-testid="session-chrome-queue-wait-reason"
    >
      {elapsed ? `Queued ${elapsed} · ` : ""}
      {copy}
    </p>
  );
}

function QueuePanel({
  turns,
  optimisticMessages,
  sessionStatus,
  effectiveControl,
  stoppingPreviousAttempt,
  readOnly,
  mutationFor,
  error,
  mutationFailed,
  onDismissError,
  onRetry,
  replaceDraftFor,
  onCancelReplace,
  onConfirmReplace,
  onEdit,
  onSteer,
  onRemove,
  onMove,
}: {
  turns: SessionTurn[];
  optimisticMessages: ComposerOptimisticMessage[];
  sessionStatus: SessionStatus | null | undefined;
  effectiveControl: EffectiveSessionControl | null;
  stoppingPreviousAttempt: boolean;
  readOnly: boolean;
  mutationFor: UseTurnQueueResult["mutationFor"];
  error: string | null;
  mutationFailed: boolean;
  onDismissError?: (() => void) | undefined;
  onRetry: () => void;
  replaceDraftFor?: string | null | undefined;
  onCancelReplace?: (() => void) | undefined;
  onConfirmReplace?: (() => void) | undefined;
  onEdit?: ((turn: SessionTurn) => void) | undefined;
  onSteer?: ((turnId: string) => void) | undefined;
  onRemove?: ((turnId: string) => void) | undefined;
  onMove?: ((turnId: string, beforeTurnId: string | null) => void) | undefined;
}) {
  const [expandedActionsFor, setExpandedActionsFor] = useState<string | null>(null);
  const handleActionClick = useCallback(
    (event: ReactMouseEvent<HTMLOListElement>) => {
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>("button[data-queue-command]")
          : null;
      if (!button || button.disabled || !event.currentTarget.contains(button)) return;
      const turnId = button.dataset.queueCommandTurnId;
      if (!turnId) return;
      switch (button.dataset.queueCommand) {
        case "more":
          setExpandedActionsFor((current) => (current === turnId ? null : turnId));
          return;
        case "move":
          onMove?.(turnId, button.dataset.queueBeforeTurnId ?? null);
          return;
        case "steer":
          onSteer?.(turnId);
          return;
        case "edit": {
          const turn = turns.find((candidate) => candidate.id === turnId);
          if (turn) onEdit?.(turn);
          return;
        }
        case "delete":
          onRemove?.(turnId);
      }
    },
    [onEdit, onMove, onRemove, onSteer, turns],
  );
  return (
    <div className="space-y-1.5" data-og-session-chrome-panel="queue">
      {error ? (
        <div
          role="alert"
          className="rounded-og-sm border border-og-status-failed/30 bg-og-status-failed/10 px-2 py-1.5 text-og-xs text-og-fg"
          data-testid="session-chrome-queue-error"
        >
          <p className="break-words font-medium">
            {mutationFailed ? "The queue action was not applied." : "The queue could not load."}
          </p>
          <p className="mt-0.5 break-words text-og-fg-muted">{error}</p>
          <div className="mt-1.5 flex justify-end gap-1.5">
            {onDismissError ? (
              <button
                type="button"
                className="rounded-og-sm px-2 py-1 font-medium hover:bg-og-surface-3/70 focus-visible:ring-2 focus-visible:ring-og-accent/40"
                onClick={onDismissError}
              >
                Dismiss
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-og-sm px-2 py-1 font-medium hover:bg-og-surface-3/70 focus-visible:ring-2 focus-visible:ring-og-accent/40"
              onClick={onRetry}
            >
              Refresh queue
            </button>
          </div>
        </div>
      ) : null}
      <QueueWaitStatus
        createdAt={turns[0]?.createdAt}
        sessionStatus={sessionStatus}
        effectiveControl={effectiveControl}
        stoppingPreviousAttempt={stoppingPreviousAttempt}
      />
      <ol className="flex flex-col gap-0.5" aria-label="Queued prompts" onClick={handleActionClick}>
        {turns.map((turn, index) => (
          <QueueTurnRow
            key={turn.id}
            turn={turn}
            index={index}
            turnCount={turns.length}
            beforeUp={index > 0 ? (turns[index - 1]?.id ?? null) : null}
            beforeDown={index < turns.length - 1 ? (turns[index + 2]?.id ?? null) : null}
            pending={mutationFor(turn.id)}
            confirmingReplace={replaceDraftFor === turn.id}
            actionsExpanded={expandedActionsFor === turn.id}
            readOnly={readOnly}
            onCancelReplace={onCancelReplace}
            onConfirmReplace={onConfirmReplace}
            canEdit={Boolean(onEdit)}
            canSteer={Boolean(onSteer)}
            canRemove={Boolean(onRemove)}
            canMove={Boolean(onMove)}
          />
        ))}
        {optimisticMessages.map((message, index) => (
          <li
            key={message.clientEventId}
            data-queue-client-event-id={message.clientEventId}
            className="flex items-start gap-1.5 rounded-og-sm px-1.5 py-1"
          >
            <span className="mt-px shrink-0 font-og-mono text-[10px] leading-4 text-og-fg-subtle">
              {turns.length + index + 1}
            </span>
            <p className="min-w-0 flex-1 truncate text-og-xs leading-4 text-og-fg">
              {message.text}
            </p>
            <span
              role="status"
              aria-live="polite"
              className="inline-flex shrink-0 items-center gap-1 text-[10px] leading-4 text-og-fg-muted"
            >
              <Loader2Icon
                aria-hidden="true"
                className="size-3 animate-og-spin motion-reduce:animate-none"
              />
              {message.state === "sending" ? "Sending…" : "Reconciling…"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const QueueTurnRow = memo(function QueueTurnRow({
  turn,
  index,
  turnCount,
  beforeUp,
  beforeDown,
  pending,
  confirmingReplace,
  actionsExpanded,
  readOnly,
  onCancelReplace,
  onConfirmReplace,
  canEdit,
  canSteer,
  canRemove,
  canMove,
}: {
  turn: SessionTurn;
  index: number;
  turnCount: number;
  beforeUp: string | null;
  beforeDown: string | null;
  pending: ReturnType<UseTurnQueueResult["mutationFor"]>;
  confirmingReplace: boolean;
  actionsExpanded: boolean;
  readOnly: boolean;
  onCancelReplace?: (() => void) | undefined;
  onConfirmReplace?: (() => void) | undefined;
  canEdit: boolean;
  canSteer: boolean;
  canRemove: boolean;
  canMove: boolean;
}) {
  const presentation = queuedTurnPresentation(turn);
  const voice = presentation.kind !== "prompt";
  const showActions = !readOnly && (canEdit || canSteer || canRemove || canMove);
  return (
    <li
      data-queue-turn-id={turn.id}
      className="group flex flex-col gap-1 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--_og-session-chrome-row-hover)] [--_og-session-chrome-queue-row-intrinsic-size:1.75rem] pointer-coarse:[--_og-session-chrome-queue-row-intrinsic-size:2.75rem]"
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto var(--_og-session-chrome-queue-row-intrinsic-size)",
      }}
    >
      <div className="flex items-start gap-1.5">
        {voice ? (
          <AudioLinesIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-og-accent" />
        ) : (
          <span className="mt-px shrink-0 font-og-mono text-[10px] leading-4 text-og-fg-subtle">
            {index + 1}
          </span>
        )}
        <p className="min-w-0 flex-1 truncate text-og-xs leading-4 text-og-fg">
          {presentation.text}
        </p>
        {showActions ? (
          <div className="flex shrink-0 items-center gap-1">
            {canSteer ? (
              <QueueTextAction
                label={pending === "steer" ? "Changing…" : "Steer"}
                accessibleLabel={`Steer queued prompt ${index + 1}`}
                command="steer"
                turnId={turn.id}
                disabled={pending !== null}
              />
            ) : null}
            {canEdit || canRemove || (canMove && turnCount > 1) ? (
              <QueueTextAction
                label="More"
                accessibleLabel={`More actions for queued prompt ${index + 1}`}
                command="more"
                turnId={turn.id}
                disabled={pending !== null}
                ariaExpanded={actionsExpanded}
                ariaControls={`queue-actions-${turn.id}`}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {actionsExpanded ? (
        <div
          id={`queue-actions-${turn.id}`}
          className="flex flex-wrap justify-end gap-1 border-t border-og-border/50 pt-1"
        >
          {canMove && turnCount > 1 ? (
            <>
              <QueueTextAction
                label="Move up"
                accessibleLabel={`Move queued prompt ${index + 1} up`}
                command="move"
                turnId={turn.id}
                beforeTurnId={beforeUp}
                disabled={pending !== null || index === 0}
              />
              <QueueTextAction
                label="Move down"
                accessibleLabel={`Move queued prompt ${index + 1} down`}
                command="move"
                turnId={turn.id}
                beforeTurnId={beforeDown}
                disabled={pending !== null || index >= turnCount - 1}
              />
            </>
          ) : null}
          {canEdit ? (
            <QueueTextAction
              label={pending === "edit" ? "Moving…" : "Edit"}
              accessibleLabel={`Edit queued prompt ${index + 1}`}
              command="edit"
              turnId={turn.id}
              disabled={pending !== null}
            />
          ) : null}
          {canRemove ? (
            <QueueTextAction
              label={pending === "delete" ? "Deleting…" : "Delete"}
              accessibleLabel={`Remove queued prompt ${index + 1}`}
              command="delete"
              turnId={turn.id}
              disabled={pending !== null}
              danger
            />
          ) : null}
        </div>
      ) : null}
      {confirmingReplace ? (
        <div className="rounded-og-sm border border-og-status-waiting/30 bg-og-status-waiting/10 p-2 text-og-xs text-og-fg">
          <p>Your composer already has a draft. Replace it with this queued prompt?</p>
          <p className="mt-0.5 text-og-fg-muted">
            The current draft will be permanently discarded; this queued prompt is preserved until
            you confirm.
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              className="rounded-og-sm px-2 py-1 font-medium hover:bg-og-surface-3/70 focus-visible:ring-2 focus-visible:ring-og-accent/40"
              onClick={onCancelReplace}
            >
              Keep current draft
            </button>
            <button
              type="button"
              className="rounded-og-sm bg-og-accent px-2 py-1 font-medium text-og-accent-fg hover:opacity-90 focus-visible:ring-2 focus-visible:ring-og-accent/40"
              onClick={onConfirmReplace}
            >
              Replace and edit
            </button>
          </div>
        </div>
      ) : null}
      {pending ? (
        <div
          role="status"
          aria-live="polite"
          className="sr-only"
          data-testid={`session-chrome-queue-mutation-${pending}`}
        >
          {queueMutationPendingLabel(pending)}
        </div>
      ) : null}
    </li>
  );
});

function queueMutationPendingLabel(
  kind: NonNullable<ReturnType<UseTurnQueueResult["mutationFor"]>>,
) {
  switch (kind) {
    case "move":
      return "Saving new position…";
    case "edit":
      return "Moving to composer…";
    case "steer":
      return "Changing direction…";
    case "delete":
      return "Deleting…";
  }
}

function GoalPanel({
  goal,
  state,
  elapsed,
  readOnly,
}: {
  goal: UseGoalResult;
  state: GoalPillState;
  elapsed: string | null;
  readOnly: boolean;
}) {
  const record = goal.goal;
  if (!record) return null;
  const canToggle = !readOnly && (record.status === "active" || record.status === "paused");

  return (
    <div className="space-y-1.5" data-og-session-chrome-panel="goal">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-og-fg-subtle">
        <span>{GOAL_LABEL[state]}</span>
        {elapsed ? (
          <span className="tabular-nums normal-case tracking-normal text-og-fg-muted">
            · {elapsed}
          </span>
        ) : null}
        <span className="normal-case tracking-normal text-og-fg-muted">· v{record.version}</span>
      </div>
      <p className="text-og-sm leading-5 text-og-fg">{record.text}</p>
      {record.successCriteria ? (
        <p className="text-og-xs leading-4 text-og-fg-muted">
          <span className="font-medium text-og-fg">Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {record.continuation?.lastError ? (
        <p className="rounded-og-sm bg-og-status-waiting/10 px-1.5 py-1 text-og-xs leading-4 text-og-status-waiting">
          {record.continuation.lastError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5">
        <div className="flex flex-wrap gap-1 text-[10px] text-og-fg-muted">
          <span className="rounded bg-og-surface-3/70 px-1 py-px">
            {record.autoContinuations} auto-continues
          </span>
          <span className="rounded bg-og-surface-3/70 px-1 py-px">
            {record.noProgressStreak} stalled
          </span>
        </div>
        {!readOnly ? (
          <div className="flex items-center gap-0.5">
            {canToggle ? (
              <button
                type="button"
                disabled={goal.updating}
                onClick={() =>
                  void (record.status === "paused"
                    ? goal.resume()
                    : goal.pause("Paused from session chrome"))
                }
                className="inline-flex h-6 items-center gap-1 rounded-og-sm px-1.5 text-og-xs font-medium text-og-fg-muted outline-hidden transition-colors hover:bg-og-surface-3/70 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
              >
                {goal.updating ? (
                  <Loader2Icon className="size-3 animate-og-spin" />
                ) : record.status === "paused" ? (
                  <PlayIcon className="size-3" />
                ) : (
                  <PauseIcon className="size-3" />
                )}
                {record.status === "paused" ? "Resume" : "Pause"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={goal.updating}
              onClick={() => void goal.deleteGoal()}
              className="inline-flex h-6 items-center gap-1 rounded-og-sm px-1.5 text-og-xs font-medium text-og-fg-subtle outline-hidden transition-colors hover:bg-og-surface-3/70 hover:text-og-danger focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
            >
              <Trash2Icon className="size-3" />
              Clear
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QueueTextAction({
  label,
  accessibleLabel,
  command,
  turnId,
  beforeTurnId,
  disabled,
  ariaExpanded,
  ariaControls,
  danger,
}: {
  label: string;
  accessibleLabel: string;
  command: "more" | "move" | "steer" | "edit" | "delete";
  turnId: string;
  beforeTurnId?: string | null | undefined;
  disabled?: boolean;
  ariaExpanded?: boolean | undefined;
  ariaControls?: string | undefined;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={accessibleLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      data-queue-command={command}
      data-queue-command-turn-id={turnId}
      data-queue-before-turn-id={beforeTurnId ?? undefined}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-7 items-center justify-center rounded-og-sm px-2 text-[10px] font-medium leading-4 text-og-fg-muted outline-hidden transition-colors",
        "hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40",
        "disabled:pointer-events-none disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-3 pointer-coarse:text-og-xs",
        danger && "hover:text-og-danger",
      )}
    >
      {label}
    </button>
  );
}

function IconAction({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: "up" | "down" | "steer" | "edit" | "delete";
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-queue-action-icon={icon}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "og-queue-icon-action inline-flex size-6 items-center justify-center rounded-og-sm text-og-fg-subtle outline-hidden transition-colors",
        "hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40",
        "disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-9",
        danger && "hover:text-og-danger",
      )}
    />
  );
}
