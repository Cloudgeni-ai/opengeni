/**
 * The sidebar's status marks on command menu and Control+Tab rows, and the
 * reads that keep them current while a list is open.
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

const lastWorkspaceRead = new Map<string, number>();

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
 * while as long as the list is open.
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
