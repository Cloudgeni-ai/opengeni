import { toast } from "./toast";
import { apiErrorFacts, userErrorText, userFacingError } from "../../ui/api-error";
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

/** What keeps a chat live on purpose (the server's `session_archive_blocked`). */
type ArchiveBlocker = { kind: string; sessionId: string };

function archiveBlockers(error: unknown): ArchiveBlocker[] | null {
  if (apiErrorFacts(error).code !== "session_archive_blocked") return null;
  const body = (error as { body?: unknown }).body;
  try {
    const blockers: unknown = typeof body === "string" ? JSON.parse(body)?.blockers : null;
    if (!Array.isArray(blockers)) return [];
    return blockers.filter(
      (blocker): blocker is ArchiveBlocker =>
        typeof blocker?.kind === "string" && typeof blocker?.sessionId === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Chats whose "Keep this chat active" was turned off by "Turn off and
 * archive", by workspace and chat, so a failed archive or Undo turns it back
 * on. Entries outlive the Undo window only briefly.
 */
const keptActiveTurnedOff = new Map<string, { sessionIds: string[]; token: symbol }>();
const KEPT_ACTIVE_MEMORY_MS = 60_000;

function archiveKey(chat: Pick<SessionListRow, "id" | "workspaceId">) {
  return `${chat.workspaceId}/${chat.id}`;
}

function takeKeptActive(chat: Pick<SessionListRow, "id" | "workspaceId">) {
  const key = archiveKey(chat);
  const entry = keptActiveTurnedOff.get(key);
  keptActiveTurnedOff.delete(key);
  return entry?.sessionIds;
}

function rememberKeptActive(
  chat: Pick<SessionListRow, "id" | "workspaceId">,
  sessionIds: string[],
) {
  const key = archiveKey(chat);
  const token = Symbol(key);
  keptActiveTurnedOff.set(key, { sessionIds, token });
  setTimeout(() => {
    if (keptActiveTurnedOff.get(key)?.token === token) keptActiveTurnedOff.delete(key);
  }, KEPT_ACTIVE_MEMORY_MS);
}

/** Turns "Keep this chat active" back on, quietly: the archive outcome is what the person sees. */
function restoreKeepLive(
  context: AppContextValue,
  workspaceId: string,
  sessionIds: readonly string[] | undefined,
) {
  if (!sessionIds?.length) return;
  void Promise.allSettled(
    sessionIds.map((sessionId) =>
      context.client.updateSessionRetention(workspaceId, sessionId, { keepLive: true }),
    ),
  );
}

async function turnOffKeepLiveAndArchive(
  context: AppContextValue,
  chat: Pick<SessionListRow, "id" | "workspaceId">,
  sessionIds: string[],
  rerun: (archived: boolean) => void,
) {
  const changed: string[] = [];
  try {
    for (const sessionId of sessionIds) {
      await context.client.updateSessionRetention(chat.workspaceId, sessionId, {
        keepLive: false,
      });
      changed.push(sessionId);
    }
  } catch (error) {
    restoreKeepLive(context, chat.workspaceId, changed);
    toast.error("Couldn't turn off “Keep this chat active”.", {
      description: userErrorText(error),
    });
    return;
  }
  rememberKeptActive(chat, changed);
  rerun(true);
}

/**
 * Archive a chat for everyone, or undo that (`archived: false`) within the
 * few seconds Undo is offered. Archiving shows a notice with Undo; once it
 * closes, the chat moves to long-term storage for good. When only "Keep this
 * chat active" keeps it live, the notice offers one action that turns that
 * off and archives through `rerun`. Other errors are thrown for the caller;
 * a refusal that says what keeps the chat live is thrown as that sentence.
 */
export async function requestSessionArchive(
  context: AppContextValue,
  chat: Pick<SessionListRow, "id" | "workspaceId">,
  archived: boolean,
  /** The chat's sidebar title (sessionDisplayTitle), named in the notice. */
  chatTitle: string,
  /**
   * Runs the caller's own archive again: `false` for Undo, `true` once
   * "Keep this chat active" is turned off.
   */
  rerun?: (archived: boolean) => void,
) {
  const accepted = context.captureWorkspaceInvocation(chat.workspaceId);
  if (!accepted) return null;
  const turnedOff = archived ? takeKeptActive(chat) : undefined;
  let updated: Awaited<ReturnType<AppContextValue["client"]["updateSessionArchive"]>>;
  try {
    updated = await context.client.updateSessionArchive(chat.workspaceId, chat.id, {
      archived,
    });
  } catch (error) {
    // The setting was turned off only to archive; put it back.
    restoreKeepLive(context, chat.workspaceId, turnedOff);
    const blockers = archiveBlockers(error);
    const keptActive =
      blockers?.length && blockers.every((blocker) => blocker.kind === "keep_live");
    if (archived && rerun && !turnedOff && keptActive) {
      if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
      const sessionIds = [...new Set(blockers.map((blocker) => blocker.sessionId))];
      toast("Couldn't archive the chat.", {
        description: sessionIds.includes(chat.id)
          ? "“Keep this chat active” is on."
          : "A chat it started has “Keep this chat active” on.",
        duration: ARCHIVE_UNDO_MS,
        action: {
          label: "Turn off and archive",
          onClick: () => void turnOffKeepLiveAndArchive(context, chat, sessionIds, rerun),
        },
      });
      return null;
    }
    const { code, serverMessage } = apiErrorFacts(error);
    if (serverMessage && (blockers || code === "session_archive_final")) {
      throw userFacingError(error, serverMessage);
    }
    throw error;
  }
  if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
  if (archived) {
    if (turnedOff) rememberKeptActive(chat, turnedOff);
    toast(`Archived ${quotedChatName(chatTitle)}`, {
      description:
        "In a few seconds it moves to long-term storage and can't be restored. You can still read and search it under Archived.",
      duration: ARCHIVE_UNDO_MS,
      ...(rerun ? { action: { label: "Undo", onClick: () => rerun(false) } } : {}),
    });
  } else {
    // Undo returns the chat as it was, "Keep this chat active" included.
    restoreKeepLive(context, chat.workspaceId, takeKeptActive(chat));
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
