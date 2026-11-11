/**
 * The sidebar's status marks on command menu and Control+Tab rows, and the
 * reads that keep them current while a list is open, including the chats
 * that listed sub-agent chats belong to, so each row can name its parent.
 */
import { useEffect } from "react";

import { useAppContext } from "../../app-context";
import {
  readChatDirectory,
  rememberChats,
  type ChatRecord,
} from "../../lib/actions/chat-directory";
import { chatStatusIsCurrent, type ChatStatus } from "../../lib/actions/chat-status";
import { RailTrailingMetadata } from "../rail/session-row-content";

/** A workspace's newest chats are read at most this often for the lists. */
const WORKSPACE_READ_EVERY_MS = 15_000;
/** While a list stays open, its statuses are read again this often. */
const REFRESH_EVERY_MS = 20_000;
/** Chats outside their workspace's newest page are read one by one, up to this many. */
const SINGLE_READS = 6;
const WORKSPACE_PAGE = 40;
/** Parents read in one request per workspace, at most this many. */
const PARENT_READS = 50;

const lastWorkspaceRead = new Map<string, number>();
/** Parents already asked for, so one that is gone or hidden is not asked for again. */
const askedParents = new Set<string>();

/** The working, needs-you, waiting, automation and creator marks, as on the chat's sidebar row. */
export function ChatStatusMarks({ status }: { status: ChatStatus | null }) {
  if (!status) return null;
  const { summary } = status;
  return (
    <>
      {summary.kind !== "neutral" ? <span className="sr-only">{summary.label}</span> : null}
      <RailTrailingMetadata
        summary={summary}
        automationWait={status.automationWait}
        automationWaitLabel={status.automationWaitLabel ?? undefined}
        creator={status.creator}
      />
    </>
  );
}

/**
 * Reads the listed chats whose status isn't known to be current: one page of
 * each workspace's newest chats, then the rest one by one. Again every little
 * while as long as the list is open. Listed sub-agent chats whose parent the
 * app doesn't know get it read too, in one request per workspace.
 */
export function useChatStatusRefresh(input: {
  subjectId: string;
  /** The workspace whose sidebar is on screen. */
  workspaceId: string;
  ids: readonly string[];
  active: boolean;
}) {
  const { client } = useAppContext();
  const { subjectId, workspaceId, active } = input;
  const idsKey = input.ids.join(",");
  useEffect(() => {
    if (!active || !idsKey) return;
    const controller = new AbortController();
    const ids = idsKey.split(",");
    const stale = (): ChatRecord[] => {
      const directory = readChatDirectory(subjectId, workspaceId);
      const sidebar = new Set([...directory.sidebarOrder, ...directory.pinnedOrder]);
      const now = Date.now();
      return ids.flatMap((id) => {
        const record = directory.rows.get(id);
        if (!record) return [];
        return chatStatusIsCurrent(record, sidebar, now) ? [] : [record];
      });
    };
    const refresh = async () => {
      await refreshStatuses();
      if (!controller.signal.aborted) await readParents();
    };
    const readParents = async () => {
      const directory = readChatDirectory(subjectId, workspaceId);
      const byWorkspace = new Map<string, string[]>();
      for (const id of ids) {
        const record = directory.rows.get(id);
        const parentId = record?.parentId;
        if (!record || !parentId || directory.rows.has(parentId)) continue;
        const key = `${subjectId}:${parentId}`;
        if (askedParents.has(key)) continue;
        const list = byWorkspace.get(record.workspaceId) ?? [];
        if (list.length >= PARENT_READS || list.includes(parentId)) continue;
        askedParents.add(key);
        list.push(parentId);
        byWorkspace.set(record.workspaceId, list);
      }
      await Promise.all(
        [...byWorkspace].map(async ([id, parentIds]) => {
          // A list closed mid-read asks again next time.
          const forget = () => {
            for (const parentId of parentIds) askedParents.delete(`${subjectId}:${parentId}`);
          };
          try {
            const page = await client.listSessionSummaryPage(id, {
              sessionIds: parentIds,
              archiveStatus: "all",
              siteConversations: "include",
              limit: parentIds.length,
              signal: controller.signal,
            });
            if (controller.signal.aborted) return forget();
            // Only the chats asked for: an older server may answer with a plain page.
            const asked = new Set(parentIds);
            rememberChats(
              subjectId,
              [...(page.pinned ?? []), ...page.sessions].filter((row) => asked.has(row.id)),
            );
          } catch {
            // The rows show without their parent's name, as before.
            if (controller.signal.aborted) forget();
          }
        }),
      );
    };
    const refreshStatuses = async () => {
      const first = stale();
      if (first.length === 0) return;
      const now = Date.now();
      const workspaces = [...new Set(first.map((record) => record.workspaceId))].filter(
        (id) => now - (lastWorkspaceRead.get(`${subjectId}:${id}`) ?? 0) > WORKSPACE_READ_EVERY_MS,
      );
      await Promise.all(
        workspaces.map(async (id) => {
          lastWorkspaceRead.set(`${subjectId}:${id}`, now);
          try {
            const page = await client.listSessionSummaryPage(id, {
              limit: WORKSPACE_PAGE,
              signal: controller.signal,
            });
            if (!controller.signal.aborted)
              rememberChats(subjectId, [...(page.pinned ?? []), ...page.sessions]);
          } catch {
            // The list keeps showing what it knows without the status.
          }
        }),
      );
      if (controller.signal.aborted) return;
      await Promise.all(
        stale()
          .slice(0, SINGLE_READS)
          .map(async (record) => {
            try {
              const session = await client.getSession(record.workspaceId, record.id, {
                signal: controller.signal,
              });
              if (!controller.signal.aborted) rememberChats(subjectId, [session]);
            } catch {
              // Unreachable or gone: no status, as before.
            }
          }),
      );
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [client, subjectId, workspaceId, idsKey, active]);
}
