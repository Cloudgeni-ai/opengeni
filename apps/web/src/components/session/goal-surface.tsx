// The goal surface: ONE slim floating pill above the composer (Codex-style)
// that carries the active goal at a glance — state, truncated title, live
// elapsed — and expands to a panel with the full goal detail, autonomy
// counters, pause/resume, and the spawned-subagent tree. The same subagent
// panel backs the header "N agents" chip (see SessionAgentsChip), so the
// session's lineage is one component reused in two places.
//
// Copy doctrine: human language only. Internal status slugs (requires_action,
// active, …) are translated to plain labels at this boundary; no enum leaks
// into a rendered string.
import type { UseGoalResult } from "@opengeni/react";
import { useSessionLineage } from "@opengeni/react";
import type { LineageNode, SessionEvent, SessionStatus, SessionSummary } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { Collapsible, Popover } from "radix-ui";
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { STATUS_META, StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

/* --- state model ------------------------------------------------------------ */

type GoalPillState = "pursuing" | "paused" | "attention" | "completed";

type GoalPillMeta = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Glyph + accent tint for the leading icon and the elapsed dot. */
  tint: string;
  /** Ring/border tint for the pill when the state earns color. */
  ring: string;
};

const GOAL_PILL_META: Record<GoalPillState, GoalPillMeta> = {
  pursuing: { label: "Pursuing goal", icon: ZapIcon, tint: "text-brand", ring: "border-brand/40" },
  paused: { label: "Goal paused", icon: PauseIcon, tint: "text-status-waiting", ring: "border-status-waiting/40" },
  attention: { label: "Needs attention", icon: TriangleAlertIcon, tint: "text-status-waiting", ring: "border-status-waiting/45" },
  completed: { label: "Goal completed", icon: CheckCircle2Icon, tint: "text-status-idle", ring: "border-status-idle/40" },
};

function goalPillState(goalStatus: "active" | "paused" | "completed", sessionStatus: SessionStatus): GoalPillState {
  if (goalStatus === "completed") {
    return "completed";
  }
  if (goalStatus === "active" && sessionStatus === "requires_action") {
    return "attention";
  }
  if (goalStatus === "paused") {
    return "paused";
  }
  return "pursuing";
}

/** Map a session lifecycle status onto the six-tone status language. */
export function sessionStatusTone(status: SessionStatus): StatusTone {
  switch (status) {
    case "requires_action":
      return "waiting";
    case "running":
      return "running";
    case "queued":
      return "queued";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}

/* --- elapsed clock ---------------------------------------------------------- */

function formatCoarseElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Elapsed time since `startIso`, ticking every second while `live`. When frozen
 * (paused/completed) it renders the span to `endIso` if given, else to the
 * moment it stopped ticking — a completed goal shows its final duration, a
 * paused one holds still.
 */
function useLiveElapsed(startIso: string | null | undefined, live: boolean, endIso?: string | null): string | null {
  const start = startIso ? Date.parse(startIso) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live]);
  if (!Number.isFinite(start)) {
    return null;
  }
  const end = live ? now : endIso ? Date.parse(endIso) : now;
  return formatCoarseElapsed((Number.isFinite(end) ? end : now) - start);
}

/* --- the floating pill ------------------------------------------------------ */

export function GoalSurface({
  session,
  goal,
  events,
  onNavigate,
}: {
  session: Session;
  goal: UseGoalResult;
  events: SessionEvent[];
  /** Called before navigating into a subagent, so the host can e.g. close panels. */
  onNavigate?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const lineage = useSessionLineage(session.id, { events });
  const children = lineage.lineage?.children ?? [];
  const record = goal.goal;
  // All hooks run unconditionally (the null-goal early return is below): the
  // elapsed clock ticks only while the goal is actively being pursued.
  const live = record?.status === "active" && session.status !== "requires_action";
  const elapsed = useLiveElapsed(
    record?.createdAt,
    Boolean(live),
    record?.status === "completed" ? record.updatedAt : null,
  );

  // Hidden entirely when the session has no goal — the pill is a goal surface,
  // not a permanent chrome element.
  if (!record) {
    return null;
  }

  const state = goalPillState(record.status, session.status);
  const meta = GOAL_PILL_META[state];
  const Icon = meta.icon;
  const canToggle = record.status !== "completed";

  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl justify-start px-4 sm:px-6">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div
            data-testid="goal-surface"
            className={cn(
              "inline-flex max-w-full items-center gap-2 rounded-full border bg-surface-2/90 py-1 pl-3 pr-1 text-xs shadow-md backdrop-blur",
              "supports-[backdrop-filter]:bg-surface-2/75",
              meta.ring,
            )}
          >
            <Icon className={cn("size-3.5 shrink-0", meta.tint)} />
            <span className={cn("shrink-0 font-medium", state === "pursuing" ? "text-fg" : meta.tint)}>{meta.label}</span>
            <span aria-hidden className="shrink-0 text-fg-subtle">·</span>
            <span className="min-w-0 truncate text-fg-muted" title={record.text}>
              {record.text}
            </span>
            {elapsed ? (
              <>
                <span aria-hidden className="shrink-0 text-fg-subtle">·</span>
                <span className="shrink-0 tabular-nums text-fg-subtle" title="Time on this goal">
                  {elapsed}
                </span>
              </>
            ) : null}

            {canToggle ? (
              <button
                type="button"
                aria-label={record.status === "paused" ? "Resume goal" : "Pause goal"}
                disabled={goal.updating}
                onClick={() => void (record.status === "paused" ? goal.resume() : goal.pause("Paused from the console"))}
                className="ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle outline-none transition-colors hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
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
                aria-label={open ? "Hide goal detail" : "Show goal detail"}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle outline-none transition-colors hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-surface-3 data-[state=open]:text-fg"
              >
                <ChevronDownIcon className="size-3.5 transition-transform data-[state=open]:rotate-180" />
              </button>
            </Popover.Trigger>
          </div>
        </Popover.Anchor>

        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className={cn(
              "z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface shadow-lg outline-none",
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[side=top]:slide-in-from-bottom-1",
            )}
          >
            <GoalDetail goal={goal} state={state} />
            <div className="border-t border-border/70 p-3">
              <SubagentSection
                workspaceId={session.workspaceId}
                lineage={children}
                loading={lineage.loading && children.length === 0}
                onNavigate={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/* --- expanded goal detail --------------------------------------------------- */

function GoalDetail({ goal, state }: { goal: UseGoalResult; state: GoalPillState }) {
  const record = goal.goal;
  if (!record) {
    return null;
  }
  const meta = GOAL_PILL_META[state];
  return (
    <div className="p-3">
      <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
        <meta.icon className={cn("size-3.5", meta.tint)} />
        {meta.label}
      </div>
      <p className="mt-1.5 text-sm leading-6 text-fg">{record.text}</p>

      {record.successCriteria ? (
        <p className="mt-2 text-xs leading-5 text-fg-muted">
          <span className="font-medium text-fg">Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {record.status === "paused" && (record.pausedReason ?? record.rationale) ? (
        <p className="mt-2 text-xs leading-5 text-status-waiting/90">Paused because {record.pausedReason ?? record.rationale}</p>
      ) : null}
      {record.status === "completed" && record.evidence ? (
        <p className="mt-2 text-xs leading-5 text-status-idle/90">Evidence {record.evidence}</p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <MetaChip dot={record.maxAutoContinuations !== null && record.autoContinuations >= record.maxAutoContinuations ? "waiting" : undefined}>
          {record.maxAutoContinuations !== null
            ? `${record.autoContinuations} of ${record.maxAutoContinuations} auto-continues`
            : `${record.autoContinuations} auto-continue${record.autoContinuations === 1 ? "" : "s"}`}
        </MetaChip>
        <MetaChip dot={record.noProgressStreak >= 2 ? "waiting" : undefined}>
          {record.noProgressStreak} stalled check{record.noProgressStreak === 1 ? "" : "s"}
        </MetaChip>
        <MetaChip>version {record.version}</MetaChip>
      </div>

      {record.status !== "completed" ? (
        <div className="mt-3 flex justify-end">
          {record.status === "active" ? (
            <Button type="button" variant="ghost" size="xs" disabled={goal.updating} onClick={() => void goal.pause("Paused from the console")}>
              {goal.updating ? <Loader2Icon className="size-3 animate-spin" /> : <PauseIcon className="size-3" />}
              Pause goal
            </Button>
          ) : (
            <Button type="button" size="xs" disabled={goal.updating} onClick={() => void goal.resume()}>
              {goal.updating ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
              Resume goal
            </Button>
          )}
        </div>
      ) : null}

      {goal.mutationError ? (
        <div className="mt-2">
          <Notice tone="failed">{goal.mutationError.message}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/* --- subagent tree (shared by the pill panel and the header chip) ----------- */

export function SubagentSection({
  workspaceId,
  lineage,
  loading,
  onNavigate,
}: {
  workspaceId: string;
  lineage: LineageNode[];
  loading: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const count = lineage.length;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
        <BotIcon className="size-3.5" />
        Subagents
        {count > 0 ? <span className="text-fg-subtle/80">· {count}</span> : null}
      </div>
      {loading ? (
        <p className="mt-2 flex items-center gap-2 px-0.5 py-1 text-xs text-fg-subtle">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading lineage
        </p>
      ) : count === 0 ? (
        <p className="mt-2 px-0.5 py-1 text-xs text-fg-subtle">No agents spawned</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-px">
          {lineage.map((node) => (
            <SubagentRow key={node.session.id} node={node} workspaceId={workspaceId} depth={0} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentRow({
  node,
  workspaceId,
  depth,
  onNavigate,
}: {
  node: LineageNode;
  workspaceId: string;
  depth: number;
  onNavigate?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const childCount = node.children.length;
  const title = node.session.title?.trim() || node.session.initialMessage?.trim() || "Untitled session";
  const tone = sessionStatusTone(node.session.status);
  const live = node.session.status === "running" || node.session.status === "queued" || node.session.status === "requires_action";

  const row = (
    <div
      className="group/agent flex h-8 items-center gap-2 rounded-md pl-1.5 pr-1 text-left text-xs text-fg-muted transition-colors hover:bg-surface-2"
      style={depth > 0 ? { marginLeft: depth * 12 } : undefined}
    >
      {childCount > 0 ? (
        <Collapsible.Trigger asChild>
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-fg-subtle outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
          </button>
        </Collapsible.Trigger>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <StatusDot tone={tone} pulse={live} className="size-1.5" />
      <Link
        to="/workspaces/$workspaceId/sessions/$sessionId"
        params={{ workspaceId, sessionId: node.session.id }}
        onClick={() => onNavigate?.()}
        title={title}
        className="min-w-0 flex-1 truncate outline-none hover:text-fg focus-visible:text-fg focus-visible:underline"
      >
        {title}
      </Link>
      {childCount > 0 ? (
        <span className="shrink-0 text-2xs tabular-nums text-fg-subtle">{childCount}</span>
      ) : null}
    </div>
  );

  if (childCount === 0) {
    return <li>{row}</li>;
  }
  return (
    <li>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        {row}
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <ul className="mt-px flex flex-col gap-px">
            {node.children.map((child) => (
              <SubagentRow key={child.session.id} node={child} workspaceId={workspaceId} depth={depth + 1} onNavigate={onNavigate} />
            ))}
          </ul>
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  );
}

/* --- header "N agents" chip (session header, shares the subagent panel) ----- */

export function SessionAgentsChip({
  workspaceId,
  nodes,
  loading = false,
}: {
  workspaceId: string;
  /** Direct children; presentational — the header owns the single lineage read. */
  nodes: LineageNode[];
  loading?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const count = nodes.length;
  if (count === 0) {
    return null;
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-2/60 px-2 py-0.5 text-2xs font-medium text-fg-muted",
            "outline-none transition-colors hover:border-border-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-fg",
          )}
        >
          <BotIcon className="size-3" />
          {count} agent{count === 1 ? "" : "s"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            "z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-3 shadow-lg outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <SubagentSection workspaceId={workspaceId} lineage={nodes} loading={loading} onNavigate={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* --- "spawned by" breadcrumb (child sessions link back to their parent) ----- */

export function SpawnedByBreadcrumb({
  workspaceId,
  parent,
}: {
  workspaceId: string;
  /** The direct parent (last ancestor), or null when this session has none. */
  parent: SessionSummary | null;
}): ReactNode {
  if (!parent) {
    return null;
  }
  const label = parent.title?.trim() || parent.initialMessage?.trim() || "manager session";
  return (
    <Link
      to="/workspaces/$workspaceId/sessions/$sessionId"
      params={{ workspaceId, sessionId: parent.id }}
      title={`Spawned by ${label}`}
      className="inline-flex min-w-0 items-center gap-1 text-2xs text-fg-subtle outline-none transition-colors hover:text-fg-muted focus-visible:text-fg-muted"
    >
      <ChevronRightIcon className="size-3 shrink-0 rotate-180" />
      <span className="min-w-0 truncate">spawned by {label}</span>
    </Link>
  );
}
