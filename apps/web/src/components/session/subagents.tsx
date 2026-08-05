// The subagent-lineage surface: the shared pieces that render a session's
// spawned workers. It is deliberately DECOUPLED from goals — a session's agent
// tree is orthogonal to whether it carries a goal. One compact tree component
// ({@link SubagentTree}) backs its single home:
//   - SessionChrome agents segment (production) — host passes SubagentTree as
//     `agentsPanel`; the dock chip opens that panel in-place.
// SpawnedByBreadcrumb is the inverse link a child session shows back to the
// manager that spawned it.
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
import { BotIcon, ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { STATUS_META, StatusDot, type StatusTone } from "@/components/ui/status-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  // Flat fleets (no grandchildren) skip the expander gutter so chrome stays dense.
  const showLead = nodes.some((node) => node.children.length > 0);
  return (
    <ul className="flex flex-col gap-px">
      {nodes.map((node) => (
        <SubagentRow
          key={node.session.id}
          node={node}
          workspaceId={workspaceId}
          depth={0}
          showLead={showLead}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

function SubagentRow({
  node,
  workspaceId,
  depth,
  showLead,
  onNavigate,
}: {
  node: LineageNode;
  workspaceId: string;
  depth: number;
  showLead: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const title =
    node.session.title?.trim() || node.session.initialMessage?.trim() || "Untitled session";
  const paused = node.session.effectiveControl.state === "paused";
  const tone = paused ? "waiting" : sessionStatusTone(node.session.status);
  const live = !paused && isLiveStatus(node.session.status);
  const canExpand = depth < MAX_DEPTH && node.children.length > 0;

  // The trailing hint stays calm and compact for the common case (relative
  // time), and turns loud ONLY for the two rows a manager must act on: a failed
  // agent and one waiting on you spell the word out in their own status tone, so
  // they don't hide behind a color dot in a long list.
  const attentionWord =
    node.session.status === "failed"
      ? "Failed"
      : node.session.status === "requires_action"
        ? "Needs you"
        : paused
          ? "Paused"
          : null;
  const hint = attentionWord ?? formatRelativeTime(node.session.updatedAt);
  const hintClass = attentionWord ? cn(STATUS_META[tone].text, "font-medium") : "text-fg-subtle";

  return (
    <li>
      {/* The container owns the hover wash + focus ring so the WHOLE row lights
          as one target; the Link inside covers dot→title→hint (the nav hit
          area), the chevron toggles without navigating. */}
      <div className="group/row flex h-7 items-center gap-1.5 rounded-md pr-1.5 transition-colors hover:bg-surface-2 has-[a:focus-visible]:bg-surface-2">
        {/* Lead cluster: expand chevron + child-count. Omitted entirely for
            flat fleets so the chrome agents panel stays dense. */}
        {showLead ? (
          <span className="flex w-7 shrink-0 items-center gap-0.5">
            {canExpand ? (
              <>
                <button
                  type="button"
                  aria-label={open ? "Collapse" : "Expand"}
                  onClick={() => setOpen((prev) => !prev)}
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded text-fg-subtle/50 outline-none transition-colors hover:text-fg group-hover/row:text-fg-subtle focus-visible:text-fg"
                >
                  <ChevronRightIcon
                    className={cn("size-3 transition-transform", open && "rotate-90")}
                  />
                </button>
                <span className="text-2xs leading-none tabular-nums text-fg-subtle/60">
                  {node.children.length}
                </span>
              </>
            ) : null}
          </span>
        ) : null}
        <Link
          to="/workspaces/$workspaceId/sessions/$sessionId"
          params={{ workspaceId, sessionId: node.session.id }}
          onClick={() => onNavigate?.()}
          title={title}
          className="flex min-w-0 flex-1 items-center gap-2 text-xs text-fg-muted outline-none group-hover/row:text-fg"
        >
          <StatusDot tone={tone} pulse={live} className="size-1.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {hint ? (
            <span className={cn("shrink-0 text-2xs tabular-nums", hintClass)}>{hint}</span>
          ) : null}
        </Link>
      </div>
      {canExpand && open ? (
        // Grandchildren thread off a hairline rail aligned under the parent's
        // chevron column — a descending line, not a box.
        <ul className="ml-2 mt-px flex flex-col gap-px border-l border-border/60 pl-2.5">
          {node.children.map((child) => (
            <SubagentRow
              key={child.session.id}
              node={child}
              workspaceId={workspaceId}
              depth={depth + 1}
              showLead={showLead}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The quiet section label both homes wear above the tree. */
export function SubagentsLabel({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
      <BotIcon className="size-3.5" />
      Agents
      {count > 0 ? <span className="text-fg-subtle/70">· {count}</span> : null}
    </div>
  );
}

/* --- "spawned by" breadcrumb (child sessions link back to their parent) ----- */

export function SessionAncestryBreadcrumb({
  workspaceId,
  parentSessionId,
  ancestors,
  loading,
  error,
}: {
  workspaceId: string;
  /** Known from the current session even before the lineage request settles. */
  parentSessionId: string | null;
  /** Root-to-direct-parent order. */
  ancestors: SessionSummary[];
  loading?: boolean;
  error?: Error | null;
}): ReactNode {
  if (parentSessionId && (loading || error)) {
    const state = error ? "unavailable" : "loading";
    return (
      <nav
        aria-label="Session ancestry"
        className="flex min-w-0 items-center text-2xs text-fg-muted"
      >
        <Link
          to="/workspaces/$workspaceId/sessions/$sessionId"
          params={{ workspaceId, sessionId: parentSessionId }}
          aria-label={`Back to parent session; ancestry ${state}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1 outline-none transition-colors hover:text-fg focus-visible:text-fg"
        >
          <ChevronRightIcon className="size-3 shrink-0 rotate-180" />
          <span className={error ? "truncate text-status-failed" : "truncate"}>
            Back · Parent {state}
          </span>
        </Link>
      </nav>
    );
  }
  if (error) {
    return <span className="text-2xs text-status-failed">Session ancestry unavailable</span>;
  }
  if (ancestors.length === 0) {
    return null;
  }
  const parent = ancestors.at(-1)!;
  const parentLabel = lineageLabel(parent);
  const middle = ancestors.slice(1, -1);
  return (
    <nav aria-label="Session ancestry" className="flex min-w-0 items-center text-2xs text-fg-muted">
      <Link
        to="/workspaces/$workspaceId/sessions/$sessionId"
        params={{ workspaceId, sessionId: parent.id }}
        aria-label={`Back to ${parentLabel}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1 outline-none transition-colors hover:text-fg focus-visible:text-fg sm:hidden"
      >
        <ChevronRightIcon className="size-3 shrink-0 rotate-180" />
        <span className="shrink-0 font-medium text-fg">Back ·</span>
        <bdi dir="auto" className="min-w-0 truncate">
          {parentLabel}
        </bdi>
      </Link>
      <div className="hidden min-w-0 items-center sm:flex">
        <BreadcrumbLink workspaceId={workspaceId} session={ancestors[0]!} />
        {middle.length > 0 ? (
          <>
            <ChevronRightIcon className="mx-0.5 size-3 shrink-0 text-fg-subtle" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
                  aria-label={`${middle.length} intermediate ancestor sessions`}
                >
                  <EllipsisIcon className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-80">
                {middle.map((session) => (
                  <DropdownMenuItem key={session.id} asChild>
                    <Link
                      to="/workspaces/$workspaceId/sessions/$sessionId"
                      params={{ workspaceId, sessionId: session.id }}
                      dir="auto"
                      className="min-w-0"
                    >
                      {lineageLabel(session)}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
        {ancestors.length > 1 ? (
          <>
            <ChevronRightIcon className="mx-0.5 size-3 shrink-0 text-fg-subtle" />
            <BreadcrumbLink workspaceId={workspaceId} session={parent} />
          </>
        ) : null}
      </div>
    </nav>
  );
}

function BreadcrumbLink({
  workspaceId,
  session,
}: {
  workspaceId: string;
  session: SessionSummary;
}) {
  const label = lineageLabel(session);
  return (
    <Link
      to="/workspaces/$workspaceId/sessions/$sessionId"
      params={{ workspaceId, sessionId: session.id }}
      title={label}
      dir="auto"
      className="max-w-40 truncate outline-none transition-colors hover:text-fg focus-visible:text-fg"
    >
      {label}
    </Link>
  );
}

function lineageLabel(session: SessionSummary): string {
  return session.title?.trim() || session.initialMessage?.trim() || "Untitled session";
}
