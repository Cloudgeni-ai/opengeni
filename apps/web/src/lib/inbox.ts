// The person's inbox, shared by the rail entry and the Inbox page. One poll
// (30 s, faster while the page is open, and on focus) keeps both in step;
// any action refreshes immediately.
import type { InboxItem, ListInboxResponse, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useAppContext } from "@/context";

type InboxState = {
  data: ListInboxResponse | null;
  error: unknown;
  loading: boolean;
};

type InboxClient = Pick<OpenGeniClient, "listInbox">;

const EMPTY: InboxState = { data: null, error: null, loading: true };
const NO_INBOX: InboxState = { data: null, error: null, loading: false };

/**
 * Only a signed-in person has an inbox (the API refuses keys, services and
 * development subjects), so nothing polls it for anyone else.
 */
export function hasInbox(
  context: { subjectId: string; credential?: unknown } | null | undefined,
): boolean {
  return Boolean(context?.subjectId.startsWith("user:") && !context.credential);
}

export class InboxStore {
  private state: InboxState = EMPTY;
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private generation = 0;

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
        this.set({ data, error: null, loading: false });
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

  /** Apply a local change at once (an answered item leaves) before the server confirms. */
  patchItems(update: (items: InboxItem[]) => InboxItem[]) {
    const data = this.state.data;
    if (!data) return;
    const items = update(data.items);
    const now = Date.now();
    const awake = items.filter(
      (item) => item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now,
    );
    this.set({
      data: {
        items,
        needsYouCount: awake.filter((item) => isNeedsYouKind(item.kind)).length,
        unreadCount: awake.filter((item) => item.unread).length,
      },
    });
  }
}

const stores = new WeakMap<InboxClient, InboxStore>();

function storeFor(client: InboxClient): InboxStore {
  let store = stores.get(client);
  if (!store) {
    store = new InboxStore(client);
    stores.set(client, store);
  }
  return store;
}

/** The inbox, polled while mounted. `pollMs` is shortened while the Inbox page is open. */
export function useInbox(options: { pollMs?: number; enabled?: boolean } = {}) {
  const { client, accessContext } = useAppContext();
  const store = storeFor(client);
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
  return { ...(person ? state : NO_INBOX), refresh, patchItems };
}

/** Questions, approvals and paused goals wait on the person; notes and replies don't. */
export function isNeedsYouKind(kind: InboxItem["kind"]): boolean {
  return kind === "question" || kind === "approval" || kind === "goal_paused";
}

/** What waits on the person: needs-you items plus unread notes and replies, unsnoozed. */
export function inboxAttentionCount(data: ListInboxResponse | null): number {
  if (!data) return 0;
  const now = Date.now();
  return data.items.filter(
    (item) =>
      (item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now) &&
      (isNeedsYouKind(item.kind) || item.unread),
  ).length;
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
  useEffect(() => {
    if (!personal) return;
    const store = storeFor(client);
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
  }, [client, personal, sessionId]);
}
