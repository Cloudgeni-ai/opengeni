// 3 · Rivet — Morph-family compact dock: quiet signal seam, liquid expand, hover actions.
// No SDK Morph export yet — gallery-local Morph variant. ChatComposer stays production.
import { ChatComposer, type ComposerState } from "@opengeni/react";
import type {
  ClientVoiceInputConfig,
  LineageNode,
  SessionPendingInputPreview,
  SessionTurn,
} from "@opengeni/sdk";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  GripVerticalIcon,
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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { goalPillState, type GoalPillState } from "@/components/session/goal-surface";
import { SubagentTree } from "@/components/session/subagents";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  emptyAttachments,
  galleryFirstPartyTools,
  galleryModelRows,
  galleryToolSelection,
  galleryToolServers,
  GALLERY_WORKSPACE_ID,
  idleComposer,
  type ChromeScenario,
  type ChromeScenarioId,
} from "@/dev/composer-chrome-fixtures";
import type { IntelligenceEffort } from "@/lib/session-tools";
import { cn } from "@/lib/utils";

import { ScenarioFilter, useGalleryScenarios } from "../scenario-matrix";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 3,
  name: "Rivet",
};

const VOICE_CAPABILITY: ClientVoiceInputConfig = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
};

const fixtureClient = {
  async transcribeAudio(): Promise<{ text: string; languages: string[] }> {
    return { text: "", languages: [] };
  },
};

type SignalId = "incoming" | "queue" | "goal" | "agents";

const GOAL_LABEL: Record<GoalPillState, string> = {
  pursuing: "Pursuing",
  scheduled: "Scheduled",
  blocked: "Blocked",
  held: "Held",
  paused: "Paused",
  invariant_broken: "Needs attention",
  completed: "Done",
};

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

export function Variant() {
  const composer = useMemo(() => idleComposer(), []);
  const scenarios = useGalleryScenarios();
  const [filter, setFilter] = useState<"all" | ChromeScenarioId>("all");
  const visible = filter === "all" ? scenarios : scenarios.filter((row) => row.id === filter);

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        <p className="text-sm leading-relaxed text-fg-muted">
          Morph-family seam: incoming · queue · goal · agents share one compact pill rail. The
          highlight morphs under the active signal; the panel liquid-expands at dense type. Queue
          actions appear on hover. ChatComposer stays production.
        </p>
        <ScenarioFilter scenarios={scenarios} filter={filter} onChange={setFilter} />
      </header>
      <div className="flex flex-col gap-10">
        {visible.map((scenario, index) => (
          <section
            key={scenario.id}
            aria-labelledby={`v3-scenario-${scenario.id}`}
            className="overflow-hidden rounded-xl border border-border bg-surface/30"
          >
            <header className="space-y-1 border-b border-border bg-surface-2/50 px-4 py-3 sm:px-5">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
                Scenario {index + 1}
                <span className="mx-1.5 text-border">·</span>
                <span className="font-mono normal-case tracking-normal text-fg-muted">
                  {scenario.id}
                </span>
              </p>
              <h2 id={`v3-scenario-${scenario.id}`} className="text-sm font-semibold text-fg">
                {scenario.title}
              </h2>
              <p className="text-xs text-fg-muted">{scenario.description}</p>
            </header>
            <div className="p-3 sm:p-4">
              <SeamStack scenario={scenario} composer={composer} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SeamStack({
  scenario,
  composer,
}: {
  scenario: ChromeScenario;
  composer: ComposerState;
}) {
  const [model, setModel] = useState("gpt-5.6-sol");
  const [effort, setEffort] = useState<IntelligenceEffort>("medium");
  const [toolSelection, setToolSelection] = useState(galleryToolSelection);
  const attachments = useMemo(() => emptyAttachments(), []);

  return (
    <div
      className="flex flex-col justify-end rounded-xl border border-border bg-bg/40 pt-8"
      data-scenario={scenario.id}
      data-variant="seam"
    >
      <SeamDock scenario={scenario} composer={composer} />
      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <ChatComposer
            composer={composer}
            effectiveControl={scenario.session.effectiveControl}
            queuedAheadCount={scenario.queue.queue.length}
            placeholder="Send a follow-up…"
            attachments={attachments}
            transcription={{
              client: fixtureClient as never,
              workspaceId: GALLERY_WORKSPACE_ID,
              capability: VOICE_CAPABILITY,
              workspaceEnabled: true,
            }}
            controlsStart={
              <div className="flex min-w-0 items-center gap-1.5">
                <ModelPicker
                  rows={galleryModelRows}
                  model={model}
                  effort={effort}
                  onModelChange={setModel}
                  onEffortChange={setEffort}
                />
                <SessionToolPicker
                  servers={galleryToolServers}
                  firstPartyTools={galleryFirstPartyTools}
                  selection={toolSelection}
                  onChange={setToolSelection}
                />
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

function SeamDock({
  scenario,
  composer,
}: {
  scenario: ChromeScenario;
  composer: ComposerState;
}) {
  const queue = scenario.queue;
  const goal = scenario.goal;
  const record = goal.goal;
  const agents = scenario.agentNodes;
  const incoming = queue.pendingInputs.length;
  const queued = queue.queue.length;

  const liveGoal =
    record?.status === "active" &&
    record.continuation?.state === "running" &&
    record.continuation.reason === "goal_turn_running";
  const elapsed = useLiveElapsed(
    record?.createdAt,
    Boolean(liveGoal),
    !liveGoal ? record?.updatedAt : null,
  );
  const goalState = record ? goalPillState(record.status, record.continuation) : null;

  const runningAgents = agents.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const pausedAgents = agents.filter((node) => node.session.effectiveControl.state === "paused")
    .length;

  const signals = useMemo(() => {
    const rows: Array<{
      id: SignalId;
      label: string;
      tone: "neutral" | "brand" | "waiting" | "running";
      icon: ReactNode;
    }> = [];
    if (incoming > 0) {
      rows.push({
        id: "incoming",
        label: `${incoming}`,
        tone: queue.pendingInputs.some((item) => item.classification === "action_required")
          ? "waiting"
          : "neutral",
        icon: <InboxIcon className="size-3" />,
      });
    }
    if (queued > 0) {
      rows.push({
        id: "queue",
        label: `${queued}`,
        tone: "neutral",
        icon: <ListOrderedIcon className="size-3" />,
      });
    }
    if (record && goalState) {
      const waiting = goalState === "blocked" || goalState === "held" || goalState === "paused";
      rows.push({
        id: "goal",
        label: GOAL_LABEL[goalState],
        tone: waiting
          ? "waiting"
          : goalState === "pursuing" || goalState === "scheduled"
            ? "brand"
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
    if (agents.length > 0) {
      rows.push({
        id: "agents",
        label: `${agents.length}`,
        tone: runningAgents > 0 ? "running" : pausedAgents > 0 ? "waiting" : "neutral",
        icon: <BotIcon className="size-3" />,
      });
    }
    return rows;
  }, [
    agents.length,
    goalState,
    incoming,
    pausedAgents,
    queue.pendingInputs,
    queued,
    record,
    runningAgents,
  ]);

  const [active, setActive] = useState<SignalId | null>(null);
  const chipRefs = useRef<Partial<Record<SignalId, HTMLButtonElement | null>>>({});
  const railRef = useRef<HTMLDivElement | null>(null);
  const [pill, setPill] = useState({ left: 0, width: 0, opacity: 0 });

  useEffect(() => {
    if (active && !signals.some((signal) => signal.id === active)) {
      setActive(null);
    }
  }, [active, signals]);

  useEffect(() => {
    const rail = railRef.current;
    const measure = () => {
      if (!rail || !active) {
        setPill((prev) => ({ ...prev, opacity: 0 }));
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

  if (signals.length === 0) {
    return null;
  }

  const open = active !== null;
  const panelStyle = {
    gridTemplateRows: open ? "1fr" : "0fr",
  } satisfies CSSProperties;

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl shrink-0 px-4 sm:px-6">
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-border/70",
          "bg-surface-2/45 shadow-[0_4px_20px_-14px_rgba(0,0,0,0.4)] backdrop-blur-md",
          "supports-[backdrop-filter]:bg-surface-2/30",
          "ring-1 ring-inset ring-white/[0.04]",
          "transition-[box-shadow,border-color] duration-300 ease-out",
          open && "border-border/90 shadow-[0_8px_28px_-18px_rgba(0,0,0,0.5)]",
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
        />

        <div ref={railRef} className="relative flex flex-wrap items-stretch gap-0.5 p-0.5">
          <div
            aria-hidden
            className="pointer-events-none absolute top-0.5 bottom-0.5 rounded-lg bg-bg/65 shadow-sm ring-1 ring-border/50 transition-[transform,width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{
              width: pill.width,
              opacity: pill.opacity,
              transform: `translate3d(${pill.left}px, 0, 0)`,
            }}
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
                aria-controls={`v3-seam-panel-${scenario.id}`}
                onClick={() => setActive((prev) => (prev === signal.id ? null : signal.id))}
                className={cn(
                  "group relative z-[1] inline-flex min-h-7 min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-left text-2xs outline-none",
                  "transition-[color,transform] duration-200 ease-out",
                  "hover:-translate-y-px hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40",
                  "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                  "pointer-coarse:min-h-11",
                  selected ? "text-fg" : "text-fg-muted",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 transition-colors duration-200",
                    signal.tone === "brand" && "text-brand/80",
                    signal.tone === "waiting" && "text-status-waiting",
                    signal.tone === "running" && "text-status-running",
                    signal.tone === "neutral" && (selected ? "text-fg" : "text-fg-subtle"),
                  )}
                >
                  {signal.icon}
                </span>
                <span className="shrink-0 font-medium tabular-nums">{signal.label}</span>
              </button>
            );
          })}
          {open ? (
            <button
              type="button"
              aria-label="Close session chrome panel"
              onClick={() => setActive(null)}
              className="relative z-[1] ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle outline-none transition-colors hover:bg-surface-3/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>

        <div
          id={`v3-seam-panel-${scenario.id}`}
          className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={panelStyle}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                "border-t border-border/50 px-2 pb-2 pt-1.5",
                "transition-[opacity,transform] duration-300 ease-out",
                open
                  ? "translate-y-0 opacity-100"
                  : "translate-y-0.5 opacity-0 motion-reduce:translate-y-0",
              )}
            >
              {active === "incoming" ? (
                <IncomingPanel inputs={queue.pendingInputs} />
              ) : null}
              {active === "queue" ? (
                <QueuePanel
                  turns={queue.queue}
                  onRemove={(turnId) => void queue.removeTurn(turnId)}
                  onSteer={(turnId) => void queue.steerTurn(turnId)}
                  onMove={(turnId, beforeTurnId) => void queue.moveTurn(turnId, beforeTurnId)}
                  onEdit={(turn) => {
                    void queue.editTurn(turn.id, {
                      expectedDraftRevision: composer.draftRevision,
                      replaceDraft: true,
                    });
                  }}
                />
              ) : null}
              {active === "goal" && record && goalState ? (
                <GoalPanel goal={goal} state={goalState} elapsed={elapsed} />
              ) : null}
              {active === "agents" ? (
                <AgentsPanel workspaceId={GALLERY_WORKSPACE_ID} nodes={agents} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function IncomingPanel({ inputs }: { inputs: SessionPendingInputPreview[] }) {
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Incoming updates">
      {inputs.map((input) => (
        <li
          key={input.id}
          className="group flex items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-3/45"
        >
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded px-1 py-px text-[10px] font-medium leading-4",
              input.classification === "action_required" || input.classification === "failure"
                ? "bg-status-waiting/12 text-status-waiting"
                : "bg-surface-3 text-fg-muted",
            )}
          >
            {pendingKindLabel(input.kind)}
          </span>
          <p className="min-w-0 flex-1 text-2xs leading-4 text-fg">{input.summary}</p>
          {/* Machine inputs have no product delete/edit — hover shows read-only affordance. */}
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <span className="rounded px-1 py-0.5 text-[10px] text-fg-subtle">Queued for model</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function QueuePanel({
  turns,
  onRemove,
  onEdit,
  onSteer,
  onMove,
}: {
  turns: SessionTurn[];
  onRemove: (turnId: string) => void;
  onEdit: (turn: SessionTurn) => void;
  onSteer: (turnId: string) => void;
  onMove: (turnId: string, beforeTurnId: string | null) => void;
}) {
  const moveToIndex = (turnId: string, fromIndex: number, nextIndex: number) => {
    if (fromIndex === nextIndex) return;
    const ordered = turns.slice();
    const [item] = ordered.splice(fromIndex, 1);
    if (!item) return;
    ordered.splice(nextIndex, 0, item);
    const beforeTurnId = ordered[nextIndex + 1]?.id ?? null;
    onMove(turnId, beforeTurnId);
  };

  return (
    <ol className="flex flex-col gap-0.5" aria-label="Queued prompts">
      {turns.map((turn, index) => (
        <li
          key={turn.id}
          className="group flex items-start gap-1 rounded-md px-1 py-1 transition-colors hover:bg-surface-3/45"
        >
          <span
            className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-fg-subtle opacity-40 group-hover:opacity-80"
            aria-hidden
          >
            <GripVerticalIcon className="size-3" />
          </span>
          <span className="mt-0.5 w-3 shrink-0 font-mono text-[10px] text-fg-subtle">
            {index + 1}
          </span>
          <p className="min-w-0 flex-1 truncate text-2xs leading-4 text-fg" title={turn.prompt}>
            {turn.prompt}
          </p>
          <div className="flex shrink-0 items-center gap-px opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              aria-label={`Move queued prompt ${index + 1} up`}
              disabled={index === 0}
              onClick={() => moveToIndex(turn.id, index, index - 1)}
              className="inline-flex size-6 items-center justify-center rounded text-fg-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-30"
            >
              <ArrowUpIcon className="size-3" />
            </button>
            <button
              type="button"
              aria-label={`Move queued prompt ${index + 1} down`}
              disabled={index === turns.length - 1}
              onClick={() => moveToIndex(turn.id, index, index + 1)}
              className="inline-flex size-6 items-center justify-center rounded text-fg-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-30"
            >
              <ArrowDownIcon className="size-3" />
            </button>
            <button
              type="button"
              aria-label={`Steer queued prompt ${index + 1}`}
              title="Make this the next direction"
              onClick={() => onSteer(turn.id)}
              className="inline-flex size-6 items-center justify-center rounded text-fg-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ZapIcon className="size-3" />
            </button>
            <button
              type="button"
              aria-label={`Edit queued prompt ${index + 1}`}
              onClick={() => onEdit(turn)}
              className="inline-flex size-6 items-center justify-center rounded text-fg-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <PencilIcon className="size-3" />
            </button>
            <button
              type="button"
              aria-label={`Remove queued prompt ${index + 1}`}
              onClick={() => onRemove(turn.id)}
              className="inline-flex size-6 items-center justify-center rounded text-fg-subtle outline-none hover:bg-surface-2 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Trash2Icon className="size-3" />
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}

function GoalPanel({
  goal,
  state,
  elapsed,
}: {
  goal: ChromeScenario["goal"];
  state: GoalPillState;
  elapsed: string | null;
}) {
  const record = goal.goal;
  if (!record) return null;
  const canToggle = record.status === "active" || record.status === "paused";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        <span>{GOAL_LABEL[state]}</span>
        {elapsed ? (
          <span className="tabular-nums text-fg-muted normal-case tracking-normal">· {elapsed}</span>
        ) : null}
        <span className="normal-case tracking-normal text-fg-muted">· v{record.version}</span>
      </div>
      <p className="text-xs leading-5 text-fg">{record.text}</p>
      {record.successCriteria ? (
        <p className="text-2xs leading-4 text-fg-muted">
          <span className="font-medium text-fg">Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {record.continuation?.lastError ? (
        <Notice tone="waiting" title="Continuation note">
          {record.continuation.lastError}
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5">
        <div className="flex flex-wrap gap-1 text-[10px] text-fg-muted">
          <span className="rounded bg-surface-3/60 px-1 py-px">
            {record.autoContinuations} auto
          </span>
          <span className="rounded bg-surface-3/60 px-1 py-px">
            {record.noProgressStreak} stalled
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {canToggle ? (
            <Button
              type="button"
              size="xs"
              variant={record.status === "paused" ? "default" : "ghost"}
              disabled={goal.updating}
              onClick={() =>
                void (record.status === "paused"
                  ? goal.resume()
                  : goal.pause("Paused from the console"))
              }
            >
              {goal.updating ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : record.status === "paused" ? (
                <PlayIcon className="size-3" />
              ) : (
                <PauseIcon className="size-3" />
              )}
              {record.status === "paused" ? "Resume" : "Pause"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-fg-subtle hover:text-destructive"
            disabled={goal.updating}
            onClick={() => void goal.deleteGoal()}
          >
            <Trash2Icon className="size-3" />
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

function AgentsPanel({ workspaceId, nodes }: { workspaceId: string; nodes: LineageNode[] }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        {nodes.length} agent{nodes.length === 1 ? "" : "s"}
      </p>
      <SubagentTree workspaceId={workspaceId} nodes={nodes} />
    </div>
  );
}
