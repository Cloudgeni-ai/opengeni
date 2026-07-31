// 8 · Flow — liquid-glass ribbon: soft merges + flowing motion above ChatComposer.
import { ChatComposer, type ComposerState } from "@opengeni/react";
import type { ClientVoiceInputConfig, LineageNode, SessionPendingInputPreview, SessionTurn } from "@opengeni/sdk";
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
  ZapIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { SubagentTree, SubagentsLabel } from "@/components/session/subagents";
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
  id: 8,
  name: "Flow",
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

type FlowPanel = "queue" | "goal" | "agents" | null;

const GOAL_LABEL: Record<GoalPillState, string> = {
  pursuing: "Pursuing",
  scheduled: "Scheduled",
  blocked: "Blocked",
  held: "Held",
  paused: "Paused",
  invariant_broken: "Needs attention",
  completed: "Completed",
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

function previewText(value: string, max = 72): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function pendingTone(classification: SessionPendingInputPreview["classification"]) {
  if (classification === "action_required" || classification === "failure") {
    return "text-status-waiting";
  }
  return "text-fg-muted";
}

/** Shared liquid-glass shell — refractive sheen + soft merge, never instrument theater. */
function FlowGlass({
  children,
  className,
  accent = "idle",
}: {
  children: ReactNode;
  className?: string;
  accent?: "idle" | "live" | "attention";
}) {
  const sheen =
    accent === "attention"
      ? "from-status-waiting/25 via-white/10 to-brand/15"
      : accent === "live"
        ? "from-brand/30 via-white/12 to-status-running/20"
        : "from-white/18 via-white/6 to-brand/10";

  return (
    <div
      className={cn(
        "og-flow-glass relative overflow-hidden rounded-2xl border border-white/20",
        "bg-surface-2/55 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.22)]",
        "backdrop-blur-xl supports-[backdrop-filter]:bg-surface-2/40",
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-br opacity-80",
          sheen,
          "og-flow-sheen",
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-1/3 top-0 h-full w-1/2 skew-x-[-18deg] bg-gradient-to-r from-transparent via-white/18 to-transparent og-flow-refract"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

function FlowSegment({
  active,
  onClick,
  icon,
  label,
  detail,
  toneClass,
  trailing,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  detail?: string | null;
  toneClass?: string;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={cn(
        "group relative flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left outline-none",
        "transition-[background-color,transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "hover:-translate-y-px hover:bg-white/10 focus-visible:bg-white/12",
        active && "bg-white/12 shadow-[inset_0_-2px_0_0_rgba(255,255,255,0.35)]",
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full bg-white/10",
          "ring-1 ring-inset ring-white/15 transition-transform duration-300 group-hover:scale-105",
          toneClass,
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold tracking-tight text-fg">
          {label}
        </span>
        {detail ? (
          <span className="block truncate text-[10px] leading-tight text-fg-muted">{detail}</span>
        ) : null}
      </span>
      {trailing}
      <ChevronDownIcon
        className={cn(
          "size-3 shrink-0 text-fg-subtle transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          active && "rotate-180 text-fg",
        )}
      />
    </button>
  );
}

function FlowExpand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "border-t border-white/10 px-2.5 py-2 transition-transform duration-300",
            open ? "translate-y-0" : "-translate-y-1",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SoftDivider() {
  return (
    <span
      aria-hidden
      className="my-1.5 w-px shrink-0 self-stretch bg-gradient-to-b from-transparent via-white/35 to-transparent"
    />
  );
}

function QueueRows({ turns, inputs }: { turns: SessionTurn[]; inputs: SessionPendingInputPreview[] }) {
  if (turns.length === 0 && inputs.length === 0) {
    return <p className="px-1 py-1 text-[11px] text-fg-muted">Nothing waiting.</p>;
  }
  return (
    <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto overscroll-contain pr-0.5">
      {inputs.map((input, index) => (
        <li
          key={input.id}
          className="og-flow-row flex items-start gap-2 rounded-xl px-2 py-1.5 transition-colors duration-200 hover:bg-white/10"
          style={{ "--og-flow-i": index } as CSSProperties}
        >
          <InboxIcon className={cn("mt-0.5 size-3 shrink-0", pendingTone(input.classification))} />
          <span className="min-w-0">
            <span className="block text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
              Incoming
            </span>
            <span className="block text-[11px] leading-snug text-fg">{previewText(input.summary, 120)}</span>
          </span>
        </li>
      ))}
      {turns.map((turn, index) => (
        <li
          key={turn.id}
          className="og-flow-row flex items-start gap-2 rounded-xl px-2 py-1.5 transition-colors duration-200 hover:bg-white/10"
          style={{ "--og-flow-i": inputs.length + index } as CSSProperties}
        >
          <ListOrderedIcon className="mt-0.5 size-3 shrink-0 text-fg-subtle" />
          <span className="min-w-0">
            <span className="block text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
              Queued · {index + 1}
            </span>
            <span className="block text-[11px] leading-snug text-fg">{previewText(turn.prompt, 120)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function GoalPanel({
  scenario,
  elapsed,
  state,
}: {
  scenario: ChromeScenario;
  elapsed: string | null;
  state: GoalPillState;
}) {
  const record = scenario.goal.goal;
  if (!record) return null;
  const attention = state === "blocked" || state === "held" || state === "invariant_broken";

  return (
    <div className="space-y-2 px-1">
      <p className="text-[12px] leading-snug text-fg">{record.text}</p>
      {record.successCriteria ? (
        <p className="text-[11px] leading-snug text-fg-muted">
          <span className="font-medium text-fg">Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {attention && record.continuation?.lastError ? (
        <p className="text-[11px] leading-snug text-status-waiting">{record.continuation.lastError}</p>
      ) : null}
      {record.status === "paused" && record.pausedReason ? (
        <p className="text-[11px] leading-snug text-status-waiting">Paused because {record.pausedReason}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {elapsed ? (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] tabular-nums text-fg-muted ring-1 ring-inset ring-white/10">
            {elapsed}
          </span>
        ) : null}
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-fg-muted ring-1 ring-inset ring-white/10">
          {record.autoContinuations} continues
        </span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-fg-muted ring-1 ring-inset ring-white/10">
          v{record.version}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {record.status === "active" || record.status === "paused" ? (
            <button
              type="button"
              disabled={scenario.goal.updating}
              onClick={() =>
                void (record.status === "paused"
                  ? scenario.goal.resume()
                  : scenario.goal.pause("Paused from the console"))
              }
              className="inline-flex h-7 items-center gap-1 rounded-full bg-white/12 px-2.5 text-[11px] font-medium text-fg ring-1 ring-inset ring-white/15 transition-all duration-200 hover:bg-white/20 hover:shadow-sm disabled:opacity-50"
            >
              {scenario.goal.updating ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : record.status === "paused" ? (
                <PlayIcon className="size-3" />
              ) : (
                <PauseIcon className="size-3" />
              )}
              {record.status === "paused" ? "Resume" : "Pause"}
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function AgentsPanel({ nodes }: { nodes: LineageNode[] }) {
  return (
    <div className="px-0.5">
      <SubagentsLabel count={nodes.length} />
      <div className="mt-1.5">
        <SubagentTree workspaceId={GALLERY_WORKSPACE_ID} nodes={nodes} />
      </div>
    </div>
  );
}

function FlowChrome({ scenario }: { scenario: ChromeScenario }) {
  const [panel, setPanel] = useState<FlowPanel>(null);
  const stylesId = useId();

  const queueTurns = scenario.queue.queue;
  const pendingInputs = scenario.queue.pendingInputs;
  const queueTotal = queueTurns.length + pendingInputs.length;
  const goal = scenario.goal.goal;
  const agents = scenario.agentNodes;

  const live =
    goal?.status === "active" &&
    goal.continuation?.state === "running" &&
    goal.continuation.reason === "goal_turn_running";
  const elapsed = useLiveElapsed(goal?.createdAt, Boolean(live), !live ? goal?.updatedAt : null);
  const goalState = goal ? goalPillState(goal.status, goal.continuation) : null;

  const hasQueue = queueTotal > 0;
  const hasGoal = Boolean(goal);
  const hasAgents = agents.length > 0;
  const hasChrome = hasQueue || hasGoal || hasAgents;

  const runningAgents = agents.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const pausedAgents = agents.filter((node) => node.session.effectiveControl.state === "paused").length;
  const attention =
    goalState === "blocked" ||
    goalState === "held" ||
    goalState === "invariant_broken" ||
    pendingInputs.some((input) => input.classification === "action_required" || input.classification === "failure");
  const accent = attention ? "attention" : live || runningAgents > 0 ? "live" : "idle";

  const toggle = (next: FlowPanel) => setPanel((current) => (current === next ? null : next));

  if (!hasChrome) return null;

  const queueLabel =
    pendingInputs.length > 0 && queueTurns.length > 0
      ? `${pendingInputs.length} in · ${queueTurns.length} queued`
      : pendingInputs.length > 0
        ? `${pendingInputs.length} incoming`
        : `${queueTurns.length} queued`;
  const queueDetail = previewText(
    queueTurns[0]?.prompt ?? pendingInputs[0]?.summary ?? "",
    42,
  );

  const GoalIcon =
    goalState === "blocked" || goalState === "invariant_broken"
      ? TriangleAlertIcon
      : goalState === "paused" || goalState === "held"
        ? PauseIcon
        : goalState === "scheduled"
          ? Loader2Icon
          : ZapIcon;

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-4 sm:px-6">
      <style id={stylesId}>{`
        @keyframes og-flow-sheen {
          0%, 100% { background-position: 0% 40%; opacity: 0.72; }
          50% { background-position: 100% 60%; opacity: 1; }
        }
        @keyframes og-flow-refract {
          0% { transform: translateX(-20%) skewX(-18deg); opacity: 0.15; }
          50% { transform: translateX(40%) skewX(-18deg); opacity: 0.45; }
          100% { transform: translateX(120%) skewX(-18deg); opacity: 0.1; }
        }
        @keyframes og-flow-row-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: no-preference) {
          .og-flow-sheen {
            background-size: 180% 180%;
            animation: og-flow-sheen 9s ease-in-out infinite;
          }
          .og-flow-refract {
            animation: og-flow-refract 7.5s ease-in-out infinite;
          }
          .og-flow-row {
            animation: og-flow-row-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
            animation-delay: calc(var(--og-flow-i, 0) * 45ms);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .og-flow-sheen, .og-flow-refract, .og-flow-row { animation: none !important; }
        }
      `}</style>

      <FlowGlass accent={accent}>
        <div className="flex items-stretch gap-0 px-0.5">
          {hasQueue ? (
            <FlowSegment
              active={panel === "queue"}
              onClick={() => toggle("queue")}
              icon={<InboxIcon className="size-3.5" />}
              label={queueLabel}
              detail={queueDetail}
              toneClass={
                pendingInputs.some((i) => i.classification === "action_required" || i.classification === "failure")
                  ? "text-status-waiting"
                  : "text-fg-subtle"
              }
            />
          ) : null}

          {hasQueue && (hasGoal || hasAgents) ? <SoftDivider /> : null}

          {hasGoal && goalState ? (
            <FlowSegment
              active={panel === "goal"}
              onClick={() => toggle("goal")}
              icon={
                <GoalIcon
                  className={cn(
                    "size-3.5",
                    goalState === "scheduled" && "animate-spin",
                    live && "text-brand",
                  )}
                />
              }
              label={GOAL_LABEL[goalState]}
              detail={previewText(goal!.text, 40)}
              toneClass={
                attention
                  ? "text-status-waiting"
                  : live
                    ? "text-brand"
                    : "text-fg-subtle"
              }
              trailing={
                elapsed ? (
                  <span className="hidden shrink-0 tabular-nums text-[10px] text-fg-muted sm:inline">
                    {elapsed}
                  </span>
                ) : null
              }
            />
          ) : null}

          {hasGoal && hasAgents ? <SoftDivider /> : null}

          {hasAgents ? (
            <FlowSegment
              active={panel === "agents"}
              onClick={() => toggle("agents")}
              icon={
                runningAgents > 0 ? (
                  <span className="relative flex size-3.5 items-center justify-center">
                    <span className="absolute inline-flex size-2 rounded-full bg-status-running opacity-70 motion-safe:animate-ping" />
                    <span className="relative inline-flex size-2 rounded-full bg-status-running" />
                  </span>
                ) : (
                  <BotIcon className="size-3.5" />
                )
              }
              label={`${agents.length} agent${agents.length === 1 ? "" : "s"}`}
              detail={
                runningAgents > 0
                  ? `${runningAgents} running`
                  : pausedAgents > 0
                    ? `${pausedAgents} paused`
                    : "idle"
              }
              toneClass={runningAgents > 0 ? "text-status-running" : "text-fg-subtle"}
            />
          ) : null}
        </div>

        <FlowExpand open={panel === "queue"}>
          <QueueRows turns={queueTurns} inputs={pendingInputs} />
        </FlowExpand>
        <FlowExpand open={panel === "goal"}>
          {goalState ? <GoalPanel scenario={scenario} elapsed={elapsed} state={goalState} /> : null}
        </FlowExpand>
        <FlowExpand open={panel === "agents"}>
          <AgentsPanel nodes={agents} />
        </FlowExpand>
      </FlowGlass>
    </div>
  );
}

function FlowScenarioStack({
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
      data-variant="flow"
    >
      <FlowChrome scenario={scenario} />
      <div className="shrink-0 px-4 pb-4 pt-0.5 sm:px-6">
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

export function Variant() {
  const composer = useMemo(() => idleComposer(), []);
  const scenarios = useMemo(() => chromeScenarios(), []);
  const [filter, setFilter] = useState<"all" | ChromeScenarioId>("all");
  const visible = filter === "all" ? scenarios : scenarios.filter((row) => row.id === filter);

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        <div className="rounded-xl border border-border bg-surface-2/40 px-4 py-4">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <SparklesIcon className="size-3.5 text-brand" />
            8 · Flow — liquid ribbon above the composer
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
            One refractive glass surface softly merges incoming, queue, goal, and agents. Segments
            expand with flowing motion; actions stay one tap away. ChatComposer stays production.
            Compact vertically — not stacked instrument theater.
          </p>
        </div>
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
            aria-labelledby={`flow-scenario-${scenario.id}`}
            className="overflow-hidden rounded-xl border border-border bg-surface/30"
          >
            <header className="space-y-1 border-b border-border bg-surface-2/50 px-4 py-3 sm:px-5">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
                Scenario {index + 1}
                <span className="mx-1.5 text-border">·</span>
                <span className="font-mono normal-case tracking-normal text-fg-muted">{scenario.id}</span>
              </p>
              <h2 id={`flow-scenario-${scenario.id}`} className="text-sm font-semibold text-fg">
                {scenario.title}
              </h2>
              <p className="text-xs text-fg-muted">{scenario.description}</p>
            </header>
            <div className="p-3 sm:p-4">
              <FlowScenarioStack scenario={scenario} composer={composer} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
