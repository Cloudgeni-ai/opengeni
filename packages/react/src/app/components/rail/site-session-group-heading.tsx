import { Link } from "../../lib/navigation";
import { ChevronRightIcon, PanelsTopLeftIcon } from "lucide-react";
import { RailTrailingMetadata } from "./session-row-content";
import { cn } from "../../lib/utils";
import { visualTreeDepth } from "../../lib/session-rail";
import type { RailAggregateStatus } from "../../lib/sessions-group";
import type { SessionSiteOrigin } from "../../lib/session-site-origin";

/** A Site's row in the rail: open the Site view, or disclose its conversations. */
export function SiteSessionGroupHeading({
  origin,
  workspaceId,
  expanded,
  onToggle,
  summary,
  count,
  relativeTime,
  depth = 0,
  active = false,
}: {
  origin: SessionSiteOrigin;
  workspaceId: string;
  expanded: boolean;
  onToggle: () => void;
  summary: RailAggregateStatus;
  /** Conversations behind the row, loaded or not. */
  count: number;
  relativeTime?: string | undefined;
  depth?: number | undefined;
  active?: boolean | undefined;
}) {
  const conversations = `${count} ${count === 1 ? "conversation" : "conversations"}`;
  // A Site without conversations is a plain row: nothing to disclose.
  const disclosable = count > 0 || expanded;
  return (
    <div
      data-site-row={origin.siteId}
      className={cn(
        "group relative flex h-8 w-full items-center gap-1.5 rounded-md border py-1 pr-1 pl-1.5 text-left text-sm pointer-coarse:h-11 pointer-coarse:py-0",
        active
          ? "border-brand/20 bg-selection text-fg"
          : "border-transparent text-fg-label hover:bg-hover hover:text-fg",
      )}
    >
      <span
        className="flex w-4 shrink-0 items-center"
        style={depth > 0 ? { marginLeft: visualTreeDepth(depth) * 12 } : undefined}
      >
        {disclosable ? (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${conversations} from ${origin.title}`}
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-muted outline-hidden hover:text-fg focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : null}
      </span>
      <Link
        to="/workspaces/$workspaceId/sites/$siteId"
        params={{ workspaceId, siteId: origin.siteId }}
        // The Site is the open page only while none of its conversations is.
        activeOptions={{ exact: true, includeSearch: true }}
        aria-current={active ? "page" : undefined}
        aria-label={`Open ${origin.title}. Site${count > 0 ? `, ${conversations}` : ""}. ${summary.label}`}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
      >
        <PanelsTopLeftIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
        <span className="min-w-0 truncate">{origin.title}</span>
        {count > 0 ? (
          <span aria-hidden="true" className="shrink-0 text-xs tabular-nums text-fg-subtle">
            {count}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <RailTrailingMetadata summary={summary} relativeTime={relativeTime} />
      </Link>
    </div>
  );
}
