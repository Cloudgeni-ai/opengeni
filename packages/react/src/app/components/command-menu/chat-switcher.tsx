/**
 * The Control+Tab chat switcher's list: recently viewed chats in the middle of
 * the window while Control is held. The actions provider owns the keys and
 * the selection; this only draws it. Focus never moves here, so releasing
 * Control (and the chat being switched to) behaves exactly as without it.
 */
import { MessageSquareIcon, PinIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ChatRecord } from "../../lib/actions/chat-directory";
import { readChatDirectory, useChatDirectoryVersion } from "../../lib/actions/chat-directory";
import type { ChatSwitcherState } from "../../lib/actions/chat-switcher";
import type { ChordPlatform } from "../../lib/actions/chords";
import type { WorkspaceChoice } from "../../lib/actions/registry";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../../ui/relative-time";
import { currentChatStatus } from "../../lib/actions/chat-status";
import { ChatStatusMarks, useChatStatusRefresh } from "./chat-status";
import { Keycaps } from "./keycaps";
import { WorkspaceTag } from "./workspace-tag";

function chatIcon(record: ChatRecord | undefined): LucideIcon {
  return record?.pinned ? PinIcon : MessageSquareIcon;
}

export default function ChatSwitcher(props: {
  state: ChatSwitcherState;
  subjectId: string;
  workspaceId: string;
  workspaces: readonly WorkspaceChoice[];
  currentChatId: string | null;
  platform: ChordPlatform;
  onHover(index: number): void;
  onPick(index: number): void;
  onDismiss(): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const { index, visible } = props.state;
  // Read statuses as soon as Control+Tab is pressed, before the list shows.
  useChatStatusRefresh({
    subjectId: props.subjectId,
    workspaceId: props.workspaceId,
    ids: props.state.ids,
    active: true,
  });
  useChatDirectoryVersion(props.subjectId);
  useEffect(() => {
    if (!visible) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-switcher-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index, visible]);
  if (!visible || typeof document === "undefined") return null;
  const directory = readChatDirectory(props.subjectId, props.workspaceId);
  const now = Date.now();
  const sidebarIds = new Set([...directory.sidebarOrder, ...directory.pinnedOrder]);
  const workspaceNames = new Map(
    props.workspaces.map((workspace) => [workspace.id, workspace.name]),
  );
  const activeId = `og-chat-switcher-${index}`;
  return createPortal(
    <div
      data-og-chat-switcher=""
      // A light dim, as under ⌘K, lifts the list off the chat behind it.
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/15 p-4 animate-in fade-in-0 duration-[100ms] dark:bg-black/40"
      // A click outside the list puts it away without switching.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onDismiss();
      }}
    >
      <div
        className={cn(
          "flex max-h-[min(480px,70dvh)] w-full max-w-[440px] flex-col overflow-hidden",
          "rounded-2xl border border-border bg-surface text-fg shadow-og-lg",
          "animate-in fade-in-0 zoom-in-98 duration-[100ms]",
        )}
      >
        <div className="px-4 pt-3 pb-1 text-xs leading-4.5 font-medium text-fg-muted">
          Recent chats
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Recent chats"
          aria-activedescendant={activeId}
          className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5"
        >
          {props.state.ids.map((id, position) => {
            const record = directory.rows.get(id);
            const Icon = chatIcon(record);
            const selected = position === index;
            const meta =
              id === props.currentChatId
                ? "Open now"
                : record?.updatedAt
                  ? formatRelativeTime(record.updatedAt, { now })
                  : undefined;
            // Chats in other workspaces say where they are.
            const elsewhere =
              record && record.workspaceId !== props.workspaceId
                ? (workspaceNames.get(record.workspaceId) ?? null)
                : null;
            return (
              <div
                key={id}
                id={`og-chat-switcher-${position}`}
                data-switcher-index={position}
                role="option"
                aria-selected={selected}
                onPointerMove={() => {
                  if (!selected) props.onHover(position);
                }}
                // Control+click is a right-click on a Mac: pick on release, and
                // keep the context menu away.
                onPointerUp={(event) => {
                  if (event.button === 0) props.onPick(position);
                }}
                onContextMenu={(event) => event.preventDefault()}
                className={cn(
                  "flex min-h-9 w-full min-w-0 cursor-default items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-sm text-fg-label select-none",
                  selected ? "bg-hover text-fg" : null,
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn("size-4 shrink-0", selected ? "text-fg" : "text-fg-muted")}
                />
                <span className="min-w-0 flex-1 truncate">{record?.title ?? "Untitled chat"}</span>
                {elsewhere ? <WorkspaceTag name={elsewhere} /> : null}
                <ChatStatusMarks
                  status={record ? currentChatStatus(record, sidebarIds, now) : null}
                />
                {meta ? (
                  <span className="shrink-0 text-xs text-fg-muted tabular-nums">{meta}</span>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <Keycaps
              chord={{ code: "Tab", control: true, mod: props.platform !== "mac" }}
              platform={props.platform}
            />
            Next
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Keycaps
              chord={{ code: "Tab", control: true, mod: props.platform !== "mac", shift: true }}
              platform={props.platform}
            />
            Back
          </span>
          <span className="ml-auto">Release to open</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
