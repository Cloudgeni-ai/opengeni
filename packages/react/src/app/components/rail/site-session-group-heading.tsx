import { createContext, useContext } from "react";
import { Link } from "../../lib/navigation";
import {
  ArchiveIcon,
  ChevronRightIcon,
  EllipsisIcon,
  PanelsTopLeftIcon,
  PinIcon,
} from "lucide-react";
import { RailTrailingMetadata } from "./session-row-content";
import {
  RAIL_ROW_OVERFLOW_TRIGGER_CLASS,
  RAIL_ROW_QUICK_ACTIONS_CLASS,
  RailRowQuickAction,
} from "./rail-row-quick-actions";
import { Button } from "../../../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { visualTreeDepth } from "../../lib/session-rail";
import type { RailAggregateStatus } from "../../lib/sessions-group";
import type { SessionSiteOrigin } from "../../lib/session-site-origin";

/**
 * Pin and archive for Site rows, in this person's own sidebar. Archive only
 * hides the row; the Site stays published. Absent where the client cannot
 * change sidebar state, and then the row offers no actions.
 */
export type SiteRowActions = {
  pin: (origin: SessionSiteOrigin, pinned: boolean) => void;
  archive: (origin: SessionSiteOrigin) => void;
};
export const SiteRowActionsContext = createContext<SiteRowActions | null>(null);

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
  pinned = false,
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
  /** This person pinned the Site in their sidebar. */
  pinned?: boolean | undefined;
}) {
  const actions = useContext(SiteRowActionsContext);
  const conversations = `${count} ${count === 1 ? "conversation" : "conversations"}`;
  // A Site without conversations is a plain row: nothing to disclose.
  const disclosable = count > 0 || expanded;
  const pinLabel = pinned ? "Unpin" : "Pin";
  const row = (
    <div
      data-site-row={origin.siteId}
      data-site-pinned={pinned ? "" : undefined}
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
        // Without conversations there is no status to announce.
        aria-label={`Open ${origin.title}. Site${pinned ? ". Pinned" : ""}${count > 0 ? `, ${conversations}. ${summary.label}` : ""}`}
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
        <RailTrailingMetadata
          summary={summary}
          relativeTime={relativeTime}
          quickActionSlots={actions ? 2 : 0}
        />
      </Link>
      {actions ? (
        <>
          <div className={RAIL_ROW_QUICK_ACTIONS_CLASS} data-site-quick-actions={origin.siteId}>
            <RailRowQuickAction
              label={`${pinLabel} Site`}
              tooltip={pinLabel}
              data-site-actions={origin.siteId}
              data-site-action="pin"
              onActivate={() => actions.pin(origin, !pinned)}
            >
              <PinIcon className={pinned ? "size-3.5 fill-current" : "size-3.5"} />
            </RailRowQuickAction>
            <RailRowQuickAction
              label="Archive Site"
              tooltip="Archive"
              data-site-actions={origin.siteId}
              data-site-action="archive"
              onActivate={() => actions.archive(origin)}
            >
              <ArchiveIcon className="size-3.5" />
            </RailRowQuickAction>
          </div>
          {/* Touch has no hover or right-click: the same actions in a menu. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${origin.title}`}
                data-site-actions={origin.siteId}
                data-site-actions-mode="overflow"
                className={RAIL_ROW_OVERFLOW_TRIGGER_CLASS}
              >
                <EllipsisIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40" data-site-menu={origin.siteId}>
              <DropdownMenuItem onSelect={() => actions.pin(origin, !pinned)}>
                <PinIcon className={pinned ? "size-4 fill-current" : "size-4"} />
                {pinLabel}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.archive(origin)}>
                <ArchiveIcon className="size-4" />
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </div>
  );
  if (!actions) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40" data-site-menu={origin.siteId}>
        <ContextMenuItem onSelect={() => actions.pin(origin, !pinned)}>
          <PinIcon className={pinned ? "size-4 fill-current" : "size-4"} />
          {pinLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.archive(origin)}>
          <ArchiveIcon className="size-4" />
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
