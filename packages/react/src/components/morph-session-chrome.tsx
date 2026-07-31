/**
 * MorphSessionChrome — compact merged session signals above the composer.
 *
 * Opt-in embed surface. Production hosts can keep QueueSurface + GoalSurface
 * until they choose Morph; gallery tab 7 consumes this component.
 *
 * ## Host tokens
 * Override on `.og-morph` (or any ancestor). Defaults live in `tokens.css`.
 *
 * | Token | Role |
 * | --- | --- |
 * | `--og-morph-surface` / `-open` | Dock fill (collapsed / expanded) |
 * | `--og-morph-border` / `-open` | Dock edge |
 * | `--og-morph-highlight` | Sliding chip selection pill |
 * | `--og-morph-shadow` / `-open` | Elevation |
 * | `--og-morph-radius` | Dock corner radius |
 * | `--og-morph-chip-min-height` | Signal chip height |
 * | `--og-morph-chip-pad-x` / `--og-morph-chip-gap` | Chip padding / rail gap |
 * | `--og-morph-rail-pad` | Outer rail inset |
 * | `--og-morph-panel-pad-x` / `-y` | Expanded panel padding |
 * | `--og-morph-duration` / `--og-morph-ease` | Expand + pill motion |
 * | `--og-morph-row-hover` | Inbox / queue row hover wash |
 *
 * Inbox and queue stay separate segments. Queue hover actions wire to
 * `UseTurnQueueResult` (`editTurn` / `steerTurn` / `moveTurn` / `removeTurn`).
 * Inbox has no product dismiss API; pass `onDismissIncoming` when the host
 * wants a visible action (gallery uses a local dummy).
 */
import type { SessionGoal, SessionPendingInputPreview, SessionTurn } from "@opengeni/sdk";
import {
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

export type MorphSignalId = "incoming" | "queue" | "goal" | "agents";

export type MorphSignalTone = "neutral" | "accent" | "waiting" | "running";

export type MorphAgentsSignal = {
  count: number;
  detail?: string | undefined;
  tone?: MorphSignalTone | undefined;
};

export type MorphSessionChromeProps = {
  queue: UseTurnQueueResult;
  /** Needed for queue edit → composer checkout. Omit with `readOnly`. */
  composer?: ComposerState | undefined;
  goal?: UseGoalResult | null | undefined;
  /** Expanded agents body (host supplies tree / list). */
  agentsPanel?: ReactNode;
  /** Chip summary; when `count > 0` the agents segment appears. */
  agentsSignal?: MorphAgentsSignal | undefined;
  /**
   * Optional inbox dismiss. Product pending-inputs have no remove API — hosts
   * (and the gallery) may still pass a handler so the action is visible.
   */
  onDismissIncoming?: ((inputId: string) => void) | undefined;
  readOnly?: boolean | undefined;
  className?: string | undefined;
  /** Controlled active segment; omit for uncontrolled. */
  active?: MorphSignalId | null | undefined;
  defaultActive?: MorphSignalId | null | undefined;
  onActiveChange?: ((next: MorphSignalId | null) => void) | undefined;
};

type GoalPillState =
  | "pursuing"
  | "scheduled"
  | "blocked"
  | "held"
  | "paused"
  | "invariant_broken"
  | "completed";

const GOAL_LABEL: Record<GoalPillState, string> = {
  pursuing: "Pursuing",
  scheduled: "Scheduled",
  blocked: "Blocked",
  held: "Held",
  paused: "Paused",
  invariant_broken: "Needs attention",
  completed: "Done",
};

/** Select pill state from the goal's authoritative continuation projection. */
export function morphGoalPillState(
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

function useLiveElapsed(startIso: string | null | undefined, live: boolean, endIso?: string | null) {
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

function toneClass(tone: MorphSignalTone, selected: boolean): string {
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

export function MorphSessionChrome({
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
}: MorphSessionChromeProps) {
  const reactId = useId();
  const panelId = `og-morph-panel-${reactId}`;
  const reduceMotion = useReducedMotion();
  const record = goal?.goal ?? null;
  const incoming = queue.pendingInputs;
  const turns = queue.queue;
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
  const goalState = record ? morphGoalPillState(record.status, record.continuation) : null;

  const signals = useMemo(() => {
    const rows: Array<{
      id: MorphSignalId;
      label: string;
      detail?: string | undefined;
      tone: MorphSignalTone;
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
    if (turns.length > 0) {
      const detail = turns[0]?.prompt;
      rows.push({
        id: "queue",
        label: `${turns.length} queued`,
        ...(detail ? { detail } : {}),
        tone: "neutral",
        icon: <ListOrderedIcon className="size-3" />,
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
  }, [agentsSignal, elapsed, goalState, incoming, record, turns]);

  const [activeUncontrolled, setActiveUncontrolled] = useState<MorphSignalId | null>(defaultActive);
  const active = activeControlled !== undefined ? activeControlled : activeUncontrolled;
  const setActive = (next: MorphSignalId | null) => {
    if (activeControlled === undefined) setActiveUncontrolled(next);
    onActiveChange?.(next);
  };

  const chipRefs = useRef<Partial<Record<MorphSignalId, HTMLButtonElement | null>>>({});
  const railRef = useRef<HTMLDivElement | null>(null);
  const [pill, setPill] = useState({ left: 0, width: 0, opacity: 0 });

  const signalIds = signals.map((signal) => signal.id).join(",");
  useEffect(() => {
    if (active && !signalIds.split(",").includes(active)) {
      if (activeControlled === undefined) setActiveUncontrolled(null);
      onActiveChange?.(null);
    }
  }, [active, activeControlled, onActiveChange, signalIds]);

  useEffect(() => {
    const rail = railRef.current;
    const measure = () => {
      if (!rail || !active) {
        setPill((prev) => (prev.opacity === 0 ? prev : { ...prev, opacity: 0 }));
        return;
      }
      const chip = chipRefs.current[active];
      if (!chip) return;
      const railBox = rail.getBoundingClientRect();
      const chipBox = chip.getBoundingClientRect();
      setPill({
        left: chipBox.left - railBox.left,
        width: chipBox.width,
        opacity: 1,
      });
    };
    measure();
    if (!rail) return;
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, signals]);

  if (signals.length === 0) return null;

  const open = active !== null;
  const duration = reduceMotion ? 0 : undefined;
  const ease = [0.22, 1, 0.36, 1] as const;

  return (
    <div
      className={cn("og-morph w-full", className)}
      data-og-morph=""
      data-og-morph-open={open ? "true" : "false"}
    >
      <div
        className={cn(
          "relative overflow-hidden border",
          "transition-[background-color,border-color,box-shadow] motion-reduce:transition-none",
        )}
        style={{
          borderRadius: "var(--og-morph-radius)",
          background: open ? "var(--og-morph-surface-open)" : "var(--og-morph-surface)",
          borderColor: open ? "var(--og-morph-border-open)" : "var(--og-morph-border)",
          boxShadow: open ? "var(--og-morph-shadow-open)" : "var(--og-morph-shadow)",
          transitionDuration: "var(--og-morph-duration)",
          transitionTimingFunction: "var(--og-morph-ease)",
        }}
      >
        <div
          ref={railRef}
          className="relative flex flex-wrap items-stretch"
          style={{
            gap: "var(--og-morph-chip-gap)",
            padding: "var(--og-morph-rail-pad)",
          }}
        >
          <motion.div
            aria-hidden
            className="pointer-events-none absolute rounded-og-md ring-1 ring-og-border/50"
            style={{
              top: "var(--og-morph-rail-pad)",
              bottom: "var(--og-morph-rail-pad)",
              background: "var(--og-morph-highlight)",
            }}
            initial={false}
            animate={{
              x: pill.left,
              width: pill.width,
              opacity: pill.opacity,
            }}
            transition={{ duration: duration ?? 0.22, ease }}
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
                data-og-morph-signal={signal.id}
                onClick={() => setActive(selected ? null : signal.id)}
                className={cn(
                  "group relative z-[1] inline-flex max-w-full items-center gap-1 rounded-og-md text-left text-og-xs outline-none",
                  "transition-colors duration-150 motion-reduce:transition-none",
                  "hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40",
                  "pointer-coarse:min-h-11",
                  selected ? "text-og-fg" : "text-og-fg-muted",
                )}
                style={{
                  minHeight: "var(--og-morph-chip-min-height)",
                  paddingInline: "var(--og-morph-chip-pad-x)",
                }}
              >
                <span className={cn("shrink-0", toneClass(signal.tone, selected))}>
                  {signal.icon}
                </span>
                <span className="shrink-0 font-medium">{signal.label}</span>
                {signal.detail ? (
                  <>
                    <span aria-hidden className="shrink-0 text-og-fg-subtle/60">
                      ·
                    </span>
                    <span className="min-w-0 max-w-[8.5rem] truncate text-og-fg-muted sm:max-w-[12rem]">
                      {signal.detail}
                    </span>
                  </>
                ) : null}
              </button>
            );
          })}
          {open ? (
            <button
              type="button"
              aria-label="Close session chrome panel"
              onClick={() => setActive(null)}
              className="relative z-[1] ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-og-md text-og-fg-subtle outline-none transition-colors hover:bg-og-surface-3/60 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/40 pointer-coarse:size-11"
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>

        <motion.div
          id={panelId}
          initial={false}
          animate={{
            height: open ? "auto" : 0,
            opacity: open ? 1 : 0,
          }}
          transition={{ duration: duration ?? 0.22, ease }}
          className="overflow-hidden"
        >
          <div
            className="border-t border-og-border/50"
            style={{
              paddingInline: "var(--og-morph-panel-pad-x)",
              paddingBlock: "var(--og-morph-panel-pad-y)",
            }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {active ? (
                <motion.div
                  key={active}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -2 }}
                  transition={{ duration: duration ?? 0.16, ease }}
                >
                  {active === "incoming" ? (
                    <IncomingPanel
                      inputs={incoming}
                      onDismiss={onDismissIncoming}
                    />
                  ) : null}
                  {active === "queue" ? (
                    <QueuePanel
                      turns={turns}
                      readOnly={!canMutateQueue}
                      mutationFor={queue.mutationFor}
                      onEdit={
                        canMutateQueue && composer
                          ? (turn) => {
                              requestQueueDraftEdit(
                                composer,
                                () => {
                                  void queue.editTurn(turn.id, {
                                    expectedDraftRevision: composer.draftRevision,
                                    replaceDraft: true,
                                  });
                                },
                                () => {
                                  void queue.editTurn(turn.id, {
                                    expectedDraftRevision: composer.draftRevision,
                                    replaceDraft: true,
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
                  ) : null}
                  {active === "goal" && record && goalState && goal ? (
                    <GoalPanel goal={goal} state={goalState} elapsed={elapsed} readOnly={readOnly} />
                  ) : null}
                  {active === "agents" ? (
                    <div data-og-morph-panel="agents">
                      {agentsPanel ?? (
                        <p className="text-og-xs text-og-fg-muted">No agent details.</p>
                      )}
                    </div>
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </div>
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
    <ul className="flex flex-col gap-0.5" aria-label="Incoming updates" data-og-morph-panel="incoming">
      {inputs.map((input) => (
        <li
          key={input.id}
          className="group flex items-start gap-1.5 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--og-morph-row-hover)]"
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
  readOnly,
  mutationFor,
  onEdit,
  onSteer,
  onRemove,
  onMove,
}: {
  turns: SessionTurn[];
  readOnly: boolean;
  mutationFor: UseTurnQueueResult["mutationFor"];
  onEdit?: ((turn: SessionTurn) => void) | undefined;
  onSteer?: ((turnId: string) => void) | undefined;
  onRemove?: ((turnId: string) => void) | undefined;
  onMove?: ((turnId: string, beforeTurnId: string | null) => void) | undefined;
}) {
  return (
    <ol className="flex flex-col gap-0.5" aria-label="Queued prompts" data-og-morph-panel="queue">
      {turns.map((turn, index) => {
        const pending = mutationFor(turn.id);
        const beforeUp = index > 0 ? turns[index - 1]?.id ?? null : null;
        const beforeDown = index < turns.length - 1 ? (turns[index + 2]?.id ?? null) : null;
        const showActions = !readOnly && (onEdit || onSteer || onRemove || onMove);
        return (
          <li
            key={turn.id}
            data-queue-turn-id={turn.id}
            className="group flex items-start gap-1.5 rounded-og-sm px-1.5 py-1 transition-colors hover:bg-[var(--og-morph-row-hover)]"
          >
            <span className="mt-px shrink-0 font-og-mono text-[10px] leading-4 text-og-fg-subtle">
              {index + 1}
            </span>
            <p className="min-w-0 flex-1 truncate text-og-xs leading-4 text-og-fg" title={turn.prompt}>
              {turn.prompt}
            </p>
            {showActions ? (
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
                {onMove && turns.length > 1 ? (
                  <>
                    <IconAction
                      label={`Move queued prompt ${index + 1} up`}
                      disabled={pending !== null || index === 0}
                      onClick={() => onMove(turn.id, beforeUp)}
                    >
                      <ArrowUpIcon className="size-3" />
                    </IconAction>
                    <IconAction
                      label={`Move queued prompt ${index + 1} down`}
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
    <div className="space-y-1.5" data-og-morph-panel="goal">
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
                    : goal.pause("Paused from Morph chrome"))
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

function IconAction({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
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
  );
}
