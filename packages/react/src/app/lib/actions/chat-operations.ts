import {
  archiveActionLabel,
  requestSessionArchive,
  useArchiveConfirmation,
} from "../archive-session";
/**
 * The chat operations every surface shares: the command menu, chords, the
 * chat header and the sidebar's row menus all copy links, pin, archive and
 * mark chats through these, so they behave identically everywhere.
 */
import { useCallback, useMemo, useRef } from "react";
import type { SessionListRow } from "../../../session-list-model";
import { useAppContext } from "../../app-context";
import { usePage } from "../navigation";
import { applySessionArchiveProjection } from "../session-pagination";
import { notifySessionListChanged } from "../session-list-invalidation";
import { toast } from "../toast";

export type ChatOperations = {
  archiveLabel?: (chat: SessionListRow) => string;
  /** The chat's shareable address. */
  linkTo(chat: Pick<SessionListRow, "id" | "workspaceId">): string;
  copyLink(chat: Pick<SessionListRow, "id" | "workspaceId">): Promise<void>;
  setPinned(chat: SessionListRow, pinned: boolean): Promise<void>;
  setArchived(chat: SessionListRow, archived: boolean): Promise<void>;
  setUnread(chat: SessionListRow, unread: boolean): Promise<void>;
};

export function chatPath(chat: Pick<SessionListRow, "id" | "workspaceId">): string {
  return `/workspaces/${encodeURIComponent(chat.workspaceId)}/sessions/${encodeURIComponent(chat.id)}`;
}

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Older embeds without the async clipboard: a hidden textarea and execCommand.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("The browser blocked copying.");
}

export function useChatOperations(): ChatOperations {
  const context = useAppContext();
  const confirmArchive = useArchiveConfirmation();
  const page = usePage();
  const archiving = useRef(new Set<string>());
  const linkTo = useCallback(
    (chat: Pick<SessionListRow, "id" | "workspaceId">) => `${page.origin()}${chatPath(chat)}`,
    [page],
  );
  const copyLink = useCallback(
    async (chat: Pick<SessionListRow, "id" | "workspaceId">) => {
      try {
        await writeClipboard(linkTo(chat));
        toast.success("Link copied");
      } catch (error) {
        toast.error("Couldn't copy the link.", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [linkTo],
  );
  const setPinned = useCallback(
    async (chat: SessionListRow, pinned: boolean) => {
      const updated = await context.updateSessionPin(
        chat.workspaceId,
        chat.id,
        pinned,
        chat.pinVersion ?? 0,
      );
      if (updated) toast.success(pinned ? "Chat pinned" : "Chat unpinned");
      else toast.error(pinned ? "Couldn't pin the chat." : "Couldn't unpin the chat.");
    },
    [context],
  );
  const setArchivedRef = useRef<ChatOperations["setArchived"] | null>(null);
  const setArchived = useCallback(
    async (chat: SessionListRow, archived: boolean) => {
      if (archiving.current.has(chat.id)) return;
      const accepted = context.captureWorkspaceInvocation(chat.workspaceId);
      if (!accepted) return;
      archiving.current.add(chat.id);
      try {
        const updated = await requestSessionArchive(context, chat, archived, confirmArchive);
        if (!updated) return;
        if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return;
        context.setSession((current) =>
          current?.id === updated.id && current.workspaceId === updated.workspaceId
            ? applySessionArchiveProjection(current, updated)
            : current,
        );
        notifySessionListChanged({
          workspaceId: chat.workspaceId,
          sessionId: chat.id,
          archived: updated.archived,
        });
        const after: SessionListRow = {
          ...chat,
          archived: updated.archived === true,
          ...(updated.archiveVersion !== undefined
            ? { archiveVersion: updated.archiveVersion }
            : {}),
        };
        toast.success(updated.archived ? "Chat archived." : "Chat restored.", {
          // Archiving is one key away, so taking it back is one click away.
          action: updated.archived
            ? { label: "Undo", onClick: () => void setArchivedRef.current?.(after, false) }
            : undefined,
        });
      } catch (error) {
        if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return;
        toast.error(archived ? "Couldn't archive the chat." : "Couldn't restore the chat.", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        archiving.current.delete(chat.id);
      }
    },
    [context, confirmArchive],
  );
  setArchivedRef.current = setArchived;
  const setUnread = useCallback(
    async (chat: SessionListRow, unread: boolean) => {
      try {
        const updated = await context.client.updateSessionAttention(chat.workspaceId, chat.id, {
          unread,
          expectedVersion: chat.attentionVersion ?? 0,
        });
        context.setSession((current) =>
          current?.id === updated.id
            ? {
                ...current,
                ...(updated.unread !== undefined ? { unread: updated.unread } : {}),
                ...(updated.attentionVersion !== undefined
                  ? { attentionVersion: updated.attentionVersion }
                  : {}),
              }
            : current,
        );
        notifySessionListChanged({ workspaceId: chat.workspaceId, sessionId: chat.id });
        toast.success(unread ? "Marked as unread" : "Marked as read");
      } catch (error) {
        toast.error("Couldn't update the chat.", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [context],
  );
  return useMemo(
    () => ({
      linkTo,
      copyLink,
      setPinned,
      setArchived,
      setUnread,
      archiveLabel: (chat: SessionListRow) => archiveActionLabel(context, chat),
    }),
    [linkTo, copyLink, setPinned, setArchived, setUnread, context],
  );
}
