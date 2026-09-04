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
 * Inbox and queue stay separate segments. Queue hover actions wire to
 * `UseTurnQueueResult` (`editTurn` / `steerTurn` / `moveTurn` / `removeTurn`).
 * Inbox has no product dismiss API; pass `onDismissIncoming` when the host
 * wants a visible action (dev harness may use a local dummy).
 *
 * Segment switches keep the panel shell mounted and crossfade content. The
 * shell uses one CSS grid-track transition for deliberate open/close actions;
 * live queue reconciliation never feeds measurements back into layout.
 */
import type { SessionGoal, SessionPendingInputPreview, SessionTurn } from "@opengeni/sdk";
import {
  AudioLinesIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  InboxIcon,
  ListOrderedIcon,
  Loader2Icon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { ComposerOptimisticMessage, ComposerState } from "../hooks/use-composer";
import type { UseGoalResult } from "../hooks/use-goal";
import type { UseTurnQueueResult } from "../hooks/use-turn-queue";
import { cn } from "../lib/cn";
import { formatClockTime } from "../lib/format";
import { requestQueueDraftEdit } from "./queue-draft-policy";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

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
  readOnly?: boolean | undefined;
  className?: string | undefined;
  /** Controlled active segment; omit for uncontrolled. */
  active?: SessionChromeSignalId | null | undefined;
  defaultActive?: SessionChromeSignalId | null | undefined;
  onActiveChange?: ((next: SessionChromeSignalId | null) => void) | undefined;
};

type GoalPillState =
  | "pursuing"
  | "waiting"
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
  waiting: "Waiting",
  scheduled: "Scheduled",
  blocked: "Blocked",
  held: "Held",
  paused: "Paused",
  invariant_broken: "Needs attention",
  completed: "Done",
};

/**
 * Short pill suffix per `pausedReason`. `max_auto_continuations` is pacing
 * (new input resumes it); `limits` is budget/admission; `user_pause`/`api` is
 * the human's own override; `agent` is the model declaring it is blocked on a
 * human decision. Unknown or legacy reasons keep the bare "Paused".
 */
const GOAL_PAUSED_REASON_SUFFIX: Record<string, string> = {
  max_auto_continuations: "cap",
  limits: "budget",
  user_pause: "manually",
  api: "manually",
  agent: "agent",
};

const GOAL_PAUSED_REASON_EXPLANATION: Record<string, string> = {
  max_auto_continuations:
    "Paused at the automatic continuation cap. New input (a child result, an agent message, or your prompt) resumes it; you can also resume it here.",
  limits: "Paused because budget or usage limits block another run. Resume once limits allow.",
  user_pause:
    "Paused manually by a person or an API call. Resume to let the goal continue on its own.",
  api: "Paused manually by a person or an API call. Resume to let the goal continue on its own.",
  agent: "Paused by the agent: it is waiting on a human decision before continuing.",
};

type GoalPillRecord = Pick<SessionGoal, "status" | "pausedReason"> & {
  continuation?: SessionGoal["continuation"] | null | undefined;
};

/** Pill label, with the pause reason spelled out: "Paused · cap" / "Paused · manually". */
export function sessionChromeGoalPillLabel(
  state: GoalPillState,
  record: GoalPillRecord | null | undefined,
): string {
  if (state !== "paused") return GOAL_LABEL[state];
  const suffix = record?.pausedReason ? GOAL_PAUSED_REASON_SUFFIX[record.pausedReason] : undefined;
  return suffix ? `Paused · ${suffix}` : "Paused";
}

/**
 * One human sentence explaining WHY the goal is not pursuing right now: the
 * pause reason, the agent's own `wait_for_input` hold (reason + deadline), or the
 * next idle-backoff check time. Null when the state needs no explanation.
 */
export function sessionChromeGoalPillExplanation(
  state: GoalPillState,
  record: GoalPillRecord | null | undefined,
): string | null {
  const continuation = record?.continuation ?? null;
  if (state === "paused") {
    return record?.pausedReason
      ? (GOAL_PAUSED_REASON_EXPLANATION[record.pausedReason] ?? null)
      : null;
  }
  if (state === "scheduled" && continuation?.reason === "backoff_pending") {
    return continuation.nextAttemptAt
      ? `Next goal check at ${formatClockTime(continuation.nextAttemptAt)}.`
      : "Next goal check is scheduled.";
  }
  if (state === "held" && continuation?.reason === "held_for_input") {
    const reason = continuation.holdReason?.trim();
    const until = continuation.nextAttemptAt
      ? ` until ${formatClockTime(continuation.nextAttemptAt)}`
      : "";
    return `Waiting for input${reason ? `: ${reason}` : ""}${until}. Relevant session input—including a child result, background-command result, agent message, schedule, or your prompt—wakes it sooner.`;
  }
  return null;
}

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
        ? "waiting"
        : "invariant_broken";
  }
  // `backoff_pending` (idle pacing between consecutive no-input continuations,
  // next evaluation at `nextAttemptAt`) is an ordinary scheduled state.
  if (continuation.state === "scheduled") return "scheduled";
  if (continuation.state === "blocked") {
    // `held_for_input` is the agent's own wait_for_input hold (waiting for child
    // results / external input until a deadline); it shares the Held pill.
    return continuation.reason === "workstream_paused" || continuation.reason === "held_for_input"
      ? "held"
      : "blocked";
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
    case "child_requires_action":
      return "Child needs input";
    case "child_requires_action_resolved":
      return "Child unblocked";
    case "child_paused":
      return "Child paused";
    case "child_waiting_capacity":
      return "Child waiting";
    case "child_progress":
      return "Child progress";
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
  const queueMutationFor = queue.mutationFor;
  const queuedTurns = useMemo(
    () => turns.filter((turn) => !isSteeringTurn(turn) && queueMutationFor(turn.id) !== "steer"),
    [queueMutationFor, turns],
  );
  const queuedTurnIds = useMemo(() => new Set(queuedTurns.map((turn) => turn.id)), [queuedTurns]);
  const optimisticQueued = useMemo(
    () =>
      (composer?.optimisticMessages ?? []).filter(
        (message) =>
          message.delivery === "send" &&
          message.destination === "queue" &&
          (!message.turnId || !queuedTurnIds.has(message.turnId)) &&
          !(
            message.turnId &&
            message.appliedQueueVersion !== null &&
            message.appliedQueueVersion !== undefined &&
            queue.snapshot &&
            queue.snapshot.version >= message.appliedQueueVersion
          ),
      ),
    [composer?.optimisticMessages, queue.snapshot, queuedTurnIds],
  );
  const stoppingKind =
    composer?.stoppingAttempt ??
    (queue.stoppingPreviousAttempt
      ? queue.effectiveControl?.state === "paused"
        ? "current"
        : "previous"
      : null);
  const stopping = stoppingKind !== null;
  const canMutateQueue = !readOnly && composer !== undefined;

  const liveGoal = record?.status === "active";
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
      /** Hover explanation (why paused / held / when the next check is). */
      title?: string | undefined;
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
    const queuedCount = queuedTurns.length + optimisticQueued.length;
    const queueProblem = queue.mutationError ?? queue.error;
    if (queuedCount > 0 || queueProblem) {
      const presentations = queuedTurns.map(queuedTurnPresentation);
      const first = presentations[0];
      const allVoiceRequests =
        optimisticQueued.length === 0 &&
        presentations.length > 0 &&
        presentations.every(({ kind }) => kind === "realtime_voice");
      const onlyVoiceHandoff =
        optimisticQueued.length === 0 &&
        presentations.length === 1 &&
        first?.kind === "realtime_voice_handoff";
      const voiceOnly = allVoiceRequests || onlyVoiceHandoff;
      const detail = queueProblem
        ? queue.mutationError
          ? "Action not confirmed"
          : "Queue unavailable"
        : (first?.text ?? optimisticQueued[0]?.text);
      rows.push({
        id: "queue",
        label: queueProblem
          ? queuedCount > 0
            ? `${queuedCount} queued · needs attention`
            : "Queue needs attention"
          : allVoiceRequests
            ? queuedCount === 1
              ? "Voice request queued"
              : `${queuedCount} voice requests queued`
            : onlyVoiceHandoff
              ? "Voice handoff queued"
              : `${queuedCount} queued prompt${queuedCount === 1 ? "" : "s"}`,
        ...(detail ? { detail } : {}),
        tone: queueProblem ? "waiting" : "neutral",
        icon: queueProblem ? (
          <TriangleAlertIcon className="size-3" />
        ) : voiceOnly ? (
          <AudioLinesIcon className="size-3" />
        ) : (
          <ListOrderedIcon className="size-3" />
        ),
      });
    }
    if (record && goalState) {
      const waiting =
        goalState === "waiting" ||
        goalState === "blocked" ||
        goalState === "held" ||
        goalState === "paused";
      const explanation = sessionChromeGoalPillExplanation(goalState, record);
      rows.push({
        id: "goal",
        label: sessionChromeGoalPillLabel(goalState, record),
        detail: elapsed ? `${elapsed} · ${record.text}` : record.text,
        ...(explanation ? { title: explanation } : {}),
        tone: waiting
          ? "waiting"
          : goalState === "pursuing" || goalState === "scheduled"
            ? "accent"
            : "neutral",
        icon:
          goalState === "blocked" || goalState === "invariant_broken" ? (
            <TriangleAlertIcon className="size-3" />
          ) : goalState === "waiting" ? (
            <Loader2Icon className="size-3 animate-og-spin" />
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
    optimisticQueued,
    queue.error,
    queue.mutationError,
    queuedTurns,
    record,
  ]);

  const [activeUncontrolled, setActiveUncontrolled] = useState<SessionChromeSignalId | null>(
    defaultActive,
  );
  const active = activeControlled !== undefined ? activeControlled : activeUncontrolled;
  const setActive = (next: SessionChromeSignalId | null) => {
    if (activeControlled === undefined) setActiveUncontrolled(next);
    onActiveChange?.(next);
  };
  const optimisticQueueKeys = optimisticQueued.map((message) => message.clientEventId).join(",");
  const previousOptimisticQueueKeys = useRef(optimisticQueueKeys);
  const [queueArrivalNonce, setQueueArrivalNonce] = useState(0);
  useEffect(() => {
    const previous = new Set(previousOptimisticQueueKeys.current.split(",").filter(Boolean));
    const arrived = optimisticQueued.some((message) => !previous.has(message.clientEventId));
    previousOptimisticQueueKeys.current = optimisticQueueKeys;
    if (!arrived) return;
    // Queue admission must not move the conversation or open a drawer beneath
    // the pointer. A stable, paint-only receipt on the queue chip communicates
    // destination without participating in layout.
    setQueueArrivalNonce((current) => current + 1);
  }, [optimisticQueueKeys, optimisticQueued]);
  const [replaceDraftFor, setReplaceDraftFor] = useState<string | null>(null);

  const chipRefs = useRef<Partial<Record<SessionChromeSignalId, HTMLButtonElement | null>>>({});
  const railRef = useRef<HTMLDivElement | null>(null);
  const [pill, setPill] = useState({ left: 0, top: 0, width: 0, height: 0, opacity: 0 });

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

  if (signals.length === 0 && !stopping) return null;

  const shellDuration = reduceMotion ? 0 : 0.22;
  const crossfadeDuration = reduceMotion ? 0 : 0.18;
  const ease = [0.22, 1, 0.36, 1] as const;

  const panelBody =
    active === "incoming" ? (
      <IncomingPanel inputs={incoming} onDismiss={onDismissIncoming} />
    ) : active === "queue" ? (
      <QueuePanel
        turns={queuedTurns}
        optimistic={optimisticQueued}
        loadError={queue.error}
        mutationError={queue.mutationError}
        onRefresh={queue.refresh}
        onClearMutationError={queue.clearMutationError}
        onRetryOptimistic={composer?.retryOptimisticMessage}
        onRemoveOptimistic={composer?.removeOptimisticMessage}
        readOnly={!canMutateQueue}
        mutationFor={queue.mutationFor}
        replaceDraftFor={replaceDraftFor}
        onCancelReplace={() => setReplaceDraftFor(null)}
        onConfirmReplace={
          canMutateQueue && composer && replaceDraftFor
            ? () => {
                const turnId = replaceDraftFor;
                setReplaceDraftFor(null);
                void (async () => {
                  const checkedOut = await queue.editTurn(turnId, {
                    expectedDraftRevision: composer.draftRevision,
                    replaceDraft: true,
                  });
                  if (checkedOut) composer.applyDraft(checkedOut);
                })();
              }
            : undefined
        }
        onEdit={
          canMutateQueue && composer
            ? (turn) => {
                requestQueueDraftEdit(
                  composer,
                  () => setReplaceDraftFor(turn.id),
                  () => {
                    void (async () => {
                      const checkedOut = await queue.editTurn(turn.id, {
                        expectedDraftRevision: composer.draftRevision,
                        replaceDraft: false,
                      });
                      if (checkedOut) composer.applyDraft(checkedOut);
                    })();
                  },
                );
              }
            : undefined
        }
        onSteer={
          canMutateQueue
            ? (turnId) => {
                void queue.steerTurn(turnId);
              }
            : undefined
        }
        onRemove={
          canMutateQueue
            ? (turnId) => {
                void queue.removeTurn(turnId);
              }
            : undefined
        }
        onMove={
          canMutateQueue
            ? (turnId, beforeTurnId) => {
                void queue.moveTurn(turnId, beforeTurnId);
              }
            : undefined
        }
      />
    ) : active === "goal" && record && goalState && goal ? (
      <GoalPanel goal={goal} state={goalState} elapsed={elapsed} readOnly={readOnly} />
    ) : active === "agents" ? (
      <div data-og-session-chrome-panel="agents">
        {agentsPanel ?? <p className="text-og-xs text-og-fg-muted">No agent details.</p>}
      </div>
    ) : null;

  return (
    <TooltipProvider delayDuration={300}>
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
                    title={signal.title}
                    onClick={() => setActive(selected ? null : signal.id)}
                    className={cn(
                      "group relative z-[1] inline-flex min-h-[var(--og-session-chrome-chip-min-height)] max-w-full items-center gap-1 rounded-og-md py-1 text-left text-og-xs outline-hidden",
                      // Coarse pointers keep a 44px target (session-pins acceptance).
                      "pointer-coarse:min-h-11",
                      "transition-colors duration-150 motion-reduce:transition-none",
                      "hover:text-og-fg focus-visible:bg-og-surface-3/50",
                      selected ? "text-og-fg" : "text-og-fg-muted",
                    )}
                    style={{
                      paddingInline: "var(--og-session-chrome-chip-pad-x)",
                    }}
                  >
                    {signal.id === "queue" && queueArrivalNonce > 0 && !reduceMotion ? (
                      <motion.span
                        key={queueArrivalNonce}
                        aria-hidden="true"
                        data-testid="session-chrome-queue-arrival"
                        className="pointer-events-none absolute inset-0 rounded-og-md bg-og-accent-soft"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0, 0.38, 0] }}
                        transition={{ duration: 0.72, times: [0, 0.18, 1], ease }}
                      />
                    ) : null}
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
              {stopping ? (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex min-h-[var(--og-session-chrome-chip-min-height)] items-center gap-1.5 px-1.5 text-og-xs text-og-fg-muted"
                  data-testid="session-chrome-stopping"
                >
                  <Loader2Icon
                    aria-hidden="true"
                    className="size-3 animate-og-spin motion-reduce:animate-none"
                  />
                  {stoppingKind === "current" ? "Current work stopping" : "Previous work stopping"}
                </span>
              ) : null}
            </div>
          </div>

          <div
            id={panelId}
            data-og-session-chrome-panel-shell=""
            aria-hidden={!open}
            inert={!open ? true : undefined}
            className="grid overflow-hidden motion-reduce:transition-none"
            style={{
              gridTemplateRows: open ? "1fr" : "0fr",
              opacity: open ? 1 : 0,
              pointerEvents: open ? "auto" : "none",
              transitionProperty: "grid-template-rows, opacity",
              transitionDuration: "var(--og-session-chrome-duration)",
              transitionTimingFunction: "var(--_og-session-chrome-ease)",
            }}
          >
            <div className="min-h-0 overflow-hidden">
              <div
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
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
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
                tip="Dismiss"
                onClick={() => onDismiss(input.id)}
                danger
              >
                <Trash2Icon className="size-3" />
              </IconAction>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function QueuePanel({
  turns,
  optimistic,
  loadError,
  mutationError,
  onRefresh,
  onClearMutationError,
  onRetryOptimistic,
  onRemoveOptimistic,
  readOnly,
  mutationFor,
  replaceDraftFor,
  onCancelReplace,
  onConfirmReplace,
  onEdit,
  onSteer,
  onRemove,
  onMove,
}: {
  turns: SessionTurn[];
  optimistic: ComposerOptimisticMessage[];
  loadError: Error | null;
  mutationError: Error | null;
  onRefresh: () => Promise<void>;
  onClearMutationError: () => void;
  onRetryOptimistic?: ((clientEventId: string) => void) | undefined;
  onRemoveOptimistic?: ((clientEventId: string) => void) | undefined;
  readOnly: boolean;
  mutationFor: UseTurnQueueResult["mutationFor"];
  replaceDraftFor?: string | null | undefined;
  onCancelReplace?: (() => void) | undefined;
  onConfirmReplace?: (() => void) | undefined;
  onEdit?: ((turn: SessionTurn) => void) | undefined;
  onSteer?: ((turnId: string) => void) | undefined;
  onRemove?: ((turnId: string) => void) | undefined;
  onMove?: ((turnId: string, beforeTurnId: string | null) => void) | undefined;
}) {
  const reduceMotion = useReducedMotion();
  const turnIdsKey = turns.map((turn) => turn.id).join(",");
  const [interactiveTurnIds, setInteractiveTurnIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    const visibleTurnIds = new Set(turnIdsKey ? turnIdsKey.split(",") : []);
    setInteractiveTurnIds((current) => {
      const retained = new Set([...current].filter((turnId) => visibleTurnIds.has(turnId)));
      return retained.size === current.size ? current : retained;
    });
    if (visibleTurnIds.size === 0) return;
    // An optimistic queue row and its authoritative replacement have different
    // React identities. Do not expose an actionable control during that short
    // handoff: a pointer can otherwise press the outgoing DOM node and release
    // over its replacement, producing a completed-looking click with no event.
    const timer = setTimeout(
      () => setInteractiveTurnIds((current) => new Set([...current, ...visibleTurnIds])),
      reduceMotion ? 0 : 240,
    );
    return () => clearTimeout(timer);
  }, [reduceMotion, turnIdsKey]);
  return (
    <ol
      className="flex flex-col gap-0.5"
      aria-label="Queued prompts"
      data-og-session-chrome-panel="queue"
    >
      {turns.map((turn, index) => {
        const presentation = queuedTurnPresentation(turn);
        const voice = presentation.kind !== "prompt";
        const pending = mutationFor(turn.id);
        const settling = !interactiveTurnIds.has(turn.id);
        const beforeUp = index > 0 ? (turns[index - 1]?.id ?? null) : null;
        const beforeDown = index < turns.length - 1 ? (turns[index + 2]?.id ?? null) : null;
        const showActions = !readOnly && (onEdit || onSteer || onRemove || onMove);
        const confirmingReplace = replaceDraftFor === turn.id;
        return (
          <li
            key={turn.id}
            data-queue-turn-id={turn.id}
            className="group flex flex-col gap-1 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--_og-session-chrome-row-hover)]"
          >
            <div className="flex items-start gap-1.5">
              {voice ? (
                <AudioLinesIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3 shrink-0 text-og-accent"
                />
              ) : (
                <span className="mt-px shrink-0 font-og-mono text-[10px] leading-4 text-og-fg-subtle">
                  {index + 1}
                </span>
              )}
              <p className="min-w-0 flex-1 truncate text-og-xs leading-4 text-og-fg">
                {presentation.text}
              </p>
              {showActions ? (
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
                  {onMove && turns.length > 1 ? (
                    <>
                      <IconAction
                        label={`Move queued prompt ${index + 1} up`}
                        tip="Move up"
                        disabled={settling || pending !== null || index === 0}
                        onClick={() => onMove(turn.id, beforeUp)}
                      >
                        <ArrowUpIcon className="size-3" />
                      </IconAction>
                      <IconAction
                        label={`Move queued prompt ${index + 1} down`}
                        tip="Move down"
                        disabled={settling || pending !== null || index >= turns.length - 1}
                        onClick={() => onMove(turn.id, beforeDown)}
                      >
                        <ArrowDownIcon className="size-3" />
                      </IconAction>
                    </>
                  ) : null}
                  {onSteer ? (
                    <IconAction
                      label={`Steer queued prompt ${index + 1}`}
                      tip={QUEUE_STEER_TIP}
                      disabled={settling || pending !== null}
                      onClick={() => onSteer(turn.id)}
                    >
                      {pending === "steer" ? (
                        <Loader2Icon className="size-3 animate-og-spin" />
                      ) : (
                        <ZapIcon className="size-3" />
                      )}
                    </IconAction>
                  ) : null}
                  {onEdit ? (
                    <IconAction
                      label={`Edit queued prompt ${index + 1}`}
                      tip={QUEUE_EDIT_TIP}
                      disabled={settling || pending !== null}
                      onClick={() => onEdit(turn)}
                    >
                      {pending === "edit" ? (
                        <Loader2Icon className="size-3 animate-og-spin" />
                      ) : (
                        <PencilIcon className="size-3" />
                      )}
                    </IconAction>
                  ) : null}
                  {onRemove ? (
                    <IconAction
                      label={`Remove queued prompt ${index + 1}`}
                      tip={QUEUE_DELETE_TIP}
                      disabled={settling || pending !== null}
                      onClick={() => onRemove(turn.id)}
                      danger
                    >
                      {pending === "delete" ? (
                        <Loader2Icon className="size-3 animate-og-spin" />
                      ) : (
                        <Trash2Icon className="size-3" />
                      )}
                    </IconAction>
                  ) : null}
                </div>
              ) : null}
            </div>
            {confirmingReplace ? (
              <div className="rounded-og-sm border border-og-status-waiting/30 bg-og-status-waiting/10 p-2 text-og-xs text-og-fg">
                <p>Your composer already has a draft. Replace it with this queued prompt?</p>
                <p className="mt-0.5 text-og-fg-muted">
                  The current draft will be permanently discarded; this queued prompt is preserved
                  until you confirm.
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
          </li>
        );
      })}
      <AnimatePresence initial={false}>
        {optimistic.map((message, index) => (
          <motion.li
            key={message.clientEventId}
            aria-live="polite"
            data-optimistic-queue-message={message.clientEventId}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.12, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "flex min-h-6 items-center gap-1.5 rounded-og-sm px-1.5 py-1",
              message.state === "failed" ? "bg-og-danger/8 text-og-danger" : "bg-og-accent-soft/45",
            )}
          >
            <span className="shrink-0 font-og-mono text-[10px] leading-4 text-og-fg-subtle">
              {turns.length + index + 1}
            </span>
            <p className="min-w-0 flex-1 truncate text-og-xs leading-4 text-og-fg">
              {message.text}
            </p>
            <span className="sr-only">
              {message.state === "failed"
                ? "Not confirmed"
                : message.state === "sending"
                  ? "Placing in queue"
                  : "Queued"}
            </span>
            {message.state === "failed" ? (
              <div className="flex shrink-0 items-center gap-1 text-[10px]">
                {onRetryOptimistic ? (
                  <button
                    type="button"
                    className="rounded-og-sm px-1.5 py-1 font-medium hover:bg-og-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    onClick={() => onRetryOptimistic(message.clientEventId)}
                  >
                    Retry
                  </button>
                ) : null}
                {onRemoveOptimistic ? (
                  <button
                    type="button"
                    aria-label="Dismiss unconfirmed queued prompt"
                    className="rounded-og-sm p-1 text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    onClick={() => onRemoveOptimistic(message.clientEventId)}
                  >
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </div>
            ) : message.state === "sending" ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3 shrink-0 animate-og-spin text-og-accent motion-reduce:animate-none"
              />
            ) : (
              <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-og-accent" />
            )}
          </motion.li>
        ))}
      </AnimatePresence>
      {loadError ? (
        <li
          role="alert"
          className="flex items-center gap-1.5 rounded-og-sm bg-og-danger/8 px-1.5 py-1 text-og-xs text-og-danger"
        >
          <TriangleAlertIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">Queue unavailable.</span>
          <button
            type="button"
            className="rounded-og-sm px-1.5 py-1 font-medium hover:bg-og-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            onClick={() => void onRefresh()}
          >
            Retry
          </button>
        </li>
      ) : null}
      {mutationError ? (
        <li
          role="alert"
          className="flex items-center gap-1.5 rounded-og-sm bg-og-danger/8 px-1.5 py-1 text-og-xs text-og-danger"
        >
          <TriangleAlertIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">Not confirmed. Check the queue before retrying.</span>
          <button
            type="button"
            className="rounded-og-sm px-1.5 py-1 font-medium hover:bg-og-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            onClick={onClearMutationError}
          >
            Dismiss
          </button>
        </li>
      ) : null}
    </ol>
  );
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
  const explanation = sessionChromeGoalPillExplanation(state, record);

  return (
    <div className="space-y-1.5" data-og-session-chrome-panel="goal">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-og-fg-subtle">
        <span>{sessionChromeGoalPillLabel(state, record)}</span>
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
      {explanation ? (
        <p
          data-og-session-chrome-goal-explanation
          className="text-og-xs leading-4 text-og-fg-muted"
        >
          {explanation}
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
            {record.autoContinuations} consecutive unattended continues
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

const QUEUE_STEER_TIP = (
  <span className="flex flex-col gap-0.5 text-left">
    <span className="font-medium">Steer</span>
    <span className="opacity-80">Interrupt the current turn and send this message now</span>
  </span>
);
const QUEUE_EDIT_TIP = "Edit in composer";
const QUEUE_DELETE_TIP = "Delete this queued prompt";

function IconAction({
  label,
  tip,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  tip: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-og-sm text-og-fg-subtle outline-hidden transition-colors",
            "hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40",
            "disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-9",
            danger && "hover:text-og-danger",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}
