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
import { t } from "../../lib/console-text";
import { formatRelativeTime } from "../../../lib/format";
import { sessionDisplayStatus, type SessionDisplayStatus } from "../../../timeline-model";
import { sessionAgentAttention } from "../../../session-agents-model";
import type { LineageNode, SessionStatus, SessionSummary } from "@opengeni/sdk";
import { Link } from "../../lib/navigation";
import { BotIcon, ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { STATUS_META, StatusDot, type StatusTone } from "../../../ui/status-dot";
import { sessionDisplayTitle } from "../../lib/session-rename";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { sessionControlPaused } from "../../lib/session-rail";

/** Children (depth 0) plus one level of grandchildren (depth 1) — the tree goes
    exactly one level deeper, so a depth-1 row never draws its own expander. */
const MAX_DEPTH = 1;

/**
 * The loud trailing word for a row a manager must act on. A child waiting on a
 * human also says for HOW LONG ("Needs you · 10h", from the server's
 * `requiresActionSince`), so a parked child is visible at a glance and the row
 * links straight to where the human answers. Null for calm rows.
 */
export function subagentAttentionHint(
  session: Pick<SessionSummary, "status" | "requiresActionSince" | "admissionBlock">,
  paused: boolean,
  now: Date = new Date(),
): { word: string; waitingFor: string; title?: string | undefined } | null {
  const attention = sessionAgentAttention(t, session, paused, now);
  if (!attention) return null;
  const { tone: _tone, ...hint } = attention;
  return hint;
}

/** Map a session lifecycle status onto the six-tone status language. */
export function sessionStatusTone(status: SessionDisplayStatus): StatusTone {
  switch (status) {
    case "requires_action":
      return "waiting";
    case "blocked":
      return "failed";
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
  return status === "running";
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
  const title = sessionDisplayTitle(node.session);
  const paused = sessionControlPaused(node.session);
  const tone = paused ? "waiting" : sessionStatusTone(sessionDisplayStatus(node.session));
  const live = !paused && isLiveStatus(node.session.status);
  const canExpand = depth < MAX_DEPTH && node.children.length > 0;

  // The trailing hint stays calm and compact for the common case (relative
  // time), and turns loud ONLY for the two rows a manager must act on: a failed
  // agent and one waiting on you spell the word out in their own status tone, so
  // they don't hide behind a color dot in a long list.
  const attention = subagentAttentionHint(node.session, paused);
  const attentionWord = attention?.word ?? null;
  const hint = attentionWord ?? formatRelativeTime(t, node.session.updatedAt);
  const hintClass = attentionWord ? cn(STATUS_META[tone].text, "font-medium") : "text-fg-subtle";
  const hintTitle = attention?.title;
  const waitingFor = attention?.waitingFor ?? "";

  return (
    <li>
      {/* The container owns the hover wash + focus ring so the WHOLE row lights
          as one target; the Link inside covers dot→title→hint (the nav hit
          area), the chevron toggles without navigating. */}
      <div className="group/row flex h-7 items-center gap-1.5 rounded-md pr-1.5 transition-colors hover:bg-surface-2 has-[a:focus-visible]:bg-surface-2 max-sm:h-11">
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
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded text-fg-subtle/50 outline-hidden transition-colors hover:text-fg group-hover/row:text-fg-subtle focus-visible:text-fg max-sm:size-11"
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
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-xs text-fg-muted outline-hidden group-hover/row:text-fg"
        >
          <StatusDot tone={tone} pulse={live} className="size-1.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {hint ? (
            <span
              className={cn("shrink-0 text-2xs tabular-nums", hintClass)}
              title={hintTitle}
              data-subagent-waiting={waitingFor || undefined}
            >
              {hint}
            </span>
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
    <div className="flex items-center gap-1.5 px-1.5 pt-1 text-xs leading-4.5 font-medium text-fg-muted">
      <BotIcon className="size-3.5" />
      Agents
      {count > 0 ? <span className="tabular-nums">· {count}</span> : null}
    </div>
  );
}

/* --- "spawned by" breadcrumb (child sessions link back to their parent) ----- */

/**
 * The header gives the breadcrumb and the title equal shares of a crowded
 * row, so neither squeezes the other to nothing; the parent's name truncates
 * within its share. Phones, narrow headers and a narrow title area
 * (`titlegroup`) show only an arrow back to the parent.
 */
const CRUMB_NAV = "flex min-w-0 items-center text-xs";
const WIDE_CRUMB =
  "hidden min-w-0 items-center gap-0.5 sm:flex @max-[34rem]/titlebar:hidden! @max-[20rem]/titlegroup:hidden!";
const NARROW_CRUMB =
  "inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-muted outline-hidden transition-colors hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/55 pointer-coarse:size-11 sm:hidden @max-[34rem]/titlebar:inline-flex! @max-[20rem]/titlegroup:inline-flex!";
const CRUMB_LINK =
  "block min-w-0 max-w-40 truncate outline-hidden transition-colors hover:text-fg focus-visible:text-fg";

function CrumbSeparator() {
  return <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-fg-subtle" />;
}

/**
 * Where a child chat came from, leading into its title on the header's single
 * row: "… › Release manager ›" before the title. The direct parent is a link
 * and earlier ancestors sit in a menu; narrow headers keep a back arrow named
 * for the parent.
 */
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
  loading?: boolean | undefined;
  error?: Error | null | undefined;
}): ReactNode {
  if (parentSessionId && (loading || error)) {
    const state = error ? "unavailable" : "loading";
    const href = { workspaceId, sessionId: parentSessionId };
    return (
      <nav aria-label="Session ancestry" className={CRUMB_NAV}>
        <Link
          to="/workspaces/$workspaceId/sessions/$sessionId"
          params={href}
          aria-label={`Back to parent session; ancestry ${state}`}
          className={NARROW_CRUMB}
        >
          <ChevronRightIcon aria-hidden className="size-3.5 rotate-180" />
        </Link>
        <span className={WIDE_CRUMB}>
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={href}
            aria-label={`Back to parent session; ancestry ${state}`}
            className={cn(CRUMB_LINK, error ? "text-status-failed" : "text-fg-muted")}
          >
            Parent {state}
          </Link>
          <CrumbSeparator />
        </span>
      </nav>
    );
  }
  if (error) {
    return (
      <span className="shrink-0 text-xs text-status-failed">Session ancestry unavailable</span>
    );
  }
  if (ancestors.length === 0) {
    return null;
  }
  const parent = ancestors.at(-1)!;
  const parentLabel = lineageLabel(parent);
  const earlier = ancestors.slice(0, -1);
  return (
    <nav aria-label="Session ancestry" className={cn(CRUMB_NAV, "text-fg-muted")}>
      <Link
        to="/workspaces/$workspaceId/sessions/$sessionId"
        params={{ workspaceId, sessionId: parent.id }}
        aria-label={`Back to ${parentLabel}`}
        title={parentLabel}
        className={NARROW_CRUMB}
      >
        <ChevronRightIcon aria-hidden className="size-3.5 rotate-180" />
      </Link>
      <div className={WIDE_CRUMB}>
        {earlier.length > 0 ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
                  aria-label={
                    earlier.length === 1
                      ? "1 earlier session"
                      : `${earlier.length} earlier sessions`
                  }
                >
                  <EllipsisIcon className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-80">
                {earlier.map((session) => (
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
            <CrumbSeparator />
          </>
        ) : null}
        <BreadcrumbLink workspaceId={workspaceId} session={parent} />
        <CrumbSeparator />
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
      className={CRUMB_LINK}
    >
      {label}
    </Link>
  );
}

function lineageLabel(session: SessionSummary): string {
  return sessionDisplayTitle(session);
}
