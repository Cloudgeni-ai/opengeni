// What the desktop shows for the person's inbox. Pure, so it is tested without
// Electron.

import type { InboxItem, ListInboxResponse } from "@opengeni/sdk";

export type InboxAction =
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "choose"; choiceId: string; label: string }
  | { kind: "reply"; text: string };

/** The buttons and inline reply a notification offers for an item. */
export interface NotificationPlan {
  title: string;
  subtitle: string;
  body: string;
  buttons: Array<{ label: string; action: InboxAction }>;
  reply: boolean;
}

/** Markdown-ish notification text as plain text for the system banner. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/gu, "$1")
    .replace(/^\s*[-*]\s+/gmu, "• ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function notificationPlan(item: InboxItem, accountLabel: string | null): NotificationPlan {
  const context = [item.sender?.label, item.sessionTitle, accountLabel].filter(Boolean).join(" · ");
  const plan: NotificationPlan = {
    title: item.title,
    subtitle: item.subtitle || context,
    body: plainText(item.body).slice(0, 400),
    buttons: [],
    reply: false,
  };
  if (item.kind === "approval") {
    plan.buttons = [
      { label: "Approve", action: { kind: "approve" } },
      { label: "Deny", action: { kind: "deny" } },
    ];
  } else if (item.kind === "question") {
    if (item.choices.length > 0) {
      plan.buttons = item.choices.map((choice) => ({
        label: choice.label,
        action: { kind: "choose", choiceId: choice.id, label: choice.label },
      }));
    } else {
      plan.reply = true;
    }
  }
  return plan;
}

/**
 * The banner's text fields. Only macOS has a subtitle line, so elsewhere the
 * context (who is asking, in which session and account) leads the body
 * instead of being dropped.
 */
export function bannerText(
  plan: NotificationPlan,
  platform: NodeJS.Platform,
): { subtitle?: string; body: string } {
  if (platform === "darwin") return { subtitle: plan.subtitle, body: plan.body };
  if (!plan.subtitle) return { body: plan.body };
  return { body: plan.body ? `${plan.subtitle}\n${plan.body}` : plan.subtitle };
}

function snoozed(item: InboxItem, now: number): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now;
}

export interface InboxDiff {
  /** Items to announce now. */
  announce: InboxItem[];
  /** Item ids whose banners should leave Notification Center. */
  retract: string[];
  /** What was seen, to diff the next reading against. */
  seen: Map<string, string>;
}

/**
 * Compare a fresh inbox reading with the last one. The first reading only
 * records what is there: anything older already reached the person's phone or
 * the inbox. After that, an open, unread, unsnoozed item is announced when it
 * is new or its content changed.
 */
export function diffInbox(
  previous: Map<string, string> | null,
  inbox: ListInboxResponse,
  now: number,
): InboxDiff {
  const seen = new Map<string, string>();
  const announce: InboxItem[] = [];
  for (const item of inbox.items) {
    if (item.status !== "open") continue;
    seen.set(item.id, item.updatedAt);
    if (!previous || !item.unread || snoozed(item, now)) continue;
    if (previous.get(item.id) !== item.updatedAt) announce.push(item);
  }
  const retract = previous ? [...previous.keys()].filter((id) => !seen.has(id)) : [];
  return { announce, retract, seen };
}

/** The in-app path that shows an item: its session at the moment it came from. */
export function inboxItemPath(item: InboxItem): string {
  if (!item.sessionAvailable) return `/workspaces/${item.workspaceId}/inbox`;
  const at = item.eventSequence ? `?at=${item.eventSequence}` : "";
  return `/workspaces/${item.workspaceId}/sessions/${item.sessionId}${at}`;
}
