// The subagent-lineage surface: everything that renders a session's spawned
// workers. It is deliberately DECOUPLED from goals — a session's agent tree is
// orthogonal to whether it carries a goal, so this lives in its own module and
// backs three homes:
//   - AgentsPanel     — the first-class "Agents" dock tab (the primary home)
//   - SessionAgentsChip — the header "N agents" chip + popover
//   - SubagentSection / SubagentRow — the shared tree the two reuse
// plus SpawnedByBreadcrumb, the inverse link a child session shows back to the
// manager that spawned it.
//
// Copy doctrine: human language only. Internal status slugs (requires_action,
// active, …) are translated to plain labels at this boundary; no enum leaks
// into a rendered string.
import type { LineageNode, SessionStatus, SessionSummary } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { Collapsible, Popover } from "radix-ui";
import { useState, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

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

/* --- subagent tree (shared by the dock panel and the header chip) ----------- */

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

/* --- the Agents dock tab (first-class, decoupled home for the lineage) ------- */

/**
 * The full-height lineage tree for the right dock's "Agents" tab — the primary,
 * goal-independent place to see and deep-link into the workers a session spawned.
 * Presentational: the dock owns the single {@link useSessionLineage} read (so the
 * tab count and this panel stay one source of truth) and feeds children in. The
 * tab is hidden when a session has no children, so the empty state here is a
 * belt-and-suspenders fallback that should not normally be reached.
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
      <div className="min-w-0 p-3">
        <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
          <BotIcon className="size-3.5" />
          Agents spawned
          {count > 0 ? <span className="text-fg-subtle/80">· {count}</span> : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-fg-subtle">
          Workers this session spawned. Open one to follow its own run.
        </p>
        {loading && count === 0 ? (
          <p className="mt-3 flex items-center gap-2 px-0.5 py-1 text-xs text-fg-subtle">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading lineage
          </p>
        ) : count === 0 ? (
          <p className="mt-3 px-0.5 py-1 text-xs text-fg-subtle">No agents spawned yet.</p>
        ) : (
          <ul className="mt-2.5 flex flex-col gap-px">
            {nodes.map((node) => (
              <SubagentRow key={node.session.id} node={node} workspaceId={workspaceId} depth={0} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </div>
    </ScrollArea>
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
