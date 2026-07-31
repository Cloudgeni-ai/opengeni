// 10 · Silk — quiet liquid-glass status ribbon above the fixed ChatComposer.
// Thesis: merge queue / incoming / goal / agents into one compact glass bar;
// silk-smooth expand + hover, never theatrical CRT/sonar instrument theater.
import { ChatComposer, type ComposerState, type UseGoalResult } from "@opengeni/react";
import type {
  ClientVoiceInputConfig,
  LineageNode,
  SessionPendingInputPreview,
  SessionTurn,
} from "@opengeni/sdk";
import {
  BotIcon,
  ChevronDownIcon,
  InboxIcon,
  ListOrderedIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { goalPillState, type GoalPillState } from "@/components/session/goal-surface";
import {
  chromeScenarios,
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

import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 10,
  name: "Silk",
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

type PanelKey = "queue" | "goal" | "agents" | null;

/* --- helpers -------------------------------------------------------------- */

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
): string | null {
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

const GOAL_LABEL: Record<GoalPillState, string> = {
  pursuing: "Pursuing",
  scheduled: "Scheduled",
  blocked: "Blocked",
  held: "Held",
  paused: "Paused",
  invariant_broken: "Needs attention",
  completed: "Completed",
};

function goalTone(state: GoalPillState): "live" | "wait" | "calm" | "warn" {
  if (state === "pursuing" || state === "scheduled") return "live";
  if (state === "blocked" || state === "held" || state === "paused") return "wait";
  if (state === "invariant_broken") return "warn";
  return "calm";
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function agentTitle(node: LineageNode): string {
  const title = node.session.title?.trim();
  if (title) return title;
  const meta = node.session.metadata?.title;
  return typeof meta === "string" && meta.trim() ? meta.trim() : "Agent";
}

function agentState(node: LineageNode): "running" | "paused" | "idle" {
  if (node.session.effectiveControl.state === "paused") return "paused";
  if (node.session.status === "running" && node.session.effectiveControl.state === "active") {
    return "running";
  }
  return "idle";
}

function incomingTone(
  classification: SessionPendingInputPreview["classification"],
): "wait" | "warn" | "calm" {
  if (classification === "failure") return "warn";
  if (classification === "action_required") return "wait";
  return "calm";
}

/* --- silk chrome ---------------------------------------------------------- */

function MetricChip({
  icon,
  label,
  active,
  tone = "calm",
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  tone?: "live" | "wait" | "warn" | "calm";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("v10-chip", `v10-tone-${tone}`, active && "is-active")}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="v10-chip-icon" aria-hidden>
        {icon}
      </span>
      <span className="v10-chip-label">{label}</span>
    </button>
  );
}

function SilkChrome({ scenario }: { scenario: ChromeScenario }) {
  const queue = scenario.queue.queue;
  const pending = scenario.queue.pendingInputs;
  const goal = scenario.goal;
  const record = goal.goal;
  const agents = scenario.agentNodes;

  const live =
    record?.status === "active" &&
    record.continuation?.state === "running" &&
    record.continuation.reason === "goal_turn_running";
  const elapsed = useLiveElapsed(
    record?.createdAt,
    Boolean(live),
    !live ? record?.updatedAt : null,
  );

  const goalState = record ? goalPillState(record.status, record.continuation) : null;
  const runningAgents = agents.filter((node) => agentState(node) === "running").length;
  const pausedAgents = agents.filter((node) => agentState(node) === "paused").length;

  const hasQueue = queue.length > 0 || pending.length > 0;
  const hasGoal = Boolean(record);
  const hasAgents = agents.length > 0;
  const hasChrome = hasQueue || hasGoal || hasAgents;

  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<PanelKey>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Reset expand state when the gallery scenario changes.
    setOpen(false);
    setPanel(null);
  }, [scenario.id]);

  if (!hasChrome) {
    return null;
  }

  const headline = record
    ? truncate(record.text, 72)
    : pending[0]?.summary
      ? truncate(pending[0].summary, 72)
      : queue[0]?.prompt
        ? truncate(queue[0].prompt, 72)
        : agents[0]
          ? truncate(agentTitle(agents[0]), 72)
          : "Session quiet";

  const statusLabel = goalState
    ? GOAL_LABEL[goalState]
    : pending.length > 0
      ? "Incoming"
      : queue.length > 0
        ? "Queued"
        : runningAgents > 0
          ? "Agents live"
          : "Ready";

  const statusTone = goalState
    ? goalTone(goalState)
    : pending.some((row) => row.classification === "action_required" || row.classification === "failure")
      ? "wait"
      : runningAgents > 0
        ? "live"
        : "calm";

  const openPanel = (next: PanelKey) => {
    if (open && panel === next) {
      setOpen(false);
      setPanel(null);
      return;
    }
    setPanel(next);
    setOpen(true);
  };

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      setPanel(null);
      return;
    }
    const preferred: PanelKey = hasGoal ? "goal" : hasQueue ? "queue" : hasAgents ? "agents" : null;
    setPanel(preferred);
    setOpen(true);
  };

  const onGoalToggle = async () => {
    if (!record || record.status === "completed" || busy) return;
    setBusy(true);
    try {
      if (record.status === "paused") {
        await goal.resume();
      } else {
        await goal.pause("Paused from the console");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v10-wrap" data-scenario={scenario.id}>
      <style>{SILK_CSS}</style>
      <div
        className={cn("v10-glass", open && "is-open", `v10-tone-${statusTone}`)}
        data-live={live || undefined}
      >
        <div className="v10-sheen" aria-hidden />
        <div className="v10-rim" aria-hidden />

        <div className="v10-bar">
          <button type="button" className="v10-lead" onClick={toggleOpen} aria-expanded={open}>
            <span className="v10-pulse" aria-hidden />
            <span className="v10-status">{statusLabel}</span>
            {elapsed ? <span className="v10-elapsed">{elapsed}</span> : null}
            <span className="v10-headline" title={headline}>
              {headline}
            </span>
          </button>

          <div className="v10-metrics">
            {pending.length > 0 ? (
              <MetricChip
                icon={<InboxIcon className="size-3" />}
                label={`${pending.length} in`}
                tone={
                  pending.some((row) => row.classification === "action_required")
                    ? "wait"
                    : pending.some((row) => row.classification === "failure")
                      ? "warn"
                      : "calm"
                }
                active={open && panel === "queue"}
                onClick={() => openPanel("queue")}
              />
            ) : null}
            {queue.length > 0 ? (
              <MetricChip
                icon={<ListOrderedIcon className="size-3" />}
                label={`${queue.length} q`}
                tone="calm"
                active={open && panel === "queue"}
                onClick={() => openPanel("queue")}
              />
            ) : null}
            {hasGoal ? (
              <MetricChip
                icon={
                  goalState === "blocked" || goalState === "invariant_broken" ? (
                    <TriangleAlertIcon className="size-3" />
                  ) : (
                    <SparklesIcon className="size-3" />
                  )
                }
                label={goalState ? GOAL_LABEL[goalState] : "Goal"}
                tone={goalState ? goalTone(goalState) : "calm"}
                active={open && panel === "goal"}
                onClick={() => openPanel("goal")}
              />
            ) : null}
            {hasAgents ? (
              <MetricChip
                icon={<BotIcon className="size-3" />}
                label={
                  runningAgents > 0
                    ? `${runningAgents} run`
                    : pausedAgents > 0
                      ? `${pausedAgents} pause`
                      : `${agents.length}`
                }
                tone={runningAgents > 0 ? "live" : pausedAgents > 0 ? "wait" : "calm"}
                active={open && panel === "agents"}
                onClick={() => openPanel("agents")}
              />
            ) : null}
          </div>

          <div className="v10-actions">
            {record && record.status !== "completed" ? (
              <button
                type="button"
                className="v10-icon-btn"
                aria-label={record.status === "paused" ? "Resume goal" : "Pause goal"}
                disabled={busy || goal.updating}
                onClick={() => void onGoalToggle()}
              >
                {busy || goal.updating ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : record.status === "paused" ? (
                  <PlayIcon className="size-3.5" />
                ) : (
                  <PauseIcon className="size-3.5" />
                )}
              </button>
            ) : null}
            <button
              type="button"
              className={cn("v10-icon-btn", open && "is-active")}
              aria-label={open ? "Collapse session chrome" : "Expand session chrome"}
              aria-expanded={open}
              onClick={toggleOpen}
            >
              <ChevronDownIcon className={cn("size-3.5 transition-transform duration-300", open && "rotate-180")} />
            </button>
          </div>
        </div>

        <div className={cn("v10-drawer", open && "is-open")} aria-hidden={!open}>
          <div className="v10-drawer-inner">
            {open && (panel === "goal" || panel === null) && record ? (
              <GoalPanel
                goal={goal}
                state={goalState!}
                elapsed={elapsed}
                onToggle={() => void onGoalToggle()}
                busy={busy}
              />
            ) : null}
            {open &&
            (panel === "queue" ||
              (panel === "goal" && hasQueue) ||
              (panel === null && !hasGoal && hasQueue)) ? (
              <QueuePanel
                queue={queue}
                pending={pending}
                onRemove={(id) => void scenario.queue.removeTurn(id)}
                compact={panel === "goal"}
              />
            ) : null}
            {open &&
            (panel === "agents" ||
              ((panel === "goal" || panel === "queue") && hasAgents) ||
              (panel === null && !hasGoal && !hasQueue && hasAgents)) ? (
              <AgentsPanel nodes={agents} compact={panel === "goal" || panel === "queue"} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function GoalPanel({
  goal,
  state,
  elapsed,
  onToggle,
  busy,
}: {
  goal: UseGoalResult;
  state: GoalPillState;
  elapsed: string | null;
  onToggle: () => void;
  busy: boolean;
}) {
  const record = goal.goal;
  if (!record) return null;
  return (
    <section className="v10-section" style={{ "--i": 0 } as CSSProperties}>
      <header className="v10-section-head">
        <span className={cn("v10-section-title", `v10-tone-${goalTone(state)}`)}>
          {GOAL_LABEL[state]}
        </span>
        {elapsed ? <span className="v10-section-meta">{elapsed}</span> : null}
        {record.status !== "completed" ? (
          <button
            type="button"
            className="v10-text-btn"
            disabled={busy || goal.updating}
            onClick={onToggle}
          >
            {record.status === "paused" ? "Resume" : "Pause"}
          </button>
        ) : null}
      </header>
      <p className="v10-section-body">{record.text}</p>
      {record.successCriteria ? (
        <p className="v10-section-soft">
          <span>Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {record.continuation?.lastError ? (
        <p className="v10-section-alert">{record.continuation.lastError}</p>
      ) : null}
      {record.status === "paused" && (record.pausedReason ?? record.rationale) ? (
        <p className="v10-section-soft">Paused because {record.pausedReason ?? record.rationale}</p>
      ) : null}
    </section>
  );
}

function QueuePanel({
  queue,
  pending,
  onRemove,
  compact = false,
}: {
  queue: SessionTurn[];
  pending: SessionPendingInputPreview[];
  onRemove: (id: string) => void;
  compact?: boolean;
}) {
  const max = compact ? 2 : 6;
  const pendingShown = pending.slice(0, max);
  const queueShown = queue.slice(0, Math.max(0, max - pendingShown.length));

  return (
    <section className="v10-section" style={{ "--i": 1 } as CSSProperties}>
      <header className="v10-section-head">
        <span className="v10-section-title">Waiting</span>
        <span className="v10-section-meta">
          {pending.length > 0 ? `${pending.length} incoming` : null}
          {pending.length > 0 && queue.length > 0 ? " · " : null}
          {queue.length > 0 ? `${queue.length} queued` : null}
        </span>
      </header>
      <ul className="v10-list">
        {pendingShown.map((input, index) => (
          <li
            key={input.id}
            className={cn("v10-row", `v10-tone-${incomingTone(input.classification)}`)}
            style={{ "--i": index } as CSSProperties}
          >
            <span className="v10-row-mark" aria-hidden />
            <span className="v10-row-kind">In</span>
            <span className="v10-row-text" title={input.summary}>
              {input.summary}
            </span>
          </li>
        ))}
        {queueShown.map((turn, index) => (
          <li
            key={turn.id}
            className="v10-row v10-tone-calm"
            style={{ "--i": pendingShown.length + index } as CSSProperties}
          >
            <span className="v10-row-mark" aria-hidden />
            <span className="v10-row-kind">Q{index + 1}</span>
            <span className="v10-row-text" title={turn.prompt}>
              {turn.prompt}
            </span>
            <button
              type="button"
              className="v10-row-action"
              aria-label={`Remove queued prompt ${index + 1}`}
              onClick={() => onRemove(turn.id)}
            >
              <XIcon className="size-3" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AgentsPanel({ nodes, compact = false }: { nodes: LineageNode[]; compact?: boolean }) {
  const shown = compact ? nodes.slice(0, 3) : nodes;
  return (
    <section className="v10-section" style={{ "--i": 2 } as CSSProperties}>
      <header className="v10-section-head">
        <span className="v10-section-title">Agents</span>
        <span className="v10-section-meta">
          {nodes.length} total
          {nodes.filter((n) => agentState(n) === "running").length > 0
            ? ` · ${nodes.filter((n) => agentState(n) === "running").length} running`
            : ""}
        </span>
      </header>
      <ul className="v10-agent-list">
        {shown.map((node, index) => {
          const state = agentState(node);
          return (
            <li
              key={node.session.id}
              className={cn("v10-agent", `is-${state}`)}
              style={{ "--i": index } as CSSProperties}
            >
              <span className="v10-agent-dot" aria-hidden />
              <span className="v10-agent-title" title={agentTitle(node)}>
                {agentTitle(node)}
              </span>
              <span className="v10-agent-state">
                {state === "running" ? "Running" : state === "paused" ? "Paused" : "Idle"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* --- production composer -------------------------------------------------- */

function GalleryComposer({
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
    <div className="shrink-0 px-4 pb-4 pt-1.5 sm:px-6">
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
  );
}

function SilkScenarioStack({
  scenario,
  composer,
}: {
  scenario: ChromeScenario;
  composer: ComposerState;
}) {
  return (
    <div
      className="flex flex-col justify-end rounded-xl border border-border/70 bg-bg/50 pt-8"
      data-scenario={scenario.id}
      data-variant="silk"
    >
      <SilkChrome scenario={scenario} />
      <GalleryComposer scenario={scenario} composer={composer} />
    </div>
  );
}

/* --- gallery variant ------------------------------------------------------ */

export function Variant() {
  const scenarios = useMemo(() => chromeScenarios(), []);
  const composer = useMemo(() => idleComposer(), []);
  const [filter, setFilter] = useState<"all" | ChromeScenarioId>("all");
  const visible = filter === "all" ? scenarios : scenarios.filter((row) => row.id === filter);

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        <p className="text-sm leading-relaxed text-fg-muted">
          <span className="font-medium text-fg">Silk</span> — one quiet liquid-glass ribbon merges
          queue, incoming, goal, and agents. Silk-smooth expand, easy pause/resume and peeks —
          compact, not theatrical. ChatComposer stays production.
        </p>
        <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span>Filter</span>
          <select
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-fg"
            value={filter}
            onChange={(event) => setFilter(event.target.value as "all" | ChromeScenarioId)}
          >
            <option value="all">All scenarios</option>
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.title}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="flex flex-col gap-10">
        {visible.map((scenario, index) => (
          <section
            key={scenario.id}
            aria-labelledby={`v10-scenario-${scenario.id}`}
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
              <h2 id={`v10-scenario-${scenario.id}`} className="text-sm font-semibold text-fg">
                {scenario.title}
              </h2>
              <p className="text-xs text-fg-muted">{scenario.description}</p>
            </header>
            <div className="p-3 sm:p-4">
              <SilkScenarioStack scenario={scenario} composer={composer} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/* --- scoped CSS ----------------------------------------------------------- */

const SILK_CSS = `
.v10-wrap {
  --v10-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --v10-glass: color-mix(in oklab, var(--color-surface-2, #1a1d24) 72%, transparent);
  --v10-line: color-mix(in oklab, white 12%, transparent);
  --v10-ink: var(--color-fg, #f4f5f7);
  --v10-muted: var(--color-fg-muted, #9aa3b2);
  --v10-live: color-mix(in oklab, var(--color-brand, #5ec2b0) 92%, white);
  --v10-wait: color-mix(in oklab, var(--color-status-waiting, #d4a15a) 92%, white);
  --v10-warn: color-mix(in oklab, #e07a5f 90%, white);
  --v10-calm: color-mix(in oklab, white 55%, transparent);
  margin: 0 auto 0.45rem;
  width: 100%;
  max-width: 48rem;
  padding: 0 1rem;
}
@media (min-width: 640px) {
  .v10-wrap { padding-left: 1.5rem; padding-right: 1.5rem; }
}
.v10-glass {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--v10-line);
  border-radius: 16px;
  background:
    linear-gradient(180deg, color-mix(in oklab, white 7%, transparent), transparent 42%),
    var(--v10-glass);
  backdrop-filter: blur(18px) saturate(1.25);
  -webkit-backdrop-filter: blur(18px) saturate(1.25);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, white 10%, transparent),
    0 10px 28px rgba(0, 0, 0, 0.22);
  transition:
    border-color 420ms var(--v10-ease),
    box-shadow 420ms var(--v10-ease),
    transform 420ms var(--v10-ease);
}
.v10-glass:hover {
  border-color: color-mix(in oklab, white 18%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, white 12%, transparent),
    0 14px 34px rgba(0, 0, 0, 0.28);
}
.v10-glass.is-open {
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, white 12%, transparent),
    0 18px 40px rgba(0, 0, 0, 0.3);
}
.v10-sheen {
  pointer-events: none;
  position: absolute;
  inset: -40% -20%;
  background: linear-gradient(
    115deg,
    transparent 30%,
    color-mix(in oklab, white 10%, transparent) 48%,
    transparent 62%
  );
  transform: translateX(-18%);
  animation: v10-sheen 7.5s var(--v10-ease) infinite;
  opacity: 0.55;
}
.v10-rim {
  pointer-events: none;
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px color-mix(in oklab, white 4%, transparent);
}
.v10-glass.v10-tone-live { border-color: color-mix(in oklab, var(--v10-live) 35%, var(--v10-line)); }
.v10-glass.v10-tone-wait { border-color: color-mix(in oklab, var(--v10-wait) 35%, var(--v10-line)); }
.v10-glass.v10-tone-warn { border-color: color-mix(in oklab, var(--v10-warn) 40%, var(--v10-line)); }
.v10-glass[data-live="true"] .v10-pulse {
  background: var(--v10-live);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--v10-live) 18%, transparent);
  animation: v10-breathe 2.4s var(--v10-ease) infinite;
}
.v10-bar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2.25rem;
  padding: 0.3rem 0.4rem 0.3rem 0.65rem;
}
.v10-lead {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 0.45rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: 999px;
  padding: 0.15rem 0.25rem;
  transition: background 280ms var(--v10-ease);
}
.v10-lead:hover { background: color-mix(in oklab, white 4%, transparent); }
.v10-pulse {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: var(--v10-calm);
  flex-shrink: 0;
  transition: background 320ms var(--v10-ease), box-shadow 320ms var(--v10-ease);
}
.v10-tone-live .v10-pulse { background: var(--v10-live); }
.v10-tone-wait .v10-pulse { background: var(--v10-wait); }
.v10-tone-warn .v10-pulse { background: var(--v10-warn); }
.v10-status {
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--v10-ink);
}
.v10-tone-live .v10-status { color: var(--v10-live); }
.v10-tone-wait .v10-status { color: var(--v10-wait); }
.v10-tone-warn .v10-status { color: var(--v10-warn); }
.v10-elapsed {
  flex-shrink: 0;
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
  color: var(--v10-muted);
  padding: 0.1rem 0.35rem;
  border-radius: 999px;
  background: color-mix(in oklab, white 5%, transparent);
}
.v10-headline {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  color: var(--v10-muted);
}
.v10-metrics {
  display: none;
  flex-shrink: 0;
  align-items: center;
  gap: 0.3rem;
}
@media (min-width: 560px) {
  .v10-metrics { display: inline-flex; }
}
.v10-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  height: 1.55rem;
  padding: 0 0.5rem;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, white 8%, transparent);
  background: color-mix(in oklab, white 4%, transparent);
  color: var(--v10-muted);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition:
    transform 280ms var(--v10-ease),
    background 280ms var(--v10-ease),
    border-color 280ms var(--v10-ease),
    color 280ms var(--v10-ease);
}
.v10-chip:hover {
  transform: translateY(-1px);
  background: color-mix(in oklab, white 8%, transparent);
  color: var(--v10-ink);
  border-color: color-mix(in oklab, white 16%, transparent);
}
.v10-chip.is-active {
  background: color-mix(in oklab, white 10%, transparent);
  color: var(--v10-ink);
  border-color: color-mix(in oklab, white 20%, transparent);
}
.v10-chip.v10-tone-live { color: var(--v10-live); border-color: color-mix(in oklab, var(--v10-live) 28%, transparent); }
.v10-chip.v10-tone-wait { color: var(--v10-wait); border-color: color-mix(in oklab, var(--v10-wait) 28%, transparent); }
.v10-chip.v10-tone-warn { color: var(--v10-warn); border-color: color-mix(in oklab, var(--v10-warn) 28%, transparent); }
.v10-chip-icon { display: inline-flex; opacity: 0.9; }
.v10-actions {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.15rem;
}
.v10-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.7rem;
  height: 1.7rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--v10-muted);
  cursor: pointer;
  transition:
    background 240ms var(--v10-ease),
    color 240ms var(--v10-ease),
    transform 240ms var(--v10-ease);
}
.v10-icon-btn:hover:not(:disabled) {
  background: color-mix(in oklab, white 8%, transparent);
  color: var(--v10-ink);
  transform: translateY(-1px);
}
.v10-icon-btn:disabled { opacity: 0.55; cursor: default; }
.v10-icon-btn.is-active {
  background: color-mix(in oklab, white 8%, transparent);
  color: var(--v10-ink);
}
.v10-drawer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 420ms var(--v10-ease);
}
.v10-drawer.is-open { grid-template-rows: 1fr; }
.v10-drawer-inner {
  overflow: hidden;
  min-height: 0;
  border-top: 1px solid transparent;
  transition: border-color 320ms var(--v10-ease);
}
.v10-drawer.is-open .v10-drawer-inner {
  border-top-color: color-mix(in oklab, white 8%, transparent);
  padding: 0.55rem 0.65rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.v10-section {
  opacity: 0;
  transform: translateY(6px);
  animation: v10-rise 420ms var(--v10-ease) both;
  animation-delay: calc(var(--i, 0) * 55ms);
}
.v10-drawer.is-open .v10-section { opacity: 1; }
.v10-section-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 0.3rem;
}
.v10-section-title {
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--v10-muted);
}
.v10-section-title.v10-tone-live { color: var(--v10-live); }
.v10-section-title.v10-tone-wait { color: var(--v10-wait); }
.v10-section-title.v10-tone-warn { color: var(--v10-warn); }
.v10-section-meta {
  font-size: 0.625rem;
  color: var(--v10-muted);
}
.v10-text-btn {
  margin-left: auto;
  border: 0;
  background: color-mix(in oklab, white 6%, transparent);
  color: var(--v10-ink);
  font-size: 0.625rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
  cursor: pointer;
  transition: background 240ms var(--v10-ease), transform 240ms var(--v10-ease);
}
.v10-text-btn:hover:not(:disabled) {
  background: color-mix(in oklab, white 11%, transparent);
  transform: translateY(-1px);
}
.v10-text-btn:disabled { opacity: 0.55; }
.v10-section-body {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--v10-ink);
}
.v10-section-soft,
.v10-section-alert {
  margin: 0.35rem 0 0;
  font-size: 0.6875rem;
  line-height: 1.4;
  color: var(--v10-muted);
}
.v10-section-soft span { font-weight: 600; color: var(--v10-ink); }
.v10-section-alert { color: color-mix(in oklab, var(--v10-wait) 85%, white); }
.v10-list,
.v10-agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
}
.v10-row {
  display: grid;
  grid-template-columns: 0.4rem auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.4rem;
  min-height: 1.7rem;
  padding: 0.25rem 0.35rem;
  border-radius: 10px;
  background: color-mix(in oklab, white 3%, transparent);
  opacity: 0;
  transform: translateY(4px);
  animation: v10-rise 380ms var(--v10-ease) both;
  animation-delay: calc(var(--i, 0) * 40ms + 40ms);
  transition: background 240ms var(--v10-ease);
}
.v10-row:hover { background: color-mix(in oklab, white 6%, transparent); }
.v10-row-mark {
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 999px;
  background: var(--v10-calm);
}
.v10-row.v10-tone-wait .v10-row-mark { background: var(--v10-wait); }
.v10-row.v10-tone-warn .v10-row-mark { background: var(--v10-warn); }
.v10-row-kind {
  font-size: 0.5625rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--v10-muted);
}
.v10-row-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  color: var(--v10-ink);
}
.v10-row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.35rem;
  height: 1.35rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--v10-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 200ms var(--v10-ease), background 200ms var(--v10-ease), color 200ms var(--v10-ease);
}
.v10-row:hover .v10-row-action,
.v10-row:focus-within .v10-row-action { opacity: 1; }
.v10-row-action:hover {
  background: color-mix(in oklab, white 10%, transparent);
  color: var(--v10-ink);
}
.v10-agent {
  display: grid;
  grid-template-columns: 0.45rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.45rem;
  min-height: 1.65rem;
  padding: 0.22rem 0.35rem;
  border-radius: 10px;
  background: color-mix(in oklab, white 3%, transparent);
  opacity: 0;
  transform: translateY(4px);
  animation: v10-rise 380ms var(--v10-ease) both;
  animation-delay: calc(var(--i, 0) * 40ms + 40ms);
}
.v10-agent-dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: var(--v10-calm);
}
.v10-agent.is-running .v10-agent-dot {
  background: var(--v10-live);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--v10-live) 16%, transparent);
  animation: v10-breathe 2s var(--v10-ease) infinite;
}
.v10-agent.is-paused .v10-agent-dot { background: var(--v10-wait); }
.v10-agent-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  color: var(--v10-ink);
}
.v10-agent-state {
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--v10-muted);
}
.v10-agent.is-running .v10-agent-state { color: var(--v10-live); }
.v10-agent.is-paused .v10-agent-state { color: var(--v10-wait); }
@keyframes v10-sheen {
  0%, 100% { transform: translateX(-22%) rotate(0.001deg); opacity: 0.35; }
  50% { transform: translateX(18%) rotate(0.001deg); opacity: 0.7; }
}
@keyframes v10-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.92); }
}
@keyframes v10-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .v10-sheen,
  .v10-pulse,
  .v10-agent.is-running .v10-agent-dot,
  .v10-section,
  .v10-row,
  .v10-agent {
    animation: none !important;
  }
  .v10-drawer,
  .v10-glass,
  .v10-chip,
  .v10-icon-btn {
    transition: none !important;
  }
  .v10-section,
  .v10-row,
  .v10-agent {
    opacity: 1;
    transform: none;
  }
}
`;
