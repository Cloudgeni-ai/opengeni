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
 * "Archive" where this person can archive the chat, otherwise null: people
 * without session control cannot archive, and an archived chat is restored
 * from its own notice (see ReadOnlySessionNotice).
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
 * What keeps a chat live (the server's `session_archive_blocked`): a setting
 * on purpose, or a sub-chat still in use (`active_sub_chat`, with its title
 * and why).
 */
type ArchiveBlocker = {
  kind: string;
  sessionId: string;
  title?: string | null;
  reason?: string;
};

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

/**
 * Sub-chats in use that the person chose to archive too ("Archive all" on the
 * notice), by workspace and chat. The archive that `rerun` starts takes them
 * synchronously, like the keep-live entries.
 */
const confirmedActiveSubChats = new Map<string, string[]>();

function takeConfirmedActiveSubChats(chat: Pick<SessionListRow, "id" | "workspaceId">) {
  const key = archiveKey(chat);
  const ids = confirmedActiveSubChats.get(key);
  confirmedActiveSubChats.delete(key);
  return ids;
}

const ACTIVE_REASON: Record<string, string> = {
  running: "running",
  waiting: "waiting for input",
  goal: "working on a goal",
  messaged: "in use",
};

/** How many sub-chats in use the notice names; the rest are counted. */
const ACTIVE_SUB_CHATS_NAMED = 3;

/** "“Owner” (in use), “Worker” (running) and 2 more", for the notice. */
export function activeSubChatsSentence(blockers: readonly ArchiveBlocker[]): string {
  const named = blockers.slice(0, ACTIVE_SUB_CHATS_NAMED).map((blocker) => {
    const reason = ACTIVE_REASON[blocker.reason ?? ""] ?? "in use";
    const name = blocker.title?.trim() ? quotedChatName(blocker.title) : "An untitled chat";
    return `${name} (${reason})`;
  });
  const more = blockers.length - named.length;
  if (more > 0) named.push(`${more} more`);
  return named.length > 1
    ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
    : (named[0] ?? "");
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
): symbol {
  const key = archiveKey(chat);
  const token = Symbol(key);
  keptActiveTurnedOff.set(key, { sessionIds, token });
  setTimeout(() => {
    if (keptActiveTurnedOff.get(key)?.token === token) keptActiveTurnedOff.delete(key);
  }, KEPT_ACTIVE_MEMORY_MS);
  return token;
}

/**
 * Turns "Keep this chat active" back on. Resolves false when that failed, so
 * a caller that needs it to have worked can say so.
 */
async function restoreKeepLive(
  context: AppContextValue,
  workspaceId: string,
  sessionIds: readonly string[] | undefined,
): Promise<boolean> {
  if (!sessionIds?.length) return true;
  const results = await Promise.allSettled(
    sessionIds.map((sessionId) =>
      context.client.updateSessionRetention(workspaceId, sessionId, { keepLive: true }),
    ),
  );
  return results.every((result) => result.status === "fulfilled");
}

async function turnOffKeepLiveAndArchive(
  context: AppContextValue,
  chat: Pick<SessionListRow, "id" | "workspaceId">,
  sessionIds: string[],
  rerun: (archived: boolean) => void,
  accepted: NonNullable<ReturnType<AppContextValue["captureWorkspaceInvocation"]>>,
) {
  // The person may have moved to another workspace since the notice showed.
  if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return;
  const changed: string[] = [];
  try {
    for (const sessionId of sessionIds) {
      await context.client.updateSessionRetention(chat.workspaceId, sessionId, {
        keepLive: false,
      });
      changed.push(sessionId);
    }
  } catch (error) {
    void restoreKeepLive(context, chat.workspaceId, changed);
    toast.error("Couldn't turn off “Keep this chat active”.", {
      description: userErrorText(error),
    });
    return;
  }
  const key = archiveKey(chat);
  const token = rememberKeptActive(chat, changed);
  if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) {
    keptActiveTurnedOff.delete(key);
    void restoreKeepLive(context, chat.workspaceId, changed);
    return;
  }
  // The caller's archive takes the entry synchronously (requestSessionArchive
  // reads it before its first await). Still there: that archive didn't start
  // (one already in flight, or the workspace changed), so nothing was
  // archived and the setting goes back on.
  rerun(true);
  if (keptActiveTurnedOff.get(key)?.token === token) {
    keptActiveTurnedOff.delete(key);
    void restoreKeepLive(context, chat.workspaceId, changed);
  }
}

/**
 * Archive a chat for everyone, or bring it back (`archived: false`): Undo
 * within the few seconds it is offered, or Restore later, which puts stored
 * content back in the background. Archiving shows a notice with Undo. When
 * only "Keep this chat active" keeps it live, the notice offers one action
 * that turns that off and archives through `rerun`. When sub-chats are still
 * in use, the notice says how many and which, and archives them too only if
 * the person chooses "Archive all". Other errors are thrown for the caller;
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
  const confirmActiveSubChats = archived ? takeConfirmedActiveSubChats(chat) : undefined;
  let updated: Awaited<ReturnType<AppContextValue["client"]["updateSessionArchive"]>>;
  try {
    updated = await context.client.updateSessionArchive(chat.workspaceId, chat.id, {
      archived,
      ...(confirmActiveSubChats?.length ? { confirmActiveSubChats } : {}),
    });
  } catch (error) {
    // The setting was turned off only to archive; put it back.
    void restoreKeepLive(context, chat.workspaceId, turnedOff);
    const blockers = archiveBlockers(error);
    const keptActive =
      blockers?.length && blockers.every((blocker) => blocker.kind === "keep_live");
    if (archived && rerun && !turnedOff && keptActive) {
      if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
      const sessionIds = [...new Set(blockers.map((blocker) => blocker.sessionId))];
      let chosen = false;
      toast("Couldn't archive the chat.", {
        description: sessionIds.includes(chat.id)
          ? "“Keep this chat active” is on."
          : "A chat it started has “Keep this chat active” on.",
        duration: ARCHIVE_UNDO_MS,
        action: {
          label: "Turn off and archive",
          onClick: () => {
            // Once: a quick second click must not turn it off twice.
            if (chosen) return;
            chosen = true;
            void turnOffKeepLiveAndArchive(context, chat, sessionIds, rerun, accepted);
          },
        },
      });
      return null;
    }
    const active = blockers?.filter((blocker) => blocker.kind === "active_sub_chat") ?? [];
    if (archived && rerun && active.length > 0 && active.length === blockers?.length) {
      if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
      const sessionIds = active.map((blocker) => blocker.sessionId);
      let chosen = false;
      const count = active.length === 1 ? "A sub-chat is" : `${active.length} sub-chats are`;
      toast.warning(`${count} still in use.`, {
        description: `${activeSubChatsSentence(active)}. Archiving ${quotedChatName(chatTitle)} stops ${active.length === 1 ? "it" : "them"} too.`,
        // Stays until the person decides; it is not a passing notice.
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Archive all",
          onClick: () => {
            if (chosen || !context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return;
            chosen = true;
            confirmedActiveSubChats.set(archiveKey(chat), sessionIds);
            rerun(true);
            // Still there: that archive didn't start, so nothing is confirmed.
            confirmedActiveSubChats.delete(archiveKey(chat));
          },
        },
        cancel: { label: "Keep them", onClick: () => undefined },
      });
      return null;
    }
    const { code, serverMessage } = apiErrorFacts(error);
    if (
      serverMessage &&
      (blockers ||
        code === "session_archive_final" ||
        code === "session_archive_busy" ||
        code === "session_archive_restore_root")
    ) {
      throw userFacingError(error, serverMessage);
    }
    throw error;
  }
  if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
  if (archived) {
    if (turnedOff) rememberKeptActive(chat, turnedOff);
    toast(`Archived ${quotedChatName(chatTitle)}`, {
      description:
        "In a few seconds it moves to long-term storage. You can still read and search it under Archived, and restore it from there.",
      duration: ARCHIVE_UNDO_MS,
      ...(rerun ? { action: { label: "Undo", onClick: () => rerun(false) } } : {}),
    });
  } else {
    // Undo returns the chat as it was, "Keep this chat active" included. The
    // chat comes back at once; the setting follows, and only a failure says so.
    const kept = takeKeptActive(chat);
    if (updated.retention?.archive?.restoring) {
      toast.success(`Restoring ${quotedChatName(chatTitle)}`, {
        description: "Its content is coming back from long-term storage. It can continue soon.",
      });
    } else if (!kept?.length) toast.success("Archive undone.");
    else {
      void restoreKeepLive(context, chat.workspaceId, kept).then((restored) => {
        if (restored) toast.success("Archive undone.");
        else {
          toast.warning("Archive undone, but “Keep this chat active” is still off.", {
            description: "Turn it on in the chat's Agent tab.",
          });
        }
      });
    }
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
