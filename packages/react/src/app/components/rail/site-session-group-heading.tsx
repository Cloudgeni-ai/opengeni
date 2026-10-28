import { createContext, useContext } from "react";
import { Link } from "../../lib/navigation";
import {
  ArchiveIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
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
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { visualTreeDepth } from "../../lib/session-rail";
import type { RailAggregateStatus } from "../../lib/sessions-group";
import type { SessionSiteOrigin } from "../../lib/session-site-origin";
import type { Channel } from "../../types";

/**
 * Pin and archive for Site rows, in this person's own sidebar. Archive only
 * hides the row; the Site stays published. Absent where the client cannot
 * change sidebar state, and then the row offers no actions. Move files the
 * row in another project (null is Default), like a chat; absent where the
 * client predates it.
 */
export type SiteRowActions = {
  pin: (origin: SessionSiteOrigin, pinned: boolean) => void;
  archive: (origin: SessionSiteOrigin) => void;
  move?:
    | ((origin: SessionSiteOrigin, fromChannelId: string | null, channelId: string | null) => void)
    | undefined;
};
export const SiteRowActionsContext = createContext<SiteRowActions | null>(null);

/** Drag payload of a Site row: `{ siteId, title, channelId }` as JSON. */
export const SITE_DRAG_TYPE = "application/x-opengeni-site";

export type SiteRowDragPayload = { siteId: string; title: string; channelId: string | null };

export function readSiteRowDragPayload(value: string): SiteRowDragPayload | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { siteId, title, channelId } = parsed as Record<string, unknown>;
    if (
      typeof siteId !== "string" ||
      typeof title !== "string" ||
      (channelId !== null && typeof channelId !== "string")
    )
      return null;
    return { siteId, title, channelId };
  } catch {
    return null;
  }
}

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
  channelId,
  channels,
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
  /** The project this row is in (null is Default); undefined when it stands for every project. */
  channelId?: string | null | undefined;
  /** Projects it can move to, as offered for chats. */
  channels?: readonly Channel[] | undefined;
}) {
  const actions = useContext(SiteRowActionsContext);
  const move = actions?.move;
  // As for a chat row: listed only when there is a project to choose.
  const moveTargets =
    move && channelId !== undefined && channels && channels.length > 0
      ? [{ id: null, name: "Default" }, ...channels]
      : [];
  const canMove = moveTargets.length > 0;
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
        // Drag onto a project to move the row there, like a chat row.
        draggable={canMove}
        onDragStart={(event) => {
          if (!canMove) {
            event.preventDefault();
            return;
          }
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            SITE_DRAG_TYPE,
            JSON.stringify({
              siteId: origin.siteId,
              title: origin.title,
              channelId: channelId ?? null,
            } satisfies SiteRowDragPayload),
          );
        }}
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
              {canMove ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Move to project</DropdownMenuLabel>
                  {moveTargets.map((channel) => {
                    const current = (channelId ?? null) === channel.id;
                    return (
                      <DropdownMenuItem
                        key={channel.id ?? "default"}
                        aria-current={current ? "true" : undefined}
                        onSelect={() => {
                          if (!current) move?.(origin, channelId ?? null, channel.id);
                        }}
                      >
                        <FolderIcon aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                        <DropdownMenuCheck checked={current} />
                      </DropdownMenuItem>
                    );
                  })}
                </>
              ) : null}
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
        {canMove ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel>Move to project</ContextMenuLabel>
            {moveTargets.map((channel) => {
              const current = (channelId ?? null) === channel.id;
              return (
                <ContextMenuItem
                  key={channel.id ?? "default"}
                  aria-current={current ? "true" : undefined}
                  onSelect={() => {
                    if (!current) move?.(origin, channelId ?? null, channel.id);
                  }}
                >
                  <FolderIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  <DropdownMenuCheck checked={current} />
                </ContextMenuItem>
              );
            })}
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
