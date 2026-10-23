import { ChildSessionLink } from "./child-session-link";
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
 * The collapsed queue chip previews the latest queued message beside its Steer
 * action; open queue rows keep Steer visible and reveal the rest on hover.
 * Inbox has no product dismiss API; pass `onDismissIncoming` when the host
 * wants a visible action (dev harness may use a local dummy).
 *
 * Queue opens by default when chrome is idle and at least one authoritative
 * prompt is queued. Closing the queue dismisses that session's offer until
 * occupancy drains; a different session on the same chrome instance may
 * offer again. An in-flight optimistic Send never opens the drawer —
 * admission stays a paint-only receipt on the chip so layout does not jump
 * under the pointer.
 *
 * Segment switches keep the panel shell mounted and crossfade content. The
 * shell uses one CSS grid-track transition for deliberate open/close actions;
 * live queue reconciliation never feeds measurements back into layout.
 */
import type {
  SessionGoal,
  SessionPendingInputPreview,
  SessionStatus,
  SessionTurn,
} from "@opengeni/sdk";
import {
  ActivityIcon,
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
  TerminalIcon,
  TriangleAlertIcon,
  XIcon,
  CornerDownRightIcon,
  TargetIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { ComposerOptimisticMessage, ComposerState } from "../hooks/use-composer";
import type { UseGoalResult } from "../hooks/use-goal";
import type { UseTurnQueueResult } from "../hooks/use-turn-queue";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import { formatClockTime } from "../lib/format";
import {
  countAuthoritativeQueuedTurns,
  isAuthoritativeQueuedTurn,
  QUEUE_REPLACE_DRAFT_COPY,
  queuedTurnPresentation,
  queueNeighborAnchors,
} from "../queue-presentation-model";
import { requestQueueDraftEdit } from "./queue-draft-policy";
import { QUEUE_ITEM_CONTENT_UNAVAILABLE, queueItemContent } from "./queue-item-content";
import { TimelineAnnotationsChip, type TimelineAnnotationLike } from "./timeline-annotations";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { SingleSendWording, useOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { useCalmServiceFailure } from "../lib/use-calm-service-failure";

export type SessionChromeSignalId =
  | "incoming"
  | "steering"
  | "queue"
  | "goal"
  | "agents"
  | "commands";

export type SessionChromeSignalTone = "neutral" | "accent" | "waiting" | "running";

export type SessionChromeAgentsSignal = {
  count: number;
  detail?: string | undefined;
  tone?: SessionChromeSignalTone | undefined;
};

export type SessionChromeProps = {
  /** Authoritative execution status; omitted by older embedding hosts. */
  sessionStatus?: SessionStatus | undefined;
  queue: UseTurnQueueResult;
  /** Open and focus an existing queued prompt without changing its delivery. */
  queueFocusTarget?: { turnId: string; requestId: number } | undefined;
  /** Needed for queue edit → composer checkout. Omit with `readOnly`. */
  composer?: ComposerState | undefined;
  /** Focus the composer after a successful queue checkout has applied its draft.
   * Connect to the composer controller's `focusInput`, or a custom input ref.
   * Never called for failed checkout or while replacement awaits confirmation.
   */
  onComposerFocus?: (() => void) | undefined;
  goal?: UseGoalResult | null | undefined;
  /** Expanded agents body (host supplies tree / list). */
  agentsPanel?: ReactNode;
  /** Active commands only. The host mounts the body only when opened. */
  commandsPanel?: ReactNode;
  commandsCount?: number | undefined;
  /** Chip summary; when `count > 0` the agents segment appears. */
  agentsSignal?: SessionChromeAgentsSignal | undefined;
  /**
   * Optional inbox dismiss. Product pending-inputs have no remove API — hosts
   * (and the gallery) may still pass a handler so the action is visible.
   */
  onDismissIncoming?: ((inputId: string) => void) | undefined;
  /** Open a typed child update's source through the host's normal authorized route. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
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
  | "session_failed"
  | "blocked"
  | "held"
  | "paused"
  | "invariant_broken"
  | "completed";

const GOAL_LABEL = (t: OpenGeniText): Record<GoalPillState, string> => ({
  pursuing: t("sessionChrome.pursuing"),
  waiting: t("sessionChrome.waiting"),
  scheduled: t("sessionChrome.waiting"),
  blocked: t("sessionChrome.blocked"),
  session_failed: t("sessionChrome.blockedBySessionFailure"),
  held: t("sessionChrome.held"),
  paused: t("sessionChrome.paused"),
  invariant_broken: t("sessionChrome.needsAttention"),
  completed: t("sessionChrome.done"),
});

/**
 * Short pill suffix per `pausedReason`. `max_auto_continuations` is pacing
 * (new input resumes it); `limits` is an unspecified legacy admission gate; `user_pause`/`api` is
 * the human's own override; `agent` is the model declaring it is blocked on a
 * human decision. Unknown or legacy reasons keep the bare "Paused".
 */
const GOAL_PAUSED_REASON_SUFFIX = (t: OpenGeniText): Record<string, string> => ({
  max_auto_continuations: "cap",
  limits: "limits",
  model_unavailable: "model",
  model_policy: "policy",
  credits: "credits",
  budget: "budget",
  usage_limit: t("sessionChrome.usageLimit"),
  usage_policy: "limits",
  allowance: "allowance",
  session_usage_limit: t("sessionChrome.usageLimit"),
  user_pause: "manually",
  api: "manually",
  agent: "agent",
});

const GOAL_PAUSED_REASON_EXPLANATION = (t: OpenGeniText): Record<string, string> => ({
  max_auto_continuations: t("sessionChrome.pausedAtTheAutomaticContinuation"),
  limits: t("sessionChrome.pausedByAnAdmissionLimit"),
  model_unavailable: t("sessionChrome.theSelectedModelIsUnavailable"),
  model_policy: t("sessionChrome.theSelectedModelIsBlocked"),
  credits: t("sessionChrome.insufficientOpengeniCreditsAddCredits"),
  budget: t("sessionChrome.monthlyModelSpendingLimitReached"),
  usage_limit: t("sessionChrome.monthlyAgentRunLimitReached"),
  usage_policy: t("sessionChrome.theApplicationSUsagePolicy"),
  allowance: t("sessionChrome.opengeniUsageAllowanceExhaustedResume"),
  session_usage_limit: t("sessionChrome.pausedAtTheTaskS"),
  user_pause: t("sessionChrome.pausedManuallyByAPerson"),
  api: t("sessionChrome.pausedManuallyByAPerson"),
  agent: t("sessionChrome.pausedByTheAgentIt"),
});

type GoalPillRecord = Pick<SessionGoal, "status" | "pausedReason"> & {
  rationale?: SessionGoal["rationale"];
  continuation?: SessionGoal["continuation"] | null | undefined;
};

/** Pill label, with the pause reason spelled out: "Paused · cap" / "Paused · manually". */
export function sessionChromeGoalPillLabel(
  t: OpenGeniText,
  state: GoalPillState,
  record: GoalPillRecord | null | undefined,
): string {
  if (state !== "paused") return GOAL_LABEL(t)[state];
  const suffix = record?.pausedReason
    ? GOAL_PAUSED_REASON_SUFFIX(t)[record.pausedReason]
    : undefined;
  return suffix ? t("sessionChrome.pausedSuffix", { suffix }) : t("sessionChrome.paused");
}

/**
 * One human sentence explaining WHY the goal is not pursuing right now: the
 * pause reason, the agent's own `wait_for_input` hold (reason + deadline), or the
 * next idle-backoff check time. Null when the state needs no explanation.
 */
export function sessionChromeGoalPillExplanation(
  t: OpenGeniText,
  state: GoalPillState,
  record: GoalPillRecord | null | undefined,
): string | null {
  const continuation = record?.continuation ?? null;
  if (state === "session_failed") {
    return t("sessionChrome.resolveTheSessionFailureThen");
  }
  if (state === "paused") {
    const rationale = record?.rationale?.trim();
    if (rationale) return rationale;
    return record?.pausedReason
      ? (GOAL_PAUSED_REASON_EXPLANATION(t)[record.pausedReason] ?? null)
      : null;
  }
  if (state === "scheduled") {
    return continuation?.nextAttemptAt
      ? t("sessionChrome.continuesAtClocktime", {
          clockTime: formatClockTime(t, continuation.nextAttemptAt),
        })
      : t("sessionChrome.waitingToContinueAutomatically");
  }
  if (state === "waiting" && continuation?.reason === "system_work_pending") {
    return t("sessionChrome.waitingForOtherSessionWork");
  }
  if (state === "held" && continuation?.reason === "held_for_input") {
    const reason = continuation.holdReason?.trim();
    const until = continuation.nextAttemptAt
      ? ` until ${formatClockTime(t, continuation.nextAttemptAt)}`
      : "";
    return t("sessionChrome.waitingForInputValueUntil", {
      value: reason ? `: ${reason}` : "",
      until,
    });
  }
  return null;
}

export { countAuthoritativeQueuedTurns };

function isOptimisticQueuedMessage(
  message: ComposerOptimisticMessage,
  queuedTurnIds: ReadonlySet<string>,
  snapshot: UseTurnQueueResult["snapshot"],
): boolean {
  return (
    message.delivery === "send" &&
    message.destination === "queue" &&
    (!message.turnId || !queuedTurnIds.has(message.turnId)) &&
    !(
      message.turnId &&
      message.appliedQueueVersion !== null &&
      message.appliedQueueVersion !== undefined &&
      snapshot &&
      snapshot.version >= message.appliedQueueVersion
    )
  );
}

export function countOptimisticQueuedMessages(
  messages: readonly ComposerOptimisticMessage[] | undefined,
  queuedTurnIds: ReadonlySet<string>,
  snapshot: UseTurnQueueResult["snapshot"],
): number {
  return (messages ?? []).filter((message) =>
    isOptimisticQueuedMessage(message, queuedTurnIds, snapshot),
  ).length;
}

/**
 * First uncontrolled segment. An existing authoritative queue opens itself
 * when the host did not pick another default; optimistic-only occupancy
 * stays collapsed so a live Send does not shove a drawer under the pointer.
 */
export function sessionChromeInitialActive(input: {
  defaultActive: SessionChromeSignalId | null;
  authoritativeQueuedCount: number;
}): SessionChromeSignalId | null {
  if (input.defaultActive != null) return input.defaultActive;
  return input.authoritativeQueuedCount >= 1 ? "queue" : null;
}

/**
 * Whether idle chrome should offer the queue panel. A dismissed session
 * stays collapsed until occupancy drains. Controlled hosts own this.
 */
export function sessionChromeShouldOfferQueue(input: {
  controlled: boolean;
  active: SessionChromeSignalId | null;
  activityOpen: boolean;
  authoritativeQueuedCount: number;
  suppressed: boolean;
}): boolean {
  return (
    !input.controlled &&
    input.active === null &&
    !input.activityOpen &&
    input.authoritativeQueuedCount >= 1 &&
    !input.suppressed
  );
}

/** Select pill state from the goal's authoritative continuation projection. */
export function sessionChromeGoalPillState(
  goalStatus: "active" | "paused" | "completed",
  continuation: SessionGoal["continuation"] | null | undefined,
  sessionStatus?: SessionStatus,
): GoalPillState {
  if (goalStatus === "completed") return "completed";
  if (goalStatus === "paused") return "paused";
  if (sessionStatus === "failed") return "session_failed";
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
    if (
      continuation.reason === "human_turn_running" ||
      continuation.reason === "system_work_pending"
    ) {
      return "waiting";
    }
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

function pendingKindLabel(t: OpenGeniText, kind: SessionPendingInputPreview["kind"]): string {
  switch (kind) {
    case "child_terminal_result":
      return t("sessionChrome.childResult");
    case "child_requires_action":
      return t("sessionChrome.childNeedsInput");
    case "child_requires_action_resolved":
      return t("sessionChrome.childUnblocked");
    case "child_paused":
      return t("sessionChrome.childPaused");
    case "child_waiting_capacity":
      return t("sessionChrome.childWaiting");
    case "child_progress":
      return t("sessionChrome.childProgress");
    case "agent_steer_instruction":
      return t("sessionChrome.steer");
    case "scheduled_occurrence":
      return t("sessionChrome.schedule");
    case "goal_continuation":
      return t("sessionChrome.goalWake");
    case "agent_message":
      return t("sessionChrome.update");
    case "background_command_result":
      return t("sessionChrome.commandResult");
    case "session_wait_timeout":
      return t("sessionChrome.waitEnded");
    case "media_generation_result":
      return t("sessionChrome.videoResult");
    default:
      return t("sessionChrome.incoming");
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

/**
 * Under a single-Send composer (`composer.singleSend`) the chrome speaks of
 * waiting messages rather than a queue, and offers no Steer on them.
 */
export function SessionChrome(props: SessionChromeProps) {
  return (
    <SingleSendWording enabled={props.composer?.singleSend === true}>
      <SessionChromeView {...props} />
    </SingleSendWording>
  );
}

function SessionChromeView({
  sessionStatus,
  queue,
  queueFocusTarget,
  composer,
  onComposerFocus,
  goal,
  agentsPanel,
  commandsPanel,
  commandsCount = 0,
  agentsSignal,
  onDismissIncoming,
  onOpenSession,
  readOnly = false,
  className,
  active: activeControlled,
  defaultActive = null,
  onActiveChange,
}: SessionChromeProps) {
  const t = useOpenGeniText();
  const formatError = useErrorMessage();
  // A queue read failing while Opengeni updates is not a queue problem: the
  // hook keeps retrying and the last queue stays on screen. Only a failure
  // that outlasts a normal update (or a definitive one) needs attention.
  const queueLoadCalm = useCalmServiceFailure(queue.error);
  const queueLoadError = queueLoadCalm ? null : queue.error;
  const [activityRequested, setActivityOpen] = useState(
    Boolean(defaultActive && ["incoming", "agents", "commands"].includes(defaultActive)),
  );
  const reactId = useId();
  const panelId = `og-session-chrome-panel-${reactId}`;
  const reduceMotion = useReducedMotion();
  const record = goal?.goal ?? null;
  const incoming = queue.pendingInputs;
  const turns = queue.queue;
  const queueMutationFor = queue.mutationFor;
  const queuedTurns = useMemo(
    () => turns.filter((turn) => isAuthoritativeQueuedTurn(turn, queueMutationFor)),
    [queueMutationFor, turns],
  );
  const queuedTurnIds = useMemo(() => new Set(queuedTurns.map((turn) => turn.id)), [queuedTurns]);
  const optimisticQueued = useMemo(
    () =>
      (composer?.optimisticMessages ?? []).filter((message) =>
        isOptimisticQueuedMessage(message, queuedTurnIds, queue.snapshot),
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
  // One Send: nothing to choose, so waiting messages offer no Steer.
  const canSteerQueued = canMutateQueue && composer?.singleSend !== true;

  const elapsed = useLiveElapsed(record?.createdAt, Boolean(record));
  const goalState = record
    ? sessionChromeGoalPillState(record.status, record.continuation, sessionStatus)
    : null;

  const initialAuthoritativeQueuedCount = countAuthoritativeQueuedTurns(
    queue.queue,
    queue.mutationFor,
  );
  const [activeUncontrolled, setActiveUncontrolled] = useState<SessionChromeSignalId | null>(() =>
    sessionChromeInitialActive({
      defaultActive,
      authoritativeQueuedCount: initialAuthoritativeQueuedCount,
    }),
  );
  const active = activeControlled !== undefined ? activeControlled : activeUncontrolled;
  const rootRef = useRef<HTMLDivElement>(null);
  const openedQueueTargetRef = useRef<string | null>(null);
  const focusedQueueTargetRef = useRef<string | null>(null);
  const queueTargetKey = queueFocusTarget
    ? `${queueFocusTarget.turnId}:${queueFocusTarget.requestId}`
    : null;
  useEffect(() => {
    if (!queueTargetKey || openedQueueTargetRef.current === queueTargetKey) return;
    openedQueueTargetRef.current = queueTargetKey;
    if (activeControlled === undefined) setActiveUncontrolled("queue");
    onActiveChange?.("queue");
  }, [queueTargetKey, activeControlled, onActiveChange]);
  useEffect(() => {
    if (!queueFocusTarget || active !== "queue" || focusedQueueTargetRef.current === queueTargetKey)
      return;
    const root = rootRef.current;
    if (!root) return;
    const focus = () => {
      const row = Array.from(root.querySelectorAll<HTMLElement>("[data-queue-turn-id]")).find(
        (element) => element.dataset.queueTurnId === queueFocusTarget.turnId,
      );
      if (!row) return false;
      focusedQueueTargetRef.current = queueTargetKey;
      row.focus({ preventScroll: true });
      row.scrollIntoView?.({ block: "nearest" });
      return true;
    };
    if (focus()) return;
    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [queueFocusTarget, queueTargetKey, active, queuedTurns]);
  const activityOpen =
    activityRequested || Boolean(active && ["incoming", "agents", "commands"].includes(active));
  const activityVisibleRef = useRef(activityOpen);
  activityVisibleRef.current = activityOpen;
  // Two independent suppressions, both occupancy-scoped:
  // - admission: a live Send while idle must not open a drawer under the pointer
  // - dismiss: closing the queue remembers that session until occupancy drains
  const queueOfferAdmissionSuppressedRef = useRef(
    defaultActive == null &&
      initialAuthoritativeQueuedCount === 0 &&
      countOptimisticQueuedMessages(composer?.optimisticMessages, queuedTurnIds, queue.snapshot) >
        0,
  );
  const queueOfferDismissedSessionIdsRef = useRef<Set<string>>(new Set());
  const occupancySessionId = queuedTurns[0]?.sessionId ?? null;
  const setActive = (next: SessionChromeSignalId | null) => {
    if (active === "queue" && next === null) {
      if (occupancySessionId) {
        queueOfferDismissedSessionIdsRef.current.add(occupancySessionId);
      } else {
        queueOfferAdmissionSuppressedRef.current = true;
      }
    }
    if (activeControlled === undefined) setActiveUncontrolled(next);
    onActiveChange?.(next);
  };

  const hasCommandsPanel = commandsPanel != null;
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
    const queueProblem = queue.mutationError ?? queueLoadError;
    if (queuedCount > 0 || queueProblem) {
      const presentations = queuedTurns.map((turn) => queuedTurnPresentation(t, turn));
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
          ? t("sessionChrome.actionNotConfirmed")
          : t("sessionChrome.queueUnavailable2")
        : (first?.text ?? optimisticQueued[0]?.text);
      rows.push({
        id: "queue",
        label: queueProblem
          ? queuedCount > 0
            ? t("sessionChrome.queuedcountQueuedNeedsAttention", { queuedCount })
            : t("sessionChrome.queueNeedsAttention")
          : allVoiceRequests
            ? queuedCount === 1
              ? t("sessionChrome.voiceRequestQueued")
              : t("sessionChrome.queuedcountVoiceRequestsQueued", { queuedCount })
            : onlyVoiceHandoff
              ? t("sessionChrome.voiceHandoffQueued")
              : t("sessionChrome.queuedPromptCount", { count: queuedCount }),
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
        goalState === "session_failed" ||
        goalState === "held" ||
        goalState === "paused";
      const explanation = sessionChromeGoalPillExplanation(t, goalState, record);
      rows.push({
        id: "goal",
        label: sessionChromeGoalPillLabel(t, goalState, record),
        detail: elapsed ? `${elapsed} · ${record.text}` : record.text,
        ...(explanation ? { title: explanation } : {}),
        tone: waiting
          ? "waiting"
          : goalState === "pursuing" || goalState === "scheduled"
            ? "accent"
            : "neutral",
        icon: <TargetIcon className="size-3" />,
      });
    }
    if (agentsSignal && agentsSignal.count > 0) {
      const detail = agentsSignal.detail;
      rows.push({
        id: "agents",
        label: t("counts.agents", { count: agentsSignal.count }),
        ...(detail ? { detail } : {}),
        tone: agentsSignal.tone ?? "neutral",
        icon: <BotIcon className="size-3" />,
      });
    }
    if (commandsCount > 0 || (active === "commands" && hasCommandsPanel)) {
      rows.push({
        id: "commands",
        label:
          commandsCount > 0
            ? t("counts.commands", { count: commandsCount })
            : t("sessionChrome.commands2"),
        tone: commandsCount > 0 ? "running" : "neutral",
        icon: <TerminalIcon className="size-3" />,
      });
    }
    return rows;
  }, [
    commandsCount,
    hasCommandsPanel,
    active,
    agentsSignal,
    elapsed,
    goalState,
    incoming,
    optimisticQueued,
    queueLoadError,
    queue.mutationError,
    queuedTurns,
    record,
    t,
  ]);

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
    if (activeControlled === undefined && active === null) {
      queueOfferAdmissionSuppressedRef.current = true;
    }
  }, [active, activeControlled, optimisticQueueKeys, optimisticQueued]);
  const queueOccupied = queuedTurns.length > 0 || optimisticQueued.length > 0;
  useEffect(() => {
    if (queueOccupied) return;
    // A later wave may offer again. A prior session's dismiss must not stick
    // after this instance has actually gone empty.
    queueOfferAdmissionSuppressedRef.current = false;
    queueOfferDismissedSessionIdsRef.current.clear();
  }, [queueOccupied]);
  const queueOfferSuppressed =
    queueOfferAdmissionSuppressedRef.current ||
    (occupancySessionId != null &&
      queueOfferDismissedSessionIdsRef.current.has(occupancySessionId));
  useEffect(() => {
    if (
      !sessionChromeShouldOfferQueue({
        controlled: activeControlled !== undefined,
        active,
        activityOpen,
        authoritativeQueuedCount: queuedTurns.length,
        suppressed: queueOfferSuppressed,
      })
    ) {
      return;
    }
    if (activeControlled === undefined) setActiveUncontrolled("queue");
    onActiveChange?.("queue");
  }, [
    active,
    activeControlled,
    activityOpen,
    occupancySessionId,
    onActiveChange,
    queueOfferSuppressed,
    queuedTurns.length,
  ]);
  const [replaceDraftFor, setReplaceDraftFor] = useState<string | null>(null);

  const chipRefs = useRef<Partial<Record<SessionChromeSignalId, HTMLButtonElement | null>>>({});
  const railRef = useRef<HTMLDivElement | null>(null);
  const [pill, setPill] = useState({ left: 0, top: 0, width: 0, height: 0, opacity: 0 });

  const signalIds = signals.map((signal) => signal.id).join(",");
  useEffect(() => {
    if (!signals.some((signal) => ["incoming", "agents", "commands"].includes(signal.id)))
      setActivityOpen(false);
  }, [signals]);
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
      if (!chip) {
        setPill((prev) => ({ ...prev, opacity: 0 }));
        return;
      }
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
  // Collapsed queue chip shows the latest queued message so a Send that lands
  // in the queue is visible without opening the list; Steer acts on that
  // message once the server has confirmed it.
  const latestOptimisticQueued = optimisticQueued[optimisticQueued.length - 1];
  const latestQueuedTurn = queuedTurns[queuedTurns.length - 1];
  const queuePeek: { text: string | null; turnId: string | null } | null =
    queueLoadError || queue.mutationError
      ? null
      : latestOptimisticQueued
        ? { text: latestOptimisticQueued.text.trim() || null, turnId: null }
        : latestQueuedTurn
          ? {
              text: queuedTurnPresentation(t, latestQueuedTurn).text.trim() || null,
              turnId: latestQueuedTurn.id,
            }
          : null;

  if (signals.length === 0 && !stopping) return null;

  const shellDuration = reduceMotion ? 0 : 0.22;
  const crossfadeDuration = reduceMotion ? 0 : 0.18;
  const ease = [0.22, 1, 0.36, 1] as const;

  const panelBody =
    active === "incoming" ? (
      <IncomingPanel
        inputs={incoming}
        onDismiss={onDismissIncoming}
        onOpenSession={onOpenSession}
      />
    ) : active === "queue" ? (
      <QueuePanel
        turns={queuedTurns}
        optimistic={optimisticQueued}
        loadError={queueLoadError}
        mutationError={queue.mutationError}
        onRefresh={queue.refresh}
        onClearMutationError={queue.clearMutationError}
        onRetryOptimistic={composer?.retryOptimisticMessage}
        onRestoreOptimistic={composer?.restoreOptimisticMessage}
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
                  if (checkedOut) {
                    composer.applyDraft(checkedOut);
                    onComposerFocus?.();
                  }
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
                      if (checkedOut) {
                        composer.applyDraft(checkedOut);
                        onComposerFocus?.();
                      }
                    })();
                  },
                );
              }
            : undefined
        }
        onSteer={
          canSteerQueued
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
    ) : active === "commands" ? (
      <div data-og-session-chrome-panel="commands">{commandsPanel}</div>
    ) : active === "agents" ? (
      <div data-og-session-chrome-panel="agents">
        {agentsPanel ?? (
          <p className="text-og-xs text-og-fg-muted">{t("sessionChrome.noAgentDetails")}</p>
        )}
      </div>
    ) : null;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn("og-session-chrome og-root w-full", className)}
        data-testid="session-chrome"
        ref={rootRef}
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
            background: "transparent",
            borderColor: "transparent",
            boxShadow: "none",
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
              className="relative flex flex-nowrap items-center"
              style={{
                gap: "10px",
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
              {signals
                .filter((signal) => !["incoming", "agents", "commands"].includes(signal.id))
                .map((signal) => {
                  const selected = active === signal.id;
                  return (
                    <div
                      key={signal.id}
                      role="group"
                      aria-label={
                        signal.id === "queue"
                          ? t("sessionChrome.queuedMessagesAndActions")
                          : signal.id === "goal"
                            ? t("sessionChrome.goalAndActions")
                            : signal.label
                      }
                      className={cn(
                        "group/signal relative z-[1] inline-flex min-w-0 max-w-full items-center rounded-og-md",
                        "bg-og-surface-2/60 px-0.5",
                        selected && "bg-og-surface-3",
                      )}
                    >
                      <button
                        type="button"
                        ref={(node) => {
                          chipRefs.current[signal.id] = node;
                        }}
                        aria-expanded={selected}
                        aria-controls={panelId}
                        aria-label={
                          signal.id === "goal"
                            ? t("sessionChrome.goalValue", {
                                value:
                                  goalState === "pursuing"
                                    ? t("sessionChrome.running")
                                    : signal.label,
                              })
                            : selected
                              ? t("sessionChrome.closeLabel", { label: signal.label })
                              : undefined
                        }
                        data-testid={`session-chrome-${signal.id}`}
                        data-og-session-chrome-signal={signal.id}
                        title={signal.title ?? signal.label}
                        onClick={() => {
                          setActivityOpen(false);
                          setActive(selected ? null : signal.id);
                        }}
                        className={cn(
                          "group relative z-[1] inline-flex min-w-0 min-h-[var(--og-session-chrome-chip-min-height)] max-w-full items-center gap-1 rounded-og-md py-1 text-left text-og-xs outline-hidden",
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
                        <span
                          className={cn(
                            "font-medium text-og-fg",
                            signal.id === "queue" && queuePeek?.text && !selected
                              ? "shrink-0"
                              : "min-w-0 truncate",
                          )}
                        >
                          {signal.id === "goal" ? `${t("sessionChrome.goalPrefix")} ` : null}
                          {signal.id === "goal"
                            ? goalState === "pursuing"
                              ? t("sessionChrome.running")
                              : signal.label
                            : signal.id === "queue"
                              ? queueLoadError || queue.mutationError
                                ? signal.label
                                : t("sessionChrome.queuedCount", {
                                    count: queuedTurns.length + optimisticQueued.length,
                                  })
                              : signal.label}
                        </span>
                        {signal.id === "queue" && queuePeek?.text && !selected ? (
                          <AnimatePresence initial={false} mode="popLayout">
                            <motion.span
                              key={queuePeek.text}
                              data-testid="session-chrome-queue-peek"
                              className="min-w-0 max-w-[min(24rem,60vw)] truncate text-og-fg-muted"
                              initial={reduceMotion ? false : { opacity: 0, y: 3 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, transition: { duration: crossfadeDuration } }}
                              transition={{ duration: crossfadeDuration, ease }}
                            >
                              {queuePeek.text}
                            </motion.span>
                          </AnimatePresence>
                        ) : null}
                      </button>
                      {signal.id === "goal" && goal && record && !readOnly ? (
                        <div className="flex shrink-0 items-center pr-1 pl-0.5">
                          {record.status === "active" || record.status === "paused" ? (
                            <IconAction
                              label={
                                record.status === "paused"
                                  ? t("sessionChrome.resumeGoal")
                                  : t("sessionChrome.pauseGoal")
                              }
                              tip={
                                record.status === "paused"
                                  ? t("sessionChrome.resumeGoal")
                                  : t("sessionChrome.pauseGoal")
                              }
                              disabled={goal.updating}
                              onClick={() =>
                                void (record.status === "paused"
                                  ? goal.resume()
                                  : goal.pause("Paused from session chrome"))
                              }
                            >
                              {goal.updating ? (
                                <Loader2Icon className="size-3 animate-og-spin" />
                              ) : record.status === "paused" ? (
                                <PlayIcon className="size-3" />
                              ) : (
                                <PauseIcon className="size-3" />
                              )}
                            </IconAction>
                          ) : null}
                          <IconAction
                            label={t("sessionChrome.clearGoal")}
                            tip={t("sessionChrome.clearGoal")}
                            danger
                            disabled={goal.updating}
                            onClick={() => void goal.deleteGoal()}
                          >
                            <Trash2Icon className="size-3" />
                          </IconAction>
                        </div>
                      ) : signal.id === "queue" && canSteerQueued && queuePeek && !selected ? (
                        <div className="flex shrink-0 items-center pr-1 pl-0.5">
                          <IconAction
                            label={t("sessionChrome.steerLatestQueuedMessage")}
                            analyticsAction="steer"
                            text={t("sessionChrome.steer")}
                            tip={<QueueSteerTip />}
                            disabled={
                              !queuePeek.turnId ||
                              queue.mutating ||
                              Boolean(queue.mutationFor(queuePeek.turnId))
                            }
                            onClick={() => {
                              if (queuePeek.turnId) void queue.steerTurn(queuePeek.turnId);
                            }}
                          >
                            {queuePeek.turnId && queue.mutationFor(queuePeek.turnId) === "steer" ? (
                              <Loader2Icon className="size-3 animate-og-spin" />
                            ) : (
                              <CornerDownRightIcon className="size-3" />
                            )}
                          </IconAction>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              {signals.some((signal) => ["incoming", "agents", "commands"].includes(signal.id)) ? (
                <button
                  type="button"
                  aria-label={t("sessionChrome.sessionActivity")}
                  aria-describedby={commandsCount > 0 ? `${panelId}-commands-count` : undefined}
                  title={
                    activityOpen
                      ? t("sessionChrome.closeActivity")
                      : t("sessionChrome.inboxAgentsAndCommands")
                  }
                  aria-controls={panelId}
                  aria-expanded={activityOpen}
                  onClick={() => {
                    setActivityOpen(!activityOpen);
                    setActive(
                      activityOpen
                        ? null
                        : commandsCount > 0 && hasCommandsPanel
                          ? "commands"
                          : (signals.find((signal) =>
                              ["incoming", "agents", "commands"].includes(signal.id),
                            )?.id ?? null),
                    );
                  }}
                  className={cn(
                    "ml-auto inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-og-md px-2 text-og-xs transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
                    activityOpen
                      ? "bg-og-surface-3 text-og-fg"
                      : "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg",
                  )}
                >
                  <ActivityIcon className="size-3.5" />
                  <span className="sr-only">{t("sessionChrome.activity")}</span>
                  {commandsCount > 0 ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 animate-og-pulse rounded-full bg-og-fg-muted motion-reduce:animate-none"
                      />
                      <span id={`${panelId}-commands-count`}>
                        {t("sessionChrome.commands", { count: commandsCount })}
                      </span>
                    </>
                  ) : null}
                  {incoming.length > 0 ? (
                    <span className="size-1.5 rounded-full bg-og-accent" />
                  ) : null}
                </button>
              ) : null}
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
                  {stoppingKind === "current"
                    ? t("sessionChrome.currentWorkStopping")
                    : t("sessionChrome.previousWorkStopping")}
                </span>
              ) : null}
            </div>
          </div>

          <AnimatePresence initial={false}>
            {activityOpen ? (
              <motion.div
                key="activity-tabs"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: shellDuration, ease }}
                style={{ overflow: "hidden" }}
              >
                <div className="mt-1 flex items-center gap-1 rounded-t-og-lg bg-og-surface-2/50 px-2 py-1">
                  {signals
                    .filter((signal) => ["incoming", "agents", "commands"].includes(signal.id))
                    .map((signal) => (
                      <button
                        key={signal.id}
                        type="button"
                        aria-expanded={active === signal.id}
                        onClick={() => {
                          if (activityVisibleRef.current) setActive(signal.id);
                        }}
                        className={cn(
                          "inline-flex min-h-9 items-center gap-1.5 rounded-og-md px-2 text-og-xs pointer-coarse:min-h-11",
                          active === signal.id
                            ? "bg-og-surface-3 text-og-fg"
                            : "text-og-fg-muted hover:text-og-fg",
                        )}
                      >
                        {signal.icon}
                        {signal.id === "incoming"
                          ? t("sessionChrome.lengthIncoming", { length: incoming.length })
                          : signal.label}
                      </button>
                    ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          {goal?.mutationError ? (
            <p role="alert" className="px-3 pb-2 text-og-xs text-og-danger">
              {t("sessionChrome.goalActionNotConfirmedError", {
                error: formatError(goal.mutationError),
              })}
            </p>
          ) : null}
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
                className={cn(
                  "relative overflow-y-auto overscroll-contain",
                  activityOpen
                    ? "rounded-b-og-lg bg-og-surface-2/50"
                    : "mt-1 rounded-og-lg bg-og-surface-2/50",
                )}
                style={{
                  maxHeight: "var(--og-session-chrome-panel-max-height)",
                  paddingInline: "var(--og-session-chrome-panel-pad-x)",
                  paddingBlock: "var(--og-session-chrome-panel-pad-y)",
                }}
              >
                <AnimatePresence initial={false}>
                  {active && active !== "commands" && panelBody ? (
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
                {active === "commands" ? (
                  <motion.div
                    key="commands"
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: crossfadeDuration, ease }}
                  >
                    {panelBody}
                  </motion.div>
                ) : null}
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
  onOpenSession,
}: {
  inputs: SessionPendingInputPreview[];
  onDismiss?: ((inputId: string) => void) | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  // When a sandbox is shut down or lost, every command on it reports at once.
  // One row reads better than dozens of identical ones; each result still
  // reaches the agent. Ordinary results keep their own rows.
  const lostWithSandbox = inputs.filter(isLostWithSandboxResult);
  const grouped = new Set(
    lostWithSandbox.length >= 2 ? lostWithSandbox.map((input) => input.id) : [],
  );
  const firstGrouped = lostWithSandbox.length >= 2 ? lostWithSandbox[0]!.id : null;
  return (
    <div>
      <p className="mb-2 text-og-xs text-og-fg-subtle">
        {t("sessionChrome.waitingToBeIncludedIn")}
      </p>
      <ul
        className="flex flex-col gap-0.5"
        aria-label={t("sessionChrome.incomingUpdates")}
        data-og-session-chrome-panel="incoming"
      >
        {inputs.map((input) =>
          grouped.has(input.id) ? (
            input.id === firstGrouped ? (
              <CommandResultsRow key={input.id} inputs={lostWithSandbox} onDismiss={onDismiss} />
            ) : null
          ) : (
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
                {pendingKindLabel(t, input.kind)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words text-og-xs leading-4 text-og-fg">{input.summary}</p>
                <ChildSessionLink
                  kind={input.kind}
                  sourceId={input.sourceId}
                  onOpenSession={onOpenSession}
                />
              </div>
              {onDismiss ? (
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
                  <IconAction
                    label={t("sessionChrome.dismissIncomingPendingkindlabel", {
                      pendingKindLabel: pendingKindLabel(t, input.kind),
                    })}
                    tip="Dismiss"
                    onClick={() => onDismiss(input.id)}
                    danger
                  >
                    <Trash2Icon className="size-3" />
                  </IconAction>
                </div>
              ) : null}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/** Matches the worker's notice for a command whose sandbox is gone. */
function isLostWithSandboxResult(input: SessionPendingInputPreview): boolean {
  return (
    input.kind === "background_command_result" &&
    input.summary.includes("is no longer running because its sandbox was shut down or lost")
  );
}

function commandResultsSummary(t: OpenGeniText, inputs: SessionPendingInputPreview[]): string {
  return t("sessionChrome.lengthBackgroundCommandsAreNo", { length: inputs.length });
}

function CommandResultsRow({
  inputs,
  onDismiss,
}: {
  inputs: SessionPendingInputPreview[];
  onDismiss?: ((inputId: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  return (
    <li
      className="group flex items-start gap-1.5 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--_og-session-chrome-row-hover)]"
      data-og-session-chrome-command-results={inputs.length}
    >
      <span className="mt-px shrink-0 rounded bg-og-status-waiting/12 px-1 py-px text-[10px] font-medium leading-4 text-og-status-waiting">
        {t("sessionChrome.commandResults")}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-og-xs leading-4 text-og-fg">
          {commandResultsSummary(t, inputs)}
        </p>
      </div>
      {onDismiss ? (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
          <IconAction
            label={t("sessionChrome.dismissIncomingCommandResults")}
            tip={t("sessionChrome.dismissAll")}
            onClick={() => {
              for (const input of inputs) onDismiss(input.id);
            }}
            danger
          >
            <Trash2Icon className="size-3" />
          </IconAction>
        </div>
      ) : null}
    </li>
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
  onRestoreOptimistic,
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
  onRestoreOptimistic?: ((clientEventId: string) => void) | undefined;
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
  const t = useOpenGeniText();
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
      aria-label={t("sessionChrome.queuedPrompts")}
      data-og-session-chrome-panel="queue"
    >
      {turns.map((turn, index) => {
        const presentation = queuedTurnPresentation(t, turn);
        const voice = presentation.kind !== "prompt";
        const pending = mutationFor(turn.id);
        const settling = !interactiveTurnIds.has(turn.id);
        const { beforeUp, beforeDown } = queueNeighborAnchors(turns, index);
        const showActions = !readOnly && (onEdit || onSteer || onRemove || onMove);
        const confirmingReplace = replaceDraftFor === turn.id;
        return (
          <li
            key={turn.id}
            data-queue-turn-id={turn.id}
            tabIndex={-1}
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
              <CompactQueueItemContent
                text={presentation.text}
                annotations={turn.annotations ?? []}
              />
              {showActions ? (
                <div className="flex shrink-0 items-center gap-0.5">
                  {/* Reorder, edit and delete stay on hover; Steer is always visible. */}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
                    {onMove && turns.length > 1 ? (
                      <>
                        <IconAction
                          label={t("sessionChrome.moveQueuedPromptIndexUp", { index: index + 1 })}
                          tip={t("sessionChrome.moveUp")}
                          disabled={settling || pending !== null || index === 0}
                          onClick={() => onMove(turn.id, beforeUp)}
                        >
                          <ArrowUpIcon className="size-3" />
                        </IconAction>
                        <IconAction
                          label={t("sessionChrome.moveQueuedPromptIndexDown", { index: index + 1 })}
                          tip={t("sessionChrome.moveDown")}
                          disabled={settling || pending !== null || index >= turns.length - 1}
                          onClick={() => onMove(turn.id, beforeDown)}
                        >
                          <ArrowDownIcon className="size-3" />
                        </IconAction>
                      </>
                    ) : null}
                    {onEdit ? (
                      <IconAction
                        label={t("sessionChrome.editQueuedPromptIndex", { index: index + 1 })}
                        tip={QUEUE_EDIT_TIP(t)}
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
                        label={t("sessionChrome.removeQueuedPromptIndex", { index: index + 1 })}
                        tip={QUEUE_DELETE_TIP(t)}
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
                  {onSteer ? (
                    <IconAction
                      label={t("sessionChrome.steerQueuedPromptIndex", { index: index + 1 })}
                      analyticsAction="steer"
                      text={t("sessionChrome.steer")}
                      tip={<QueueSteerTip />}
                      disabled={settling || pending !== null}
                      onClick={() => onSteer(turn.id)}
                    >
                      {pending === "steer" ? (
                        <Loader2Icon className="size-3 animate-og-spin" />
                      ) : (
                        <CornerDownRightIcon className="size-3" />
                      )}
                    </IconAction>
                  ) : null}
                </div>
              ) : null}
            </div>
            {confirmingReplace ? (
              <div className="rounded-og-sm border border-og-status-waiting/30 bg-og-status-waiting/10 p-2 text-og-xs text-og-fg">
                <p>{QUEUE_REPLACE_DRAFT_COPY(t).title}</p>
                <p className="mt-0.5 text-og-fg-muted">{QUEUE_REPLACE_DRAFT_COPY(t).detail}</p>
                <div className="mt-2 flex justify-end gap-1.5">
                  <button
                    type="button"
                    className="rounded-og-sm px-2 py-1 font-medium hover:bg-og-surface-3/70 focus-visible:ring-2 focus-visible:ring-og-accent/40"
                    onClick={onCancelReplace}
                  >
                    {QUEUE_REPLACE_DRAFT_COPY(t).keep}
                  </button>
                  <button
                    type="button"
                    className="rounded-og-sm border border-og-primary-border bg-og-primary text-og-primary-fg px-2 py-1 font-medium hover:bg-og-primary-hover focus-visible:ring-2 focus-visible:ring-og-accent/40"
                    onClick={onConfirmReplace}
                  >
                    {QUEUE_REPLACE_DRAFT_COPY(t).replace}
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
            <div className="min-w-0 flex-1">
              <CompactQueueItemContent text={message.text} annotations={message.annotations} />
              {message.state === "failed" && message.error ? (
                <p className="break-words text-og-xs">{message.error}</p>
              ) : null}
            </div>
            <span className="sr-only">
              {message.state === "failed"
                ? message.outcomeUnknown
                  ? t("sessionChrome.notConfirmed")
                  : t("sessionChrome.messageNotSent")
                : message.state === "sending"
                  ? t("sessionChrome.placingInQueue")
                  : t("sessionChrome.queued")}
            </span>
            {message.state === "failed" ? (
              <div className="flex shrink-0 items-center gap-1 text-[10px]">
                {message.retryable !== false && onRetryOptimistic ? (
                  <button
                    type="button"
                    className="rounded-og-sm px-1.5 py-1 font-medium hover:bg-og-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    onClick={() => onRetryOptimistic(message.clientEventId)}
                  >
                    {t("sessionChrome.retry")}
                  </button>
                ) : null}
                {message.retryable === false && onRestoreOptimistic ? (
                  <button
                    type="button"
                    className="rounded-og-sm px-1.5 py-1 font-medium hover:bg-og-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    onClick={() => onRestoreOptimistic(message.clientEventId)}
                  >
                    {t("sessionChrome.editMessage")}
                  </button>
                ) : null}
                {onRemoveOptimistic ? (
                  <button
                    type="button"
                    aria-label={t("sessionChrome.dismissUnconfirmedQueuedPrompt")}
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
          <span className="min-w-0 flex-1">{t("sessionChrome.queueUnavailable")}</span>
          <button
            type="button"
            className="rounded-og-sm px-1.5 py-1 font-medium hover:bg-og-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            onClick={() => void onRefresh()}
          >
            {t("sessionChrome.retry")}
          </button>
        </li>
      ) : null}
      {mutationError ? (
        <li
          role="alert"
          className="flex items-center gap-1.5 rounded-og-sm bg-og-danger/8 px-1.5 py-1 text-og-xs text-og-danger"
        >
          <TriangleAlertIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">{t("sessionChrome.notConfirmedCheckTheQueue")}</span>
          <button
            type="button"
            className="rounded-og-sm px-1.5 py-1 font-medium hover:bg-og-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            onClick={onClearMutationError}
          >
            {t("sessionChrome.dismiss")}
          </button>
        </li>
      ) : null}
    </ol>
  );
}

function CompactQueueItemContent({
  text,
  annotations,
}: {
  text: string;
  annotations: readonly TimelineAnnotationLike[];
}) {
  const t = useOpenGeniText();
  const content = queueItemContent(text, annotations.length);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {content === "text" ? (
        <p className="min-w-0 flex-1 truncate text-og-xs leading-4 text-og-fg">{text}</p>
      ) : content === "unavailable" ? (
        <p className="min-w-0 flex-1 truncate text-og-xs leading-4 text-og-fg-muted italic">
          {QUEUE_ITEM_CONTENT_UNAVAILABLE(t)}
        </p>
      ) : null}
      {annotations.length > 0 ? (
        <TimelineAnnotationsChip annotations={annotations} className="shrink-0" compact />
      ) : null}
    </div>
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
  const t = useOpenGeniText();
  const formatError = useErrorMessage();
  const record = goal.goal;
  if (!record) return null;
  const canToggle = !readOnly && (record.status === "active" || record.status === "paused");
  const explanation = sessionChromeGoalPillExplanation(t, state, record);

  return (
    <div className="space-y-1.5" data-og-session-chrome-panel="goal">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-og-fg-subtle">
        <span>{sessionChromeGoalPillLabel(t, state, record)}</span>
        {elapsed ? (
          <span className="tabular-nums normal-case tracking-normal text-og-fg-muted">
            {t("sessionChrome.createdElapsedAgo", { elapsed })}
          </span>
        ) : null}
        <span className="normal-case tracking-normal text-og-fg-muted">· v{record.version}</span>
      </div>
      <p className="text-og-sm leading-5 text-og-fg">{record.text}</p>
      {record.successCriteria ? (
        <p className="text-og-xs leading-4 text-og-fg-muted">
          <span className="font-medium text-og-fg">{t("sessionChrome.doneWhen")}</span>{" "}
          {record.successCriteria}
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
          {formatError(record.continuation.lastError)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5">
        <div className="flex flex-wrap gap-1 text-[10px] text-og-fg-muted">
          <span className="rounded bg-og-surface-3/70 px-1 py-px">
            {t("sessionChrome.autocontinuationsConsecutiveUnattendedContinues", {
              autoContinuations: record.autoContinuations,
            })}
          </span>
          <span className="rounded bg-og-surface-3/70 px-1 py-px">
            {t("sessionChrome.noprogressstreakStalled", {
              noProgressStreak: record.noProgressStreak,
            })}
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
                {record.status === "paused" ? t("sessionChrome.resume") : t("sessionChrome.pause")}
              </button>
            ) : null}
            <button
              type="button"
              disabled={goal.updating}
              onClick={() => void goal.deleteGoal()}
              className="inline-flex h-6 items-center gap-1 rounded-og-sm px-1.5 text-og-xs font-medium text-og-fg-subtle outline-hidden transition-colors hover:bg-og-surface-3/70 hover:text-og-danger focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
            >
              <Trash2Icon className="size-3" />
              {t("sessionChrome.clear")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QueueSteerTip() {
  const t = useOpenGeniText();
  return (
    <span className="flex flex-col gap-0.5 text-left">
      <span className="font-medium">{t("sessionChrome.steer")}</span>
      <span className="opacity-80">{t("sessionChrome.steerTip")}</span>
    </span>
  );
}
const QUEUE_EDIT_TIP = (t: OpenGeniText) => t("sessionChrome.editInComposer");
const QUEUE_DELETE_TIP = (t: OpenGeniText) => t("sessionChrome.deleteThisQueuedPrompt");

function IconAction({
  text,
  label,
  analyticsAction,
  tip,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  /** Stable, content-free control label a host's product analytics may read. */
  analyticsAction?: "steer";
  text?: string;
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
          data-analytics-action={analyticsAction}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-og-sm outline-hidden transition-colors",
            "hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40",
            "disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-9",
            text ? "text-og-fg" : "text-og-fg-subtle",
            text && "w-auto gap-1 px-1.5 text-og-xs pointer-coarse:w-auto",
            danger && "hover:text-og-danger",
          )}
        >
          {children}
          {text}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}
