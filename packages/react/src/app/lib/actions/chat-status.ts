/**
 * A chat's status as the sidebar row shows it (working, needs you, waiting,
 * failed, unread, waiting on an automation, who started it), for the command menu and the
 * Control+Tab switcher. A remembered row only counts while it is known to be
 * current: the sidebar keeps its own workspace's rows live, and other rows
 * are read again when a list opens.
 */
import { sessionAutomationWaitWords } from "../../../components/automations/automation-model";
import { type SessionAutomationWait, type SessionListRow } from "../../../session-list-model";
import { t } from "../console-text";
import { railRowCreator, type CreatorRef } from "../creator-initials";
import { summarizeRailNodes, type RailAggregateStatus } from "../sessions-group";
import type { ChatRecord } from "./chat-directory";

/** How long a row read from the server still describes the chat. */
export const CHAT_STATUS_FRESH_MS = 90_000;

export type ChatStatus = {
  summary: RailAggregateStatus;
  automationWait: SessionAutomationWait | null;
  /** What that automation waits for, in words ("Waiting for deploy.finished from Deploys"). */
  automationWaitLabel: string | null;
  creator: CreatorRef | null;
};

/** Exactly the sidebar row's marker: the chat and everything it started. */
export function chatRowStatus(row: SessionListRow, now: Date = new Date()): ChatStatus {
  const automationWait = sessionAutomationWaitWords(t, row, { now });
  return {
    summary: summarizeRailNodes(
      [{ session: row, children: [], hasActiveDescendant: false }],
      undefined,
      now,
    ),
    automationWait: automationWait?.kind ?? null,
    automationWaitLabel: automationWait?.label ?? null,
    creator: railRowCreator(row),
  };
}

/**
 * Whether the record's row says how the chat is now: the sidebar on screen
 * holds it (and keeps it live), or it was read moments ago.
 */
export function chatStatusIsCurrent(
  record: ChatRecord,
  sidebarIds: ReadonlySet<string>,
  now: number,
): boolean {
  if (!record.row) return false;
  return sidebarIds.has(record.id) || now - record.readAt < CHAT_STATUS_FRESH_MS;
}

/** The status to show, or null while it isn't known to be current. */
export function currentChatStatus(
  record: ChatRecord,
  sidebarIds: ReadonlySet<string>,
  now: number,
): ChatStatus | null {
  if (!record.row || !chatStatusIsCurrent(record, sidebarIds, now)) return null;
  return chatRowStatus(record.row, new Date(now));
}
