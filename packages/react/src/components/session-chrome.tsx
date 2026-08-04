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
 * | `--og-session-chrome-highlight` | Sliding chip selection pill |
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
 * Segment switches keep the panel shell mounted and crossfade content while
 * animating measured height — no `mode="wait"` unmount flash.
 */
import type { SessionGoal, SessionPendingInputPreview, SessionTurn } from "@opengeni/sdk";
import {
  AudioLinesIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
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
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ComposerState } from "../hooks/use-composer";
import type { UseGoalResult } from "../hooks/use-goal";
import type { UseTurnQueueResult } from "../hooks/use-turn-queue";
import { cn } from "../lib/cn";
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
  const composerSteering = composer?.steering ?? null;
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
    if (steering) {
      rows.push({
        id: "steering",
        label: "Changing direction…",
        detail: steering.text,
        tone: "accent",
        icon:
          steering.phase === "submitting" ? (
            <Loader2Icon className="size-3 animate-og-spin" />
          ) : (
            <ZapIcon className="size-3" />
          ),
      });
    }
    if (queuedTurns.length > 0) {
      const presentations = queuedTurns.map(queuedTurnPresentation);
      const first = presentations[0];
      const allVoiceRequests = presentations.every(({ kind }) => kind === "realtime_voice");
      const onlyVoiceHandoff =
        presentations.length === 1 && first?.kind === "realtime_voice_handoff";
      const voiceOnly = allVoiceRequests || onlyVoiceHandoff;
      const detail = first?.text;
      rows.push({
        id: "queue",
        label: allVoiceRequests
          ? queuedTurns.length === 1
            ? "Voice request queued"
            : `${queuedTurns.length} voice requests queued`
          : onlyVoiceHandoff
            ? "Voice handoff queued"
            : `${queuedTurns.length} queued prompt${queuedTurns.length === 1 ? "" : "s"}`,
        ...(detail ? { detail } : {}),
        tone: "neutral",
        icon: voiceOnly ? (
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
  }, [agentsSignal, elapsed, goalState, incoming, queuedTurns, record, steering]);

  const [activeUncontrolled, setActiveUncontrolled] = useState<SessionChromeSignalId | null>(
    defaultActive,
  );
  const active = activeControlled !== undefined ? activeControlled : activeUncontrolled;
  const setActive = (next: SessionChromeSignalId | null) => {
    if (activeControlled === undefined) setActiveUncontrolled(next);
    onActiveChange?.(next);
  };
  const [replaceDraftFor, setReplaceDraftFor] = useState<string | null>(null);

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
  }, [open, active, incoming, queuedTurns, record, goalState, agentsPanel, agentsSignal, steering]);

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

  if (signals.length === 0) return null;

  const shellDuration = reduceMotion ? 0 : 0.22;
  const crossfadeDuration = reduceMotion ? 0 : 0.18;
  const ease = [0.22, 1, 0.36, 1] as const;

  const panelBody =
    active === "incoming" ? (
      <IncomingPanel inputs={incoming} onDismiss={onDismissIncoming} />
    ) : active === "steering" && steering ? (
      <SteeringPanel phase={steering.phase} text={steering.text} />
    ) : active === "queue" ? (
      <QueuePanel
        turns={queuedTurns}
        readOnly={!canMutateQueue}
        mutationFor={queue.mutationFor}
        replaceDraftFor={replaceDraftFor}
        onCancelReplace={() => setReplaceDraftFor(null)}
        onConfirmReplace={
          canMutateQueue && composer && replaceDraftFor
            ? () => {
                const turnId = replaceDraftFor;
                setReplaceDraftFor(null);
                void queue.editTurn(turnId, {
                  expectedDraftRevision: composer.draftRevision,
                  replaceDraft: true,
                });
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
                    void queue.editTurn(turn.id, {
                      expectedDraftRevision: composer.draftRevision,
                      replaceDraft: false,
                    });
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
            borderRadius: "var(--og-session-chrome-radius)",
            background: open
              ? "var(--og-session-chrome-surface-open)"
              : "var(--og-session-chrome-surface)",
            borderColor: open
              ? "var(--og-session-chrome-border-open)"
              : "var(--og-session-chrome-border)",
            boxShadow: open
              ? "var(--og-session-chrome-shadow-open)"
              : "var(--og-session-chrome-shadow)",
            transitionDuration: "var(--og-session-chrome-duration)",
            transitionTimingFunction: "var(--og-session-chrome-ease)",
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
                  background: "var(--og-session-chrome-highlight)",
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
                      "group relative z-[1] inline-flex min-h-[var(--og-session-chrome-chip-min-height)] max-w-full items-center gap-1 rounded-og-md text-left text-og-xs outline-none",
                      "transition-colors duration-150 motion-reduce:transition-none",
                      // Quiet focus — no accent ring (it fought the soft selection wash).
                      "hover:text-og-fg focus-visible:bg-og-surface-3/50",
                      "pointer-coarse:min-h-11",
                      selected ? "text-og-fg" : "text-og-fg-muted",
                    )}
                    style={{
                      paddingInline: "var(--og-session-chrome-chip-pad-x)",
                    }}
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

          <motion.div
            id={panelId}
            data-og-session-chrome-panel-shell=""
            initial={false}
            animate={{
              height: open ? panelHeight : 0,
              opacity: open ? 1 : 0,
            }}
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
          className="group flex items-start gap-1.5 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--og-session-chrome-row-hover)]"
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

function SteeringPanel({ phase, text }: { phase: "submitting" | "accepted"; text: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-og-sm px-1.5 py-1"
      role="status"
      aria-live="polite"
      data-og-session-chrome-panel="steering"
    >
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-og-accent-soft text-og-accent">
        {phase === "submitting" ? (
          <Loader2Icon className="size-3 animate-og-spin" aria-hidden="true" />
        ) : (
          <ZapIcon className="size-3" aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0">
        <p className="truncate text-og-xs font-medium leading-4 text-og-fg">{text}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-og-fg-muted">
          {phase === "submitting"
            ? "Sending your latest direction…"
            : "Direction accepted. The agent will continue from it."}
        </p>
      </div>
    </div>
  );
}

function QueuePanel({
  turns,
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
        const beforeUp = index > 0 ? (turns[index - 1]?.id ?? null) : null;
        const beforeDown = index < turns.length - 1 ? (turns[index + 2]?.id ?? null) : null;
        const showActions = !readOnly && (onEdit || onSteer || onRemove || onMove);
        const confirmingReplace = replaceDraftFor === turn.id;
        return (
          <li
            key={turn.id}
            data-queue-turn-id={turn.id}
            className="group flex flex-col gap-1 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--og-session-chrome-row-hover)]"
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
                        disabled={pending !== null || index === 0}
                        onClick={() => onMove(turn.id, beforeUp)}
                      >
                        <ArrowUpIcon className="size-3" />
                      </IconAction>
                      <IconAction
                        label={`Move queued prompt ${index + 1} down`}
                        tip="Move down"
                        disabled={pending !== null || index >= turns.length - 1}
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
                      disabled={pending !== null}
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
                      disabled={pending !== null}
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
                      disabled={pending !== null}
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
                className="inline-flex h-6 items-center gap-1 rounded-og-sm px-1.5 text-og-xs font-medium text-og-fg-muted outline-none transition-colors hover:bg-og-surface-3/70 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
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
              className="inline-flex h-6 items-center gap-1 rounded-og-sm px-1.5 text-og-xs font-medium text-og-fg-subtle outline-none transition-colors hover:bg-og-surface-3/70 hover:text-og-danger focus-visible:ring-2 focus-visible:ring-og-accent/40 disabled:opacity-50"
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
            "inline-flex size-6 items-center justify-center rounded-og-sm text-og-fg-subtle outline-none transition-colors",
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
