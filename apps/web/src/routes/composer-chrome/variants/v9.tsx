// 9 · Lumen — liquid-glass chrome: one merged luminous rail above ChatComposer.
import { ChatComposer, QueueSurface, type ComposerState, type UseGoalResult } from "@opengeni/react";
import type { ClientVoiceInputConfig, LineageNode, SessionGoal } from "@opengeni/sdk";
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { Popover } from "radix-ui";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { goalPillState, type GoalPillState } from "@/components/session/goal-surface";
import { SubagentTree, SubagentsLabel } from "@/components/session/subagents";
import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
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

import { ScenarioFilter } from "../scenario-matrix";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 9,
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

type LumenTone = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  gem: string;
  wash: string;
  ring: string;
};

const LUMEN_TONE: Record<GoalPillState, LumenTone> = {
  pursuing: {
    label: "Pursuing",
    icon: ZapIcon,
    gem: "bg-brand shadow-[0_0_12px_color-mix(in_oklch,var(--color-brand)_55%,transparent)]",
    wash: "from-brand/18 via-transparent to-transparent",
    ring: "border-brand/35",
  },
  scheduled: {
    label: "Scheduled",
    icon: Loader2Icon,
    gem: "bg-brand/80 shadow-[0_0_10px_color-mix(in_oklch,var(--color-brand)_40%,transparent)]",
    wash: "from-brand/12 via-transparent to-transparent",
    ring: "border-brand/30",
  },
  blocked: {
    label: "Blocked",
    icon: TriangleAlertIcon,
    gem: "bg-status-waiting shadow-[0_0_12px_color-mix(in_oklch,var(--color-status-waiting)_50%,transparent)]",
    wash: "from-status-waiting/16 via-transparent to-transparent",
    ring: "border-status-waiting/35",
  },
  held: {
    label: "Held",
    icon: PauseIcon,
    gem: "bg-status-waiting/80",
    wash: "from-status-waiting/12 via-transparent to-transparent",
    ring: "border-status-waiting/30",
  },
  paused: {
    label: "Paused",
    icon: PauseIcon,
    gem: "bg-status-waiting/70",
    wash: "from-status-waiting/10 via-transparent to-transparent",
    ring: "border-status-waiting/28",
  },
  invariant_broken: {
    label: "Needs attention",
    icon: TriangleAlertIcon,
    gem: "bg-status-waiting shadow-[0_0_14px_color-mix(in_oklch,var(--color-status-waiting)_55%,transparent)]",
    wash: "from-status-waiting/18 via-transparent to-transparent",
    ring: "border-status-waiting/40",
  },
  completed: {
    label: "Completed",
    icon: CheckCircle2Icon,
    gem: "bg-status-idle shadow-[0_0_10px_color-mix(in_oklch,var(--color-status-idle)_40%,transparent)]",
    wash: "from-status-idle/14 via-transparent to-transparent",
    ring: "border-status-idle/30",
  },
};

const glassShell =
  "relative overflow-hidden rounded-2xl border bg-surface/55 shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_8px_28px_-18px_rgba(0,0,0,0.45)] backdrop-blur-xl supports-[backdrop-filter]:bg-surface/40";

const glassPanel =
  "rounded-xl border border-white/10 bg-surface/80 shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_16px_40px_-24px_rgba(0,0,0,0.55)] backdrop-blur-2xl supports-[backdrop-filter]:bg-surface/65";

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

function continuationNotice(
  state: GoalPillState,
  continuation: SessionGoal["continuation"],
): { tone: "info" | "waiting" | "failed"; title: string; body: string } | null {
  if (!continuation || state === "pursuing" || state === "paused" || state === "completed") {
    return state === "invariant_broken"
      ? {
          tone: "failed",
          title: "Needs attention",
          body:
            continuation?.lastError ?? "The server could not verify how this goal will continue.",
        }
      : null;
  }
  if (state === "scheduled") {
    return {
      tone: "info",
      title: "Continuation scheduled",
      body: continuation.nextAttemptAt
        ? `Next turn ${new Date(continuation.nextAttemptAt).toLocaleString()}.`
        : "Next turn is scheduled and waiting for its wake signal.",
    };
  }
  if (state === "held") {
    return {
      tone: "waiting",
      title: "Held by workstream",
      body: "Still active — continues when this workstream resumes.",
    };
  }
  if (state === "blocked") {
    return {
      tone: "waiting",
      title: "Continuation blocked",
      body: continuation.lastError ?? "Blocked until the blocker clears.",
    };
  }
  return {
    tone: "failed",
    title: "Needs attention",
    body: continuation.lastError ?? "Invalid continuation state.",
  };
}

/** Merged goal + agents liquid-glass rail — one system, not stacked pills. */
function LumenChrome({
  goal,
  nodes,
}: {
  goal: UseGoalResult;
  nodes: LineageNode[];
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"goal" | "agents">("goal");
  const record = goal.goal;
  const agentCount = nodes.length;
  const runningCount = nodes.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const pausedCount = nodes.filter((node) => node.session.effectiveControl.state === "paused").length;
  const liveAgents = runningCount > 0;

  const liveGoal =
    record?.status === "active" &&
    record.continuation?.state === "running" &&
    record.continuation.reason === "goal_turn_running";
  const elapsed = useLiveElapsed(
    record?.createdAt,
    Boolean(liveGoal),
    !liveGoal ? record?.updatedAt : null,
  );

  if (!record && agentCount === 0) return null;

  const state = record ? goalPillState(record.status, record.continuation) : null;
  const tone = state ? LUMEN_TONE[state] : null;
  const Icon = tone?.icon ?? BotIcon;
  const canToggle = Boolean(record && record.status !== "completed");

  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-4 sm:px-6">
      <style>{`
        @keyframes lumen-sheen {
          0% { transform: translateX(-120%); opacity: 0; }
          35% { opacity: 0.55; }
          100% { transform: translateX(120%); opacity: 0; }
        }
        @keyframes lumen-breathe {
          0%, 100% { opacity: 0.55; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.08); }
        }
        @media (prefers-reduced-motion: reduce) {
          .lumen-sheen, .lumen-breathe { animation: none !important; }
        }
      `}</style>

      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setPanel(record ? "goal" : "agents");
        }}
      >
        <Popover.Anchor asChild>
          <div
            data-testid="lumen-chrome"
            className={cn(
              glassShell,
              "group/lumen transition-[border-color,box-shadow,transform] duration-300 ease-out",
              "hover:-translate-y-px hover:border-white/20 hover:shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_14px_36px_-20px_rgba(0,0,0,0.55)]",
              tone?.ring ?? "border-white/10",
            )}
          >
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 bg-gradient-to-r opacity-90",
                tone?.wash ?? "from-white/5 via-transparent to-transparent",
              )}
            />
            <div
              aria-hidden
              className="lumen-sheen pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent opacity-0 transition-opacity duration-300 group-hover/lumen:opacity-100 motion-safe:group-hover/lumen:[animation:lumen-sheen_1.1s_ease-out]"
            />

            <div className="relative flex h-8 min-w-0 items-center gap-1.5 pl-2.5 pr-1">
              {record && tone ? (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-0.5 text-left outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring/35"
                  onClick={() => {
                    setPanel("goal");
                    setOpen(true);
                  }}
                >
                  <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        tone.gem,
                        liveGoal && "lumen-breathe motion-safe:[animation:lumen-breathe_2.4s_ease-in-out_infinite]",
                      )}
                    />
                  </span>
                  <Icon
                    className={cn(
                      "size-3.5 shrink-0 text-fg",
                      state === "scheduled" && "motion-safe:animate-spin",
                    )}
                  />
                  <span className="shrink-0 text-[11px] font-semibold tracking-tight text-fg">
                    {tone.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={record.text}>
                    {record.text}
                  </span>
                  {elapsed ? (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-subtle">
                      {elapsed}
                    </span>
                  ) : null}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-[11px] text-fg-muted">
                  <BotIcon className="size-3.5 shrink-0 text-fg-subtle" />
                  <span className="font-medium text-fg">Agents</span>
                </div>
              )}

              {agentCount > 0 ? (
                <>
                  <span aria-hidden className="h-4 w-px shrink-0 bg-white/10" />
                  <button
                    type="button"
                    data-testid="lumen-agents"
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-xl px-2 text-[11px] outline-none transition-all duration-200",
                      "hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-ring/35",
                      liveAgents ? "text-status-running" : "text-fg-muted hover:text-fg",
                    )}
                    onClick={() => {
                      setPanel("agents");
                      setOpen(true);
                    }}
                  >
                    {liveAgents ? (
                      <span className="relative flex size-2.5 items-center justify-center">
                        <span className="absolute size-2 rounded-full bg-status-running/50 motion-safe:animate-ping" />
                        <span className="relative size-1.5 rounded-full bg-status-running" />
                      </span>
                    ) : (
                      <BotIcon className="size-3 shrink-0" />
                    )}
                    <span className="font-semibold tabular-nums text-fg">
                      {agentCount}
                    </span>
                    {liveAgents ? (
                      <span className="hidden font-medium sm:inline">{runningCount} run</span>
                    ) : null}
                    {pausedCount > 0 ? (
                      <span className="hidden font-medium text-status-waiting sm:inline">
                        {pausedCount} pause
                      </span>
                    ) : null}
                  </button>
                </>
              ) : null}

              {canToggle && record && !open ? (
                <button
                  type="button"
                  aria-label={record.status === "paused" ? "Resume goal" : "Pause goal"}
                  disabled={goal.updating}
                  onClick={() =>
                    void (record.status === "paused"
                      ? goal.resume()
                      : goal.pause("Paused from the console"))
                  }
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-xl text-fg-subtle outline-none transition-all duration-200 hover:bg-white/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/35 disabled:opacity-60"
                >
                  {goal.updating ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : record.status === "paused" ? (
                    <PlayIcon className="size-3.5" />
                  ) : (
                    <PauseIcon className="size-3.5" />
                  )}
                </button>
              ) : null}

              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label={open ? "Hide detail" : "Show detail"}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-xl text-fg-subtle outline-none transition-all duration-200 hover:bg-white/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/35 data-[state=open]:bg-white/10 data-[state=open]:text-fg"
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-3.5 transition-transform duration-300 ease-out",
                      open && "rotate-180",
                    )}
                  />
                </button>
              </Popover.Trigger>
            </div>
          </div>
        </Popover.Anchor>

        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className={cn(
              "z-50 flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden outline-none",
              glassPanel,
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=top]:slide-in-from-bottom-1",
            )}
          >
            {(record && agentCount > 0) || agentCount > 0 ? (
              <div className="flex shrink-0 gap-1 border-b border-white/[0.08] p-1.5">
                {record ? (
                  <SegmentTab active={panel === "goal"} onClick={() => setPanel("goal")}>
                    Goal
                  </SegmentTab>
                ) : null}
                {agentCount > 0 ? (
                  <SegmentTab active={panel === "agents"} onClick={() => setPanel("agents")}>
                    Agents · {agentCount}
                  </SegmentTab>
                ) : null}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
              {panel === "goal" && record && state ? (
                <LumenGoalDetail goal={goal} state={state} />
              ) : null}
              {panel === "agents" && agentCount > 0 ? (
                <div>
                  <SubagentsLabel count={agentCount} />
                  <div className="mt-2">
                    <SubagentTree
                      workspaceId={GALLERY_WORKSPACE_ID}
                      nodes={nodes}
                      onNavigate={() => setOpen(false)}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function SegmentTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium outline-none transition-all duration-200",
        "focus-visible:ring-2 focus-visible:ring-ring/35",
        active
          ? "bg-white/[0.12] text-fg shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]"
          : "text-fg-muted hover:bg-white/[0.06] hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function LumenGoalDetail({ goal, state }: { goal: UseGoalResult; state: GoalPillState }) {
  const record = goal.goal;
  if (!record) return null;
  const tone = LUMEN_TONE[state];
  const notice = continuationNotice(state, record.continuation);
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        <span className={cn("size-1.5 rounded-full", tone.gem)} />
        {tone.label}
      </div>
      <p className="mt-1.5 text-sm leading-6 text-fg">{record.text}</p>
      {record.successCriteria ? (
        <p className="mt-2 text-xs leading-5 text-fg-muted">
          <span className="font-medium text-fg">Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {record.status === "paused" && (record.pausedReason ?? record.rationale) ? (
        <p className="mt-2 text-xs leading-5 text-status-waiting/90">
          Paused because {record.pausedReason ?? record.rationale}
        </p>
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notice>
      ) : null}
      {record.status === "completed" && record.evidence ? (
        <p className="mt-2 text-xs leading-5 text-status-idle/90">Evidence {record.evidence}</p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <MetaChip
          dot={
            record.maxAutoContinuations !== null &&
            record.autoContinuations >= record.maxAutoContinuations
              ? "waiting"
              : undefined
          }
        >
          {record.maxAutoContinuations !== null
            ? `${record.autoContinuations} of ${record.maxAutoContinuations} auto-continues`
            : `${record.autoContinuations} auto-continue${record.autoContinuations === 1 ? "" : "s"}`}
        </MetaChip>
        <MetaChip dot={record.noProgressStreak >= 2 ? "waiting" : undefined}>
          {record.noProgressStreak} stalled check{record.noProgressStreak === 1 ? "" : "s"}
        </MetaChip>
        <MetaChip>v{record.version}</MetaChip>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <DeleteGoalButton goal={goal} />
        {record.status === "active" ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={goal.updating}
            onClick={() => void goal.pause("Paused from the console")}
          >
            {goal.updating ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <PauseIcon className="size-3" />
            )}
            Pause goal
          </Button>
        ) : record.status === "paused" ? (
          <Button
            type="button"
            size="xs"
            disabled={goal.updating}
            onClick={() => void goal.resume()}
          >
            {goal.updating ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <PlayIcon className="size-3" />
            )}
            Resume goal
          </Button>
        ) : null}
      </div>

      {goal.mutationError ? (
        <div className="mt-2">
          <Notice tone="failed">{goal.mutationError.message}</Notice>
        </div>
      ) : null}
    </div>
  );
}

function DeleteGoalButton({ goal }: { goal: UseGoalResult }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <span className="pl-1">Delete goal?</span>
        <Button type="button" variant="ghost" size="xs" disabled={goal.updating} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="xs"
          disabled={goal.updating}
          onClick={() => void goal.deleteGoal()}
        >
          {goal.updating ? <Loader2Icon className="size-3 animate-spin" /> : null}
          Delete
        </Button>
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="text-fg-subtle hover:text-destructive"
      disabled={goal.updating}
      onClick={() => setConfirming(true)}
    >
      <Trash2Icon className="size-3" />
      Delete goal
    </Button>
  );
}

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
      className="relative flex flex-col justify-end overflow-hidden rounded-2xl border border-white/10 bg-bg/50 pt-10"
      data-scenario={scenario.id}
      style={
        {
          backgroundImage:
            "radial-gradient(120% 80% at 50% 100%, color-mix(in oklch, var(--color-brand) 8%, transparent), transparent 55%)",
        } as CSSProperties
      }
    >
      <QueueSurface queue={scenario.queue} composer={composer} />
      <LumenChrome goal={scenario.goal} nodes={scenario.agentNodes} />
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

function LumenScenarioMatrix({
  composer,
  filter = "all",
}: {
  composer: ComposerState;
  filter?: "all" | ChromeScenarioId;
}) {
  const scenarios = useMemo(() => chromeScenarios(), []);
  const visible = filter === "all" ? scenarios : scenarios.filter((row) => row.id === filter);

  return (
    <div className="flex flex-col gap-10">
      {visible.map((scenario, index) => (
        <section
          key={scenario.id}
          aria-labelledby={`lumen-scenario-${scenario.id}`}
          className="overflow-hidden rounded-2xl border border-border/80 bg-surface/25"
        >
          <header className="space-y-1 border-b border-border/70 bg-surface-2/40 px-4 py-3 sm:px-5">
            <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
              Scenario {index + 1}
              <span className="mx-1.5 text-border">·</span>
              <span className="font-mono normal-case tracking-normal text-fg-muted">{scenario.id}</span>
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
  );
}

export function Variant() {
  const composer = useMemo(() => idleComposer(), []);
  const scenarios = useMemo(() => chromeScenarios(), []);
  const [filter, setFilter] = useState<"all" | ChromeScenarioId>("all");

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        <div className={cn(glassShell, "border-white/10 px-4 py-4")}>
          <p className="text-sm font-semibold tracking-tight text-fg">9 · Lumen</p>
          <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
            One luminous liquid-glass rail merges goal + agents — compact glance, hover sheen,
            inline pause/resume, segmented detail. Production ChatComposer + QueueSurface unchanged.
          </p>
        </div>
        <ScenarioFilter scenarios={scenarios} filter={filter} onChange={setFilter} />
      </header>
      <LumenScenarioMatrix composer={composer} filter={filter} />
    </div>
  );
}
