import { Notification, powerMonitor } from "electron";
import type { InboxItem, OpenGeniClient } from "@opengeni/sdk";

import { actOnInboxItem } from "./inbox-actions";
import { diffInbox, notificationPlan, type InboxAction } from "./inbox-model";

const POLL_MS = 30_000;

export interface InboxNotifierDeps {
  /** Signed-in accounts, with a label when there are several. */
  accounts(): Array<{ id: string; label: string | null }>;
  client(accountId: string): Promise<OpenGeniClient | null>;
  /** Show the item's session (or the inbox) in the window. */
  open(accountId: string, item: InboxItem): void;
  /** The account's credential was rejected. */
  unauthorized(accountId: string): void;
  /** What waits on the person across accounts. */
  setBadge(count: number): void;
}

interface AccountInbox {
  seen: Map<string, string> | null;
  needsYou: number;
  banners: Map<string, Notification>;
}

/**
 * Keeps the person's inbox on the desktop while the app runs, window or not:
 * new questions, approvals, paused goals and agent notes become native
 * notifications with their one-tap answers, answered or withdrawn ones leave
 * Notification Center, and the Dock or taskbar badge counts what waits on them.
 */
export class InboxNotifier {
  private readonly inboxes = new Map<string, AccountInbox>();
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;

  constructor(private readonly deps: InboxNotifierDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    powerMonitor.on("resume", () => void this.poll());
    powerMonitor.on("unlock-screen", () => void this.poll());
    void this.poll();
  }

  /** Read every account now, e.g. after sign-in or when the window gains focus. */
  poll(): Promise<void> {
    this.polling ??= this.readAll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  forget(accountId: string): void {
    const inbox = this.inboxes.get(accountId);
    for (const banner of inbox?.banners.values() ?? []) banner.close();
    this.inboxes.delete(accountId);
    this.updateBadge();
  }

  private async readAll(): Promise<void> {
    const accounts = this.deps.accounts();
    for (const id of [...this.inboxes.keys()]) {
      if (!accounts.some((account) => account.id === id)) this.forget(id);
    }
    await Promise.all(accounts.map((account) => this.read(account.id, account.label)));
    this.updateBadge();
  }

  private async read(accountId: string, label: string | null): Promise<void> {
    const client = await this.deps.client(accountId);
    if (!client) return;
    let inbox: Awaited<ReturnType<OpenGeniClient["listInbox"]>>;
    try {
      inbox = await client.listInbox();
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) this.deps.unauthorized(accountId);
      return;
    }
    const state = this.inboxes.get(accountId) ?? { seen: null, needsYou: 0, banners: new Map() };
    this.inboxes.set(accountId, state);
    const diff = diffInbox(state.seen, inbox, Date.now());
    state.seen = diff.seen;
    state.needsYou = inbox.needsYouCount;
    for (const id of diff.retract) {
      state.banners.get(id)?.close();
      state.banners.delete(id);
    }
    if (!Notification.isSupported()) return;
    for (const item of diff.announce) this.announce(accountId, label, item, state);
  }

  private announce(
    accountId: string,
    label: string | null,
    item: InboxItem,
    state: AccountInbox,
  ): void {
    const plan = notificationPlan(item, label);
    state.banners.get(item.id)?.close();
    const banner = new Notification({
      title: plan.title,
      subtitle: plan.subtitle,
      body: plan.body,
      actions: plan.buttons.map((button) => ({ type: "button" as const, text: button.label })),
      hasReply: plan.reply,
      replyPlaceholder: "Your answer",
      urgency: item.urgency === "time_sensitive" ? "critical" : "normal",
    });
    const act = (action: InboxAction) => void this.act(accountId, item, action);
    banner.on("click", () => this.deps.open(accountId, item));
    banner.on("action", (_event, index) => {
      const button = plan.buttons[index];
      if (button) act(button.action);
    });
    banner.on("reply", (_event, text) => act({ kind: "reply", text }));
    banner.on("close", () => {
      if (state.banners.get(item.id) === banner) state.banners.delete(item.id);
    });
    state.banners.set(item.id, banner);
    banner.show();
  }

  private async act(accountId: string, item: InboxItem, action: InboxAction): Promise<void> {
    const client = await this.deps.client(accountId);
    let handled = false;
    try {
      handled = client ? await actOnInboxItem(client, item, action) : false;
    } catch {
      handled = false;
    }
    if (!handled) this.deps.open(accountId, item);
    void this.poll();
  }

  private updateBadge(): void {
    let count = 0;
    for (const inbox of this.inboxes.values()) count += inbox.needsYou;
    this.deps.setBadge(count);
  }
}
