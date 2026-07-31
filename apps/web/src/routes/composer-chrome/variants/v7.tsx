// 7 · Morph — merged session signals with shared-element motion above ChatComposer.
import { ChatComposer, type ComposerState } from "@opengeni/react";
import type {
  ClientVoiceInputConfig,
  LineageNode,
  SessionPendingInputPreview,
  SessionTurn,
} from "@opengeni/sdk";
import {
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
  id: 7,
  name: "Morph",
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
          One glass dock merges incoming, queue, goal, and agents. A shared highlight morphs under
          the active signal; the panel liquid-expands with actions a click away. ChatComposer stays
          production.
        </p>
        <ScenarioFilter scenarios={scenarios} filter={filter} onChange={setFilter} />
      </header>
      <div className="flex flex-col gap-10">
        {visible.map((scenario, index) => (
          <section
            key={scenario.id}
            aria-labelledby={`v7-scenario-${scenario.id}`}
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
              <h2 id={`v7-scenario-${scenario.id}`} className="text-sm font-semibold text-fg">
                {scenario.title}
              </h2>
              <p className="text-xs text-fg-muted">{scenario.description}</p>
            </header>
            <div className="p-3 sm:p-4">
              <MorphStack scenario={scenario} composer={composer} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function MorphStack({
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
      data-variant="morph"
    >
      <MorphDock scenario={scenario} composer={composer} />
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

function MorphDock({
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
      detail?: string;
      tone: "neutral" | "brand" | "waiting" | "running";
      icon: ReactNode;
    }> = [];
    if (incoming > 0) {
      rows.push({
        id: "incoming",
        label: `${incoming} in`,
        detail: queue.pendingInputs[0]?.summary,
        tone: queue.pendingInputs.some((item) => item.classification === "action_required")
          ? "waiting"
          : "neutral",
        icon: <InboxIcon className="size-3.5" />,
      });
    }
    if (queued > 0) {
      rows.push({
        id: "queue",
        label: `${queued} queued`,
        detail: queue.queue[0]?.prompt,
        tone: "neutral",
        icon: <ListOrderedIcon className="size-3.5" />,
      });
    }
    if (record && goalState) {
      const waiting = goalState === "blocked" || goalState === "held" || goalState === "paused";
      rows.push({
        id: "goal",
        label: GOAL_LABEL[goalState],
        detail: elapsed ? `${elapsed} · ${record.text}` : record.text,
        tone: waiting ? "waiting" : goalState === "pursuing" || goalState === "scheduled" ? "brand" : "neutral",
        icon:
          goalState === "blocked" || goalState === "invariant_broken" ? (
            <TriangleAlertIcon className="size-3.5" />
          ) : goalState === "paused" || goalState === "held" ? (
            <PauseIcon className="size-3.5" />
          ) : (
            <ZapIcon className="size-3.5" />
          ),
      });
    }
    if (agents.length > 0) {
      rows.push({
        id: "agents",
        label: `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        detail:
          runningAgents > 0
            ? `${runningAgents} running`
            : pausedAgents > 0
              ? `${pausedAgents} paused`
              : "Idle",
        tone: runningAgents > 0 ? "running" : pausedAgents > 0 ? "waiting" : "neutral",
        icon: <BotIcon className="size-3.5" />,
      });
    }
    return rows;
  }, [
    agents.length,
    elapsed,
    goalState,
    incoming,
    pausedAgents,
    queue.pendingInputs,
    queue.queue,
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
    <div className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6">
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border border-white/10",
          "bg-surface-2/55 shadow-[0_8px_32px_-16px_rgba(0,0,0,0.45)] backdrop-blur-xl",
          "supports-[backdrop-filter]:bg-surface-2/40",
          "ring-1 ring-inset ring-white/5",
          "transition-[box-shadow,border-color] duration-300 ease-out",
          open && "border-border-strong/50 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.55)]",
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent"
        />

        <div ref={railRef} className="relative flex flex-wrap items-stretch gap-0.5 p-1">
          <div
            aria-hidden
            className="pointer-events-none absolute top-1 bottom-1 rounded-xl bg-bg/70 shadow-sm ring-1 ring-border/60 transition-[transform,width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
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
                aria-controls={`v7-morph-panel-${scenario.id}`}
                onClick={() => setActive((prev) => (prev === signal.id ? null : signal.id))}
                className={cn(
                  "group relative z-[1] inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs outline-none",
                  "transition-[color,transform,background-color] duration-200 ease-out",
                  "hover:-translate-y-px hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40",
                  "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                  "pointer-coarse:min-h-11",
                  selected ? "text-fg" : "text-fg-muted",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 transition-colors duration-200",
                    signal.tone === "brand" && "text-brand",
                    signal.tone === "waiting" && "text-status-waiting",
                    signal.tone === "running" && "text-status-running",
                    signal.tone === "neutral" && (selected ? "text-fg" : "text-fg-subtle"),
                  )}
                >
                  {signal.icon}
                </span>
                <span className="shrink-0 font-medium">{signal.label}</span>
                {signal.detail ? (
                  <>
                    <span aria-hidden className="shrink-0 text-fg-subtle/70">
                      ·
                    </span>
                    <span className="min-w-0 max-w-[10rem] truncate text-fg-muted group-hover:text-fg-muted sm:max-w-[14rem]">
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
              className="relative z-[1] ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-xl text-fg-subtle outline-none transition-colors hover:bg-surface-3/70 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div
          id={`v7-morph-panel-${scenario.id}`}
          className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={panelStyle}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                "border-t border-border/60 px-3 pb-3 pt-2",
                "transition-[opacity,transform] duration-300 ease-out",
                open
                  ? "translate-y-0 opacity-100"
                  : "translate-y-1 opacity-0 motion-reduce:translate-y-0",
              )}
            >
              {active === "incoming" ? (
                <IncomingPanel inputs={queue.pendingInputs} />
              ) : null}
              {active === "queue" ? (
                <QueuePanel
                  turns={queue.queue}
                  onRemove={(turnId) => void queue.removeTurn(turnId)}
                  onEdit={(turn) => {
                    void queue.editTurn(turn.id, {
                      expectedDraftRevision: composer.draftRevision,
                      replaceDraft: true,
                    });
                  }}
                />
              ) : null}
              {active === "goal" && record && goalState ? (
                <GoalPanel
                  goal={goal}
                  state={goalState}
                  elapsed={elapsed}
                />
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
    <ul className="flex flex-col gap-1" aria-label="Incoming updates">
      {inputs.map((input) => (
        <li
          key={input.id}
          className="group flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-3/50"
        >
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium",
              input.classification === "action_required" || input.classification === "failure"
                ? "bg-status-waiting/15 text-status-waiting"
                : "bg-surface-3 text-fg-muted",
            )}
          >
            {pendingKindLabel(input.kind)}
          </span>
          <p className="min-w-0 flex-1 text-xs leading-5 text-fg">{input.summary}</p>
        </li>
      ))}
    </ul>
  );
}

function QueuePanel({
  turns,
  onRemove,
  onEdit,
}: {
  turns: SessionTurn[];
  onRemove: (turnId: string) => void;
  onEdit: (turn: SessionTurn) => void;
}) {
  return (
    <ol className="flex flex-col gap-1" aria-label="Queued prompts">
      {turns.map((turn, index) => (
        <li
          key={turn.id}
          className="group flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-3/50"
        >
          <span className="mt-0.5 shrink-0 font-mono text-2xs text-fg-subtle">{index + 1}</span>
          <p className="min-w-0 flex-1 truncate text-xs leading-5 text-fg" title={turn.prompt}>
            {turn.prompt}
          </p>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              aria-label={`Edit queued prompt ${index + 1}`}
              onClick={() => onEdit(turn)}
              className="inline-flex size-7 items-center justify-center rounded-md text-fg-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <PencilIcon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Remove queued prompt ${index + 1}`}
              onClick={() => onRemove(turn.id)}
              className="inline-flex size-7 items-center justify-center rounded-md text-fg-subtle outline-none hover:bg-surface-2 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Trash2Icon className="size-3.5" />
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
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
        <span>{GOAL_LABEL[state]}</span>
        {elapsed ? <span className="tabular-nums text-fg-muted normal-case tracking-normal">· {elapsed}</span> : null}
        <span className="normal-case tracking-normal text-fg-muted">· v{record.version}</span>
      </div>
      <p className="text-sm leading-6 text-fg">{record.text}</p>
      {record.successCriteria ? (
        <p className="text-xs leading-5 text-fg-muted">
          <span className="font-medium text-fg">Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {record.continuation?.lastError ? (
        <Notice tone="waiting" title="Continuation note">
          {record.continuation.lastError}
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <div className="flex flex-wrap gap-1.5 text-2xs text-fg-muted">
          <span className="rounded-md bg-surface-3/70 px-1.5 py-0.5">
            {record.autoContinuations} auto-continues
          </span>
          <span className="rounded-md bg-surface-3/70 px-1.5 py-0.5">
            {record.noProgressStreak} stalled
          </span>
        </div>
        <div className="flex items-center gap-1">
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
      <p className="mb-2 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
        {nodes.length} agent{nodes.length === 1 ? "" : "s"}
      </p>
      <SubagentTree workspaceId={workspaceId} nodes={nodes} />
    </div>
  );
}
