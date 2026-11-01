import { toast } from "./toast";
import type { AppContextValue } from "../app-context";
// Type only. Callers pass the chat's sidebar title: importing title code here
// changes the web build's chunk graph (eager-page and chunk-cycle checks).
import type { SessionListRow } from "../../session-list-model";

/** Whether this person can archive chats in the workspace (session control). */
export function canArchiveChat(
  context: Pick<AppContextValue, "accessContext">,
  workspaceId: string,
): boolean {
  const grant = context.accessContext.workspaceGrants.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  return (
    !!grant &&
    (grant.permissions.includes("sessions:control") ||
      (grant.permissionMode !== "explicit" && grant.permissions.includes("workspace:admin")))
  );
}

/**
 * "Archive" where this person can archive the chat, otherwise null: an
 * archived chat cannot be restored, and people without session control
 * cannot archive.
 */
export function archiveActionLabel(
  context: Pick<AppContextValue, "accessContext">,
  chat: Pick<SessionListRow, "archived" | "workspaceId">,
): "Archive" | null {
  return !chat.archived && canArchiveChat(context, chat.workspaceId) ? "Archive" : null;
}

/** How long Undo is offered; the server accepts it for a little longer. */
export const ARCHIVE_UNDO_MS = 10_000;

/**
 * Archive a chat for everyone, or undo that (`archived: false`) within the
 * few seconds Undo is offered. Archiving shows a notice with Undo; once it
 * closes, the chat moves to long-term storage for good. Errors, including a
 * refusal that says what keeps the chat live, are thrown for the caller.
 */
export async function requestSessionArchive(
  context: AppContextValue,
  chat: Pick<SessionListRow, "id" | "workspaceId">,
  archived: boolean,
  /** The chat's sidebar title (sessionDisplayTitle), named in the notice. */
  chatTitle: string,
  /** Undo from the notice; the caller archives with `archived: false`. */
  onUndo?: () => void,
) {
  const accepted = context.captureWorkspaceInvocation(chat.workspaceId);
  if (!accepted) return null;
  const updated = await context.client.updateSessionArchive(chat.workspaceId, chat.id, {
    archived,
  });
  if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
  if (archived) {
    toast(`Archived ${quotedChatName(chatTitle)}`, {
      description:
        "In a few seconds it moves to long-term storage and can't be restored. You can still read and search it under Archived.",
      duration: ARCHIVE_UNDO_MS,
      ...(onUndo ? { action: { label: "Undo", onClick: onUndo } } : {}),
    });
  } else {
    toast.success("Archive undone.");
  }
  return updated;
}

const CHAT_NAME_MAX = 60;

/** A chat's sidebar title in quotes, shortened to fit a dialog title. */
export function quotedChatName(sidebarTitle: string): string {
  const title = sidebarTitle.trim();
  if (!title) return "this chat";
  const characters = Array.from(title);
  const short =
    characters.length > CHAT_NAME_MAX
      ? `${characters
          .slice(0, CHAT_NAME_MAX - 1)
          .join("")
          .trimEnd()}…`
      : title;
  return `“${short}”`;
}
