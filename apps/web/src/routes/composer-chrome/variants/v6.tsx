// 6 · Lumen — one liquid-glass rail: queue · incoming · goal · agents.
// Compact, sleek, motion-forward. ChatComposer stays production.
import { ChatComposer, type ComposerState } from "@opengeni/react";
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
  Trash2Icon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { goalPillState, type GoalPillState } from "@/components/session/goal-surface";
import { SubagentTree } from "@/components/session/subagents";
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
  id: 6,
  name: "Lumen",
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

type SegmentId = "queue" | "incoming" | "goal" | "agents";

/* -------------------------------------------------------------------------- */
/* Styles — scoped once per page                                              */
/* -------------------------------------------------------------------------- */

const LUMEN_STYLES = `
@keyframes og-lumen-rise {
  from { opacity: 0; transform: translateY(8px) scale(0.985); filter: blur(2px); }
  to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
@keyframes og-lumen-sheen {
  0% { transform: translateX(-120%) skewX(-18deg); opacity: 0; }
  35% { opacity: 0.55; }
  100% { transform: translateX(220%) skewX(-18deg); opacity: 0; }
}
@keyframes og-lumen-breathe {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.15); }
}
@keyframes og-lumen-softpulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--color-status-running) 0%, transparent); }
  50% { box-shadow: 0 0 18px 0 color-mix(in oklch, var(--color-status-running) 22%, transparent); }
}
@keyframes og-lumen-chip-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .og-lumen-rail,
  .og-lumen-chip,
  .og-lumen-sheen,
  .og-lumen-live-dot,
  .og-lumen-live-shell {
    animation: none !important;
    transition: none !important;
  }
}
`;

function LumenStyles() {
  return <style href="og-lumen-v6" precedence="medium">{LUMEN_STYLES}</style>;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function formatCoarseElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
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

function preview(text: string, max = 48): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

const GOAL_LABEL: Record<GoalPillState, string> = {
  pursuing: "Pursuing",
  scheduled: "Scheduled",
  blocked: "Blocked",
  held: "Held",
  paused: "Paused",
  invariant_broken: "Attention",
  completed: "Done",
};

function goalAccent(state: GoalPillState): string {
  switch (state) {
    case "pursuing":
    case "scheduled":
      return "text-brand";
    case "blocked":
    case "held":
    case "paused":
    case "invariant_broken":
      return "text-status-waiting";
    case "completed":
      return "text-status-idle";
  }
}

function pendingTone(classification: SessionPendingInputPreview["classification"]): string {
  switch (classification) {
    case "failure":
      return "text-status-failed";
    case "action_required":
      return "text-status-waiting";
    default:
      return "text-fg-muted";
  }
}

function pendingKindLabel(kind: SessionPendingInputPreview["kind"]): string {
  switch (kind) {
    case "child_terminal_result":
      return "Child result";
    case "agent_message":
      return "Agent message";
    case "agent_steer_instruction":
      return "Steer";
    case "scheduled_occurrence":
      return "Schedule";
    default:
      return "Update";
  }
}

/* -------------------------------------------------------------------------- */
/* Glass shell                                                                */
/* -------------------------------------------------------------------------- */

function GlassShell({
  children,
  className,
  live = false,
}: {
  children: ReactNode;
  className?: string;
  live?: boolean;
}) {
  return (
    <div
      className={cn(
        "og-lumen-rail group/rail relative overflow-hidden rounded-2xl",
        "border border-white/[0.08] bg-white/[0.035]",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset,0_12px_40px_-20px_rgba(0,0,0,0.65)]",
        "backdrop-blur-xl supports-[backdrop-filter]:bg-white/[0.04]",
        "transition-[border-color,box-shadow,transform] duration-300 ease-out",
        "hover:border-white/[0.14] hover:shadow-[0_1px_0_0_rgba(255,255,255,0.1)_inset,0_16px_48px_-18px_rgba(0,0,0,0.7)]",
        live && "og-lumen-live-shell motion-safe:animate-[og-lumen-softpulse_2.8s_ease-in-out_infinite]",
        className,
      )}
      style={{ animation: "og-lumen-rise 420ms cubic-bezier(0.22, 1, 0.36, 1) both" }}
    >
      {/* Specular rim */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent"
      />
      {/* Soft liquid wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-1/4 top-[-60%] h-[160%] w-[70%] rounded-full bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.07),transparent_65%)] opacity-80 transition-opacity duration-500 group-hover/rail:opacity-100"
      />
      {/* Hover sheen */}
      <div
        aria-hidden
        className="og-lumen-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/12 to-transparent opacity-0 transition-opacity duration-300 group-hover/rail:opacity-100 group-hover/rail:motion-safe:animate-[og-lumen-sheen_1.1s_ease-out]"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Segment chip                                                               */
/* -------------------------------------------------------------------------- */

function SegmentChip({
  id,
  active,
  onSelect,
  icon,
  label,
  meta,
  accent,
  live,
  index,
  trailing,
}: {
  id: SegmentId;
  active: boolean;
  onSelect: (id: SegmentId) => void;
  icon: ReactNode;
  label: string;
  meta?: string;
  accent?: string;
  live?: boolean;
  index: number;
  trailing?: ReactNode;
}) {
  return (
    <div
      className="og-lumen-chip flex min-w-0 items-center"
      style={
        {
          animation: "og-lumen-chip-in 380ms cubic-bezier(0.22, 1, 0.36, 1) both",
          animationDelay: `${80 + index * 45}ms`,
        } as CSSProperties
      }
    >
      <button
        type="button"
        aria-expanded={active}
        aria-controls={`lumen-panel-${id}`}
        onClick={() => onSelect(id)}
        className={cn(
          "group/chip relative flex h-7 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[11px] outline-none",
          "transition-[background-color,color,transform,box-shadow] duration-200 ease-out",
          "hover:-translate-y-px hover:bg-white/[0.07]",
          "focus-visible:ring-2 focus-visible:ring-brand/40",
          active
            ? "bg-white/[0.1] text-fg shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
            : "text-fg-muted hover:text-fg",
        )}
      >
        <span className={cn("relative flex size-3.5 shrink-0 items-center justify-center", accent)}>
          {live ? (
            <span className="relative flex size-2 items-center justify-center">
              <span className="og-lumen-live-dot absolute size-2 rounded-full bg-status-running/50 motion-safe:animate-[og-lumen-breathe_1.8s_ease-in-out_infinite]" />
              <span className="relative size-1.5 rounded-full bg-status-running" />
            </span>
          ) : (
            icon
          )}
        </span>
        <span className="shrink-0 font-medium tracking-tight text-fg">{label}</span>
        {meta ? (
          <>
            <span aria-hidden className="shrink-0 text-fg-subtle/70">
              ·
            </span>
            <span className="min-w-0 truncate text-fg-muted group-hover/chip:text-fg/80">{meta}</span>
          </>
        ) : null}
        <ChevronDownIcon
          className={cn(
            "ml-0.5 size-3 shrink-0 text-fg-subtle transition-transform duration-200",
            active && "rotate-180 text-fg",
          )}
        />
      </button>
      {trailing}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Expand panel                                                               */
/* -------------------------------------------------------------------------- */

function ExpandPanel({
  open,
  id,
  children,
}: {
  open: boolean;
  id: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "border-t border-white/[0.06] px-2.5 py-2 transition-transform duration-300 ease-out",
            open ? "translate-y-0" : "-translate-y-1",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function PanelList({ children }: { children: ReactNode }) {
  return <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto pr-0.5">{children}</ul>;
}

function PanelRow({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[11px]",
        "transition-[background-color,transform] duration-150",
        onClick && "hover:translate-x-px hover:bg-white/[0.05]",
        className,
      )}
    >
      {children}
    </Comp>
  );
}

function IconAction({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-fg-subtle outline-none",
        "opacity-70 transition-[opacity,background-color,color,transform] duration-150",
        "hover:scale-105 hover:bg-white/[0.08] hover:opacity-100 hover:text-fg",
        "focus-visible:ring-2 focus-visible:ring-brand/40",
        danger && "hover:bg-status-failed/15 hover:text-status-failed",
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Unified chrome                                                             */
/* -------------------------------------------------------------------------- */

export function LumenChrome({
  scenario,
  composer,
}: {
  scenario: ChromeScenario;
  composer: ComposerState;
}) {
  const [open, setOpen] = useState<SegmentId | null>(null);
  const baseId = useId();

  const queue = scenario.queue.queue;
  const pending = scenario.queue.pendingInputs;
  const goal = scenario.goal.goal;
  const agents = scenario.agentNodes;

  const liveGoal =
    goal?.status === "active" &&
    goal.continuation?.state === "running" &&
    goal.continuation.reason === "goal_turn_running";
  const elapsed = useLiveElapsed(goal?.createdAt, Boolean(liveGoal), !liveGoal ? goal?.updatedAt : null);

  const runningAgents = agents.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const pausedAgents = agents.filter((node) => node.session.effectiveControl.state === "paused").length;
  const fleetLive = runningAgents > 0;

  const goalState = goal ? goalPillState(goal.status, goal.continuation) : null;
  const hasChrome = queue.length > 0 || pending.length > 0 || Boolean(goal) || agents.length > 0;

  if (!hasChrome) return null;

  const select = (id: SegmentId) => setOpen((prev) => (prev === id ? null : id));

  let chipIndex = 0;

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4 sm:px-6">
      <GlassShell live={liveGoal || fleetLive}>
        <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 px-1.5 py-1.5">
          {queue.length > 0 ? (
            <SegmentChip
              id="queue"
              index={chipIndex++}
              active={open === "queue"}
              onSelect={select}
              icon={<ListOrderedIcon className="size-3.5" />}
              label={`Queue · ${queue.length}`}
              meta={preview(queue[0]?.prompt ?? "", 36)}
              accent="text-status-queued"
            />
          ) : null}

          {pending.length > 0 ? (
            <SegmentChip
              id="incoming"
              index={chipIndex++}
              active={open === "incoming"}
              onSelect={select}
              icon={<InboxIcon className="size-3.5" />}
              label={`In · ${pending.length}`}
              meta={preview(pending[0]?.summary ?? "", 34)}
              accent="text-fg-subtle"
            />
          ) : null}

          {goal && goalState ? (
            <SegmentChip
              id="goal"
              index={chipIndex++}
              active={open === "goal"}
              onSelect={select}
              icon={
                goalState === "blocked" || goalState === "invariant_broken" ? (
                  <TriangleAlertIcon className="size-3.5" />
                ) : goalState === "paused" || goalState === "held" ? (
                  <PauseIcon className="size-3.5" />
                ) : liveGoal ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <ZapIcon className="size-3.5" />
                )
              }
              label={GOAL_LABEL[goalState]}
              meta={[preview(goal.text, 40), elapsed].filter(Boolean).join(" · ")}
              accent={goalAccent(goalState)}
              live={liveGoal}
              trailing={
                goal.status !== "completed" ? (
                  <IconAction
                    label={goal.status === "paused" ? "Resume goal" : "Pause goal"}
                    onClick={() =>
                      void (goal.status === "paused"
                        ? scenario.goal.resume()
                        : scenario.goal.pause("Paused from the console"))
                    }
                  >
                    {scenario.goal.updating ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : goal.status === "paused" ? (
                      <PlayIcon className="size-3" />
                    ) : (
                      <PauseIcon className="size-3" />
                    )}
                  </IconAction>
                ) : null
              }
            />
          ) : null}

          {agents.length > 0 ? (
            <SegmentChip
              id="agents"
              index={chipIndex++}
              active={open === "agents"}
              onSelect={select}
              icon={<BotIcon className="size-3.5" />}
              label={`${agents.length} agent${agents.length === 1 ? "" : "s"}`}
              meta={
                [
                  fleetLive ? `${runningAgents} running` : null,
                  pausedAgents > 0 ? `${pausedAgents} paused` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
              accent={fleetLive ? "text-status-running" : "text-fg-subtle"}
              live={fleetLive}
            />
          ) : null}
        </div>

        <ExpandPanel open={open === "queue"} id={`${baseId}-queue`}>
          <PanelList>
            {queue.map((turn, index) => (
              <QueueTurnRow
                key={turn.id}
                turn={turn}
                index={index}
                onRemove={() => void scenario.queue.removeTurn(turn.id)}
              />
            ))}
          </PanelList>
        </ExpandPanel>

        <ExpandPanel open={open === "incoming"} id={`${baseId}-incoming`}>
          <PanelList>
            {pending.map((input) => (
              <PanelRow key={input.id}>
                <span
                  className={cn(
                    "mt-0.5 size-1.5 shrink-0 rounded-full",
                    input.classification === "failure"
                      ? "bg-status-failed"
                      : input.classification === "action_required"
                        ? "bg-status-waiting"
                        : "bg-fg-subtle",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className={cn("font-medium", pendingTone(input.classification))}>
                    {pendingKindLabel(input.kind)}
                  </span>
                  <span className="mt-0.5 block text-fg-muted">{input.summary}</span>
                </span>
              </PanelRow>
            ))}
          </PanelList>
        </ExpandPanel>

        <ExpandPanel open={open === "goal"} id={`${baseId}-goal`}>
          {goal && goalState ? (
            <div className="space-y-2 px-1 py-0.5 text-[11px]">
              <p className="leading-relaxed text-fg">{goal.text}</p>
              {goal.successCriteria ? (
                <p className="text-fg-muted">
                  <span className="text-fg-subtle">Success · </span>
                  {goal.successCriteria}
                </p>
              ) : null}
              {goal.continuation?.lastError ? (
                <p className="rounded-md bg-status-waiting/10 px-2 py-1.5 text-status-waiting">
                  {goal.continuation.lastError}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-fg-subtle">
                <span className="tabular-nums">{goal.autoContinuations} continuations</span>
                {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
                <span className="ml-auto flex items-center gap-1">
                  {goal.status !== "completed" ? (
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 font-medium text-fg transition-colors hover:bg-white/[0.07]"
                      onClick={() =>
                        void (goal.status === "paused"
                          ? scenario.goal.resume()
                          : scenario.goal.pause("Paused from the console"))
                      }
                    >
                      {goal.status === "paused" ? "Resume" : "Pause"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 font-medium text-fg-muted transition-colors hover:bg-status-failed/15 hover:text-status-failed"
                    onClick={() => void scenario.goal.clearGoal()}
                  >
                    Clear
                  </button>
                </span>
              </div>
            </div>
          ) : null}
        </ExpandPanel>

        <ExpandPanel open={open === "agents"} id={`${baseId}-agents`}>
          <div className="px-0.5 py-0.5">
            <SubagentTree workspaceId={GALLERY_WORKSPACE_ID} nodes={agents as LineageNode[]} />
          </div>
        </ExpandPanel>
      </GlassShell>
    </div>
  );
}

function QueueTurnRow({
  turn,
  index,
  onRemove,
}: {
  turn: SessionTurn;
  index: number;
  onRemove: () => void;
}) {
  return (
    <PanelRow className="group/row items-center">
      <span className="w-4 shrink-0 tabular-nums text-fg-subtle">{index + 1}</span>
      <span className="min-w-0 flex-1 truncate text-fg">{turn.prompt}</span>
      <span className="flex shrink-0 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-within:opacity-100">
        <IconAction label="Remove from queue" danger onClick={onRemove}>
          <Trash2Icon className="size-3" />
        </IconAction>
      </span>
    </PanelRow>
  );
}

/* -------------------------------------------------------------------------- */
/* Scenario stack + matrix                                                    */
/* -------------------------------------------------------------------------- */

function LumenScenarioStack({
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
      className="flex flex-col justify-end rounded-xl border border-border bg-bg/40 pt-10"
      data-scenario={scenario.id}
      data-variant="lumen"
    >
      <LumenChrome scenario={scenario} composer={composer} />
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

function LumenMatrix({ composer }: { composer: ComposerState }) {
  const scenarios = useMemo(() => chromeScenarios(), []);
  const [filter, setFilter] = useState<"all" | ChromeScenarioId>("all");
  const visible = filter === "all" ? scenarios : scenarios.filter((row) => row.id === filter);

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        <p className="text-sm text-fg-muted">
          One liquid-glass rail merges queue, incoming, goal, and agents — compact, informative,
          with hover sheen and accordion detail. ChatComposer is production.
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
            aria-labelledby={`lumen-scenario-${scenario.id}`}
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
              <h2 id={`lumen-scenario-${scenario.id}`} className="text-sm font-semibold text-fg">
                {scenario.title}
              </h2>
              <p className="text-xs text-fg-muted">{scenario.description}</p>
            </header>
            <div className="p-3 sm:p-4">
              <LumenScenarioStack scenario={scenario} composer={composer} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function Variant() {
  const composer = useMemo(() => idleComposer(), []);
  return (
    <>
      <LumenStyles />
      <LumenMatrix composer={composer} />
    </>
  );
}
