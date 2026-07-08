// The subagent-lineage surface: everything that renders a session's spawned
// workers. It is deliberately DECOUPLED from goals — a session's agent tree is
// orthogonal to whether it carries a goal — and one compact tree component backs
// two sibling homes:
//   - SessionAgentsChip — the header "N agents" chip that EXPANDS into a floating
//     panel, mirroring the goal pill's click-to-expand interaction + elevated
//     visual family (the glanceable, quick-jump hero).
//   - AgentsPanel — the persistent, roomy "Agents" right-dock tab (the deep view
//     a manager watches while orchestrating many workers).
// Both render {@link SubagentTree}: the compact form in the popover, the
// full-height form in the dock. SpawnedByBreadcrumb is the inverse link a child
// session shows back to the manager that spawned it.
//
// Design language: one dense line per agent — a single status-tone dot + a
// truncated title + a quiet relative-time hint — the whole row a hover-lit
// deep-link. Grandchildren thread off a hairline rail (one level, expandable),
// never boxes. Calm at rest; the chevron affordance lifts on hover.
//
// Copy doctrine: human language only. Internal status slugs (requires_action,
// active, …) never leak into a rendered string.
import { formatRelativeTime } from "@opengeni/react";
import type { LineageNode, SessionStatus, SessionSummary } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { Popover } from "radix-ui";
import { useState, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { STATUS_META, StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

/** Children (depth 0) plus one level of grandchildren (depth 1) — the tree goes
    exactly one level deeper, so a depth-1 row never draws its own expander. */
const MAX_DEPTH = 1;

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

function isLiveStatus(status: SessionStatus): boolean {
  return status === "running" || status === "queued" || status === "requires_action";
}

/* --- the shared compact tree ------------------------------------------------ */

/** The lineage tree, shared verbatim by the chip popover and the dock tab. */
export function SubagentTree({
  workspaceId,
  nodes,
  onNavigate,
}: {
  workspaceId: string;
  nodes: LineageNode[];
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <ul className="flex flex-col gap-px">
      {nodes.map((node) => (
        <SubagentRow key={node.session.id} node={node} workspaceId={workspaceId} depth={0} onNavigate={onNavigate} />
      ))}
    </ul>
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
  const title = node.session.title?.trim() || node.session.initialMessage?.trim() || "Untitled session";
  const tone = sessionStatusTone(node.session.status);
  const live = isLiveStatus(node.session.status);
  const canExpand = depth < MAX_DEPTH && node.children.length > 0;

  // The trailing hint stays calm and compact for the common case (relative
  // time), and turns loud ONLY for the two rows a manager must act on: a failed
  // agent and one waiting on you spell the word out in their own status tone, so
  // they don't hide behind a color dot in a long list.
  const attentionWord =
    node.session.status === "failed" ? "Failed" : node.session.status === "requires_action" ? "Needs you" : null;
  const hint = attentionWord ?? formatRelativeTime(node.session.updatedAt);
  const hintClass = attentionWord ? cn(STATUS_META[tone].text, "font-medium") : "text-fg-subtle";

  return (
    <li>
      {/* The container owns the hover wash + focus ring so the WHOLE row lights
          as one target; the Link inside covers dot→title→hint (the nav hit
          area), the chevron toggles without navigating. */}
      <div className="group/row flex h-7 items-center gap-1.5 rounded-md pr-1.5 transition-colors hover:bg-surface-2 has-[a:focus-visible]:bg-surface-2">
        {/* Lead cluster: the expand chevron + child-count grouped as the "has N
            children" affordance, at a fixed width so every dot column lines up
            whether or not a row has children. */}
        <span className="flex w-7 shrink-0 items-center gap-0.5">
          {canExpand ? (
            <>
              <button
                type="button"
                aria-label={open ? "Collapse" : "Expand"}
                onClick={() => setOpen((prev) => !prev)}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded text-fg-subtle/50 outline-none transition-colors hover:text-fg group-hover/row:text-fg-subtle focus-visible:text-fg"
              >
                <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
              </button>
              <span className="text-2xs leading-none tabular-nums text-fg-subtle/60">{node.children.length}</span>
            </>
          ) : null}
        </span>
        <Link
          to="/workspaces/$workspaceId/sessions/$sessionId"
          params={{ workspaceId, sessionId: node.session.id }}
          onClick={() => onNavigate?.()}
          title={title}
          className="flex min-w-0 flex-1 items-center gap-2 text-xs text-fg-muted outline-none group-hover/row:text-fg"
        >
          <StatusDot tone={tone} pulse={live} className="size-1.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {hint ? <span className={cn("shrink-0 text-2xs tabular-nums", hintClass)}>{hint}</span> : null}
        </Link>
      </div>
      {canExpand && open ? (
        // Grandchildren thread off a hairline rail aligned under the parent's
        // chevron column — a descending line, not a box.
        <ul className="ml-2 mt-px flex flex-col gap-px border-l border-border/60 pl-2.5">
          {node.children.map((child) => (
            <SubagentRow key={child.session.id} node={child} workspaceId={workspaceId} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The quiet section label both homes wear above the tree. */
function SubagentsLabel({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
      <BotIcon className="size-3.5" />
      Subagents
      {count > 0 ? <span className="text-fg-subtle/70">· {count}</span> : null}
    </div>
  );
}

function LineageLoading() {
  return (
    <p className="flex items-center gap-2 px-0.5 py-1 text-xs text-fg-subtle">
      <Loader2Icon className="size-3.5 animate-spin" />
      Loading lineage
    </p>
  );
}

/* --- the Agents dock tab (persistent, full-height home) --------------------- */

/**
 * The full-height lineage tree for the right dock's "Agents" tab — the deep,
 * goal-independent workspace for a manager actively orchestrating workers, live
 * as agents spawn and change status. Presentational: the dock owns the single
 * {@link useSessionLineage} read (so the tab count and this panel stay one
 * source of truth) and feeds children in. The tab is hidden when a session has
 * no children, so the empty state here is a belt-and-suspenders fallback.
 */
export function AgentsPanel({
  workspaceId,
  nodes,
  loading,
  onNavigate,
}: {
  workspaceId: string;
  nodes: LineageNode[];
  loading: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const count = nodes.length;
  return (
    <ScrollArea className="h-full min-w-0">
      <div className="min-w-0 p-2.5">
        <SubagentsLabel count={count} />
        {loading && count === 0 ? (
          <div className="mt-2">
            <LineageLoading />
          </div>
        ) : count === 0 ? (
          <p className="mt-2 px-0.5 py-1 text-xs text-fg-subtle">No agents spawned yet.</p>
        ) : (
          <div className="mt-2">
            <SubagentTree workspaceId={workspaceId} nodes={nodes} onNavigate={onNavigate} />
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

/* --- header "N agents" chip → expands into the goal-pill-family panel -------- */

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
            "outline-none transition-colors hover:border-border-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border-strong data-[state=open]:text-fg",
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
            // Same elevated family as the goal-pill panel (rounded-xl / border /
            // shadow-lg / surface), just opening DOWNWARD from the header; a tall
            // lineage scrolls inside rather than overflowing the viewport.
            "z-50 flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-y-auto overscroll-contain",
            "rounded-xl border border-border bg-surface shadow-lg outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[side=bottom]:slide-in-from-top-1",
          )}
        >
          <div className="p-2.5">
            <SubagentsLabel count={count} />
            {loading && count === 0 ? (
              <div className="mt-2">
                <LineageLoading />
              </div>
            ) : (
              <div className="mt-2">
                <SubagentTree workspaceId={workspaceId} nodes={nodes} onNavigate={() => setOpen(false)} />
              </div>
            )}
          </div>
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
