// The person's inbox, shared by the rail entry and the Inbox page. One poll
// (30 s, faster while the page is open, and on focus) keeps both in step;
// any action refreshes immediately.
import { accessContextHasInbox } from "@opengeni/contracts";
import type { ChatClient } from "@opengeni/sdk";
import type {
  BillingCreditNotification,
  InboxItem,
  ListInboxResponse,
  OpenGeniClient,
} from "@opengeni/sdk";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "./toast";

import { useAppContext, type AppContextValue } from "../app-context";
import { userErrorText } from "../../ui/api-error";
import { inboxBillingAccountIds } from "./inbox-billing";

type InboxState = {
  data: ListInboxResponse | null;
  error: unknown;
  loading: boolean;
};

type InboxClient = Pick<ChatClient<OpenGeniClient>, "listInbox"> &
  Partial<Pick<ChatClient<OpenGeniClient>, "markBillingCreditNotificationRead">>;

const EMPTY: InboxState = { data: null, error: null, loading: true };
const NO_INBOX: InboxState = { data: null, error: null, loading: false };

/**
 * Only a person has an inbox: a signed-in person, or a local install's one
 * built-in human. The API refuses keys, services, agents and other development
 * subjects, so nothing polls it for anyone else.
 */
export function hasInbox(context: Parameters<typeof accessContextHasInbox>[0]): boolean {
  return accessContextHasInbox(context);
}

export class InboxStore {
  private state: InboxState = EMPTY;
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private active = true;
  private billingReads = new Map<string, Promise<void>>();
  private readBillingIds = new Set<string>();

  constructor(private readonly client: InboxClient) {}

  get snapshot(): InboxState {
    return this.state;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<InboxState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  refresh = async (): Promise<void> => {
    if (!this.active) return;
    if (this.inFlight) return await this.inFlight;
    const request = ++this.generation;
    this.inFlight = this.client
      .listInbox()
      .then((data) => {
        if (request !== this.generation) return;
        // A body without an item list is not an inbox (a proxy or stub answered);
        // treat it like a failed load rather than let the rail badge crash the app.
        if (!Array.isArray(data?.items)) {
          this.set({ error: new Error("The inbox response had no items."), loading: false });
          return;
        }
        this.set({ data: this.withBillingReads(data), error: null, loading: false });
      })
      .catch((error: unknown) => {
        // Keep the last good list on a transient failure; the page says so.
        if (request === this.generation) this.set({ error, loading: false });
      })
      .finally(() => {
        this.inFlight = null;
      });
    return await this.inFlight;
  };

  /** Retire the old viewer's cache and pending responses before exposing a new viewer. */
  retire() {
    this.active = false;
    this.generation++;
    this.state = EMPTY;
  }

  private withBillingReads(data: ListInboxResponse): ListInboxResponse {
    if (!data.billingNotifications) return data;
    return {
      ...data,
      billingNotifications: data.billingNotifications.map((notice) =>
        this.readBillingIds.has(notice.id) ? { ...notice, read: true } : notice,
      ),
    };
  }

  /** A billing read is recipient/account scoped, never an inbox-item update. */
  markBillingRead = async (notice: BillingCreditNotification): Promise<void> => {
    if (!this.active || notice.read) return;
    const pending = this.billingReads.get(notice.id);
    if (pending) return pending;
    const client = this.client;
    if (!client.markBillingCreditNotificationRead)
      throw new Error("Billing notifications are unavailable.");
    const request = client
      .markBillingCreditNotificationRead(notice.id, { accountId: notice.accountId })
      .then((result) => {
        if (!result.ok) throw new Error("The notification could not be marked read.");
        if (!this.active) return;
        this.readBillingIds.add(notice.id);
        if (this.state.data) this.set({ data: this.withBillingReads(this.state.data) });
      })
      .finally(() => this.billingReads.delete(notice.id));
    this.billingReads.set(notice.id, request);
    return request;
  };

  /** Apply a local change at once (an answered item leaves) before the server confirms. */
  patchItems(update: (items: InboxItem[]) => InboxItem[]) {
    const data = this.state.data;
    if (!this.active || !data) return;
    const items = update(data.items);
    const now = Date.now();
    const awake = items.filter(
      (item) => item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now,
    );
    this.set({
      data: {
        ...data,
        items,
        needsYouCount: awake.filter((item) => isNeedsYouKind(item.kind)).length,
        unreadCount: awake.filter((item) => item.unread).length,
      },
    });
  }
}

const stores = new WeakMap<InboxClient, { identity: string; store: InboxStore }>();

export function inboxStoreFor(
  context: Pick<AppContextValue, "client" | "accessContext" | "accessKeyVersion" | "authSession">,
): InboxStore {
  const { client, accessContext, accessKeyVersion, authSession } = context;
  // The SDK client can outlive a cookie/key change. Include live grants so a
  // demotion cannot keep showing the previous owner's billing information.
  const identity = JSON.stringify([accessKeyVersion, authSession?.user.id, accessContext]);
  let current = stores.get(client);
  if (!current || current.identity !== identity) {
    current?.store.retire();
    current = { identity, store: new InboxStore(client) };
    stores.set(client, current);
  }
  return current.store;
}

/** The inbox, polled while mounted. `pollMs` is shortened while the Inbox page is open. */
export function useInbox(
  options: {
    pollMs?: number | undefined;
    enabled?: boolean | undefined;
    workspaceId?: string | undefined;
  } = {},
) {
  const context = useAppContext();
  const { accessContext, workspaces } = context;
  const store = inboxStoreFor(context);
  const person = hasInbox(accessContext);
  const enabled = (options.enabled ?? true) && person;
  const pollMs = options.pollMs ?? 30_000;
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot,
    () => EMPTY,
  );
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void store.refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, pollMs, store]);

  const refresh = useCallback(() => store.refresh(), [store]);
  const patchItems = useCallback(
    (update: (items: InboxItem[]) => InboxItem[]) => store.patchItems(update),
    [store],
  );
  const accountId = workspaces.find((workspace) => workspace.id === options.workspaceId)?.accountId;
  const billingAllowed = accountId && inboxBillingAccountIds(accessContext).includes(accountId);
  // The personal inbox remains cross-workspace. Billing is shown only for the
  // active organization, never inferred from a workspace viewer's grants.
  const data = state.data
    ? {
        ...state.data,
        billingNotifications: billingAllowed
          ? (state.data.billingNotifications?.filter((notice) => notice.accountId === accountId) ??
            [])
          : [],
      }
    : null;
  return {
    ...(person ? { ...state, data } : NO_INBOX),
    refresh,
    patchItems,
    markBillingRead: store.markBillingRead,
  };
}

/** Questions, approvals and paused goals wait on the person; notes and replies don't. */
export function isNeedsYouKind(kind: InboxItem["kind"]): boolean {
  return kind === "question" || kind === "approval" || kind === "goal_paused";
}

/** Rail attention only; API chat counts keep their historical meaning. */
export function inboxAttentionCount(data: ListInboxResponse | null): number {
  if (!data) return 0;
  const now = Date.now();
  return (
    data.items.filter(
      (item) =>
        (item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now) &&
        (isNeedsYouKind(item.kind) || item.unread),
    ).length + (data.billingNotifications?.filter((notice) => !notice.read).length ?? 0)
  );
}

/**
 * Looking at a session reads its replies and agent notes in the inbox (they
 * stay until cleared): on opening it and on leaving it, so a reply that
 * arrived while it was open is read too. Needs-you items are untouched.
 */
export function useReadSessionInbox(sessionId: string) {
  const context = useAppContext();
  const personal = hasInbox(context.accessContext);
  const client = context.client;
  const store = inboxStoreFor(context);
  useEffect(() => {
    if (!personal) return;
    const read = async () => {
      const data = await client.listInbox().catch(() => null);
      const unread = (data?.items ?? []).filter(
        (item) =>
          item.sessionId === sessionId &&
          item.unread &&
          (item.kind === "reply" || item.kind === "notification"),
      );
      if (unread.length === 0) return;
      await Promise.all(
        unread.map((item) =>
          client.updateInboxItem(item.id, { seen: true }).catch(() => undefined),
        ),
      );
      store.patchItems((items) =>
        items.map((item) =>
          unread.some((each) => each.id === item.id) ? { ...item, unread: false } : item,
        ),
      );
    };
    void read();
    return () => void read();
  }, [client, personal, sessionId, store]);
}

/**
 * "schedule" when the session is one run of a schedule that starts a new
 * session per run: the mute then covers every run of that schedule.
 */
export type SessionRepliesMuteScope = "session" | "schedule";

export type SessionRepliesMute = {
  muted: boolean;
  busy: boolean;
  toggle: () => void;
  scope?: SessionRepliesMuteScope | undefined;
};

/** The session menu's mute action, naming the schedule when it covers one. */
export function repliesMuteLabel(mute: Pick<SessionRepliesMute, "muted" | "scope">): string {
  if (mute.scope === "schedule") {
    return mute.muted ? "Unmute this automation's replies" : "Mute this automation's replies";
  }
  return mute.muted ? "Unmute replies" : "Mute replies";
}

/**
 * The signed-in person's mute on a top-level session's replies. Null when it
 * does not apply (a sub-agent, no inbox) or the server cannot say, so the
 * menu offers it only where it works.
 */
export function useSessionRepliesMute(session: {
  workspaceId: string;
  id: string;
  parentSessionId: string | null;
}): SessionRepliesMute | null {
  const context = useAppContext();
  const client = context.client;
  const store = inboxStoreFor(context);
  const applies = hasInbox(context.accessContext) && session.parentSessionId === null;
  const [muted, setMuted] = useState<boolean | null>(null);
  const [scope, setScope] = useState<SessionRepliesMuteScope>("session");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMuted(null);
    setScope("session");
    if (!applies) return;
    let current = true;
    client
      .getSessionInboxMute(session.workspaceId, session.id)
      .then((value) => {
        if (!current) return;
        setMuted(value.repliesMuted);
        setScope(value.scope ?? "session");
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [applies, client, session.id, session.workspaceId]);
  const toggle = useCallback(() => {
    if (muted === null || busy) return;
    const next = !muted;
    setBusy(true);
    client
      .setSessionInboxMute(session.workspaceId, session.id, { repliesMuted: next })
      .then((value) => {
        setMuted(value.repliesMuted);
        const nextScope = value.scope ?? "session";
        setScope(nextScope);
        void store.refresh();
        const subject = nextScope === "schedule" ? "Replies from this automation" : "Replies";
        toast.success(
          value.repliesMuted
            ? `${subject} muted. Notifications and questions still reach you.`
            : `${subject} unmuted.`,
        );
      })
      .catch((error: unknown) => {
        const what = scope === "schedule" ? "this automation's replies" : "replies";
        toast.error(next ? `Couldn't mute ${what}.` : `Couldn't unmute ${what}.`, {
          description: userErrorText(error),
        });
      })
      .finally(() => setBusy(false));
  }, [busy, client, muted, scope, session.id, session.workspaceId, store]);
  return applies && muted !== null ? { muted, busy, toggle, scope } : null;
}
