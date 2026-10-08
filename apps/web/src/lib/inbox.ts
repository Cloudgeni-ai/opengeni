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

/** Inbox access is person-bound; API-key and unauthenticated browser clients must not poll it. */
export function canUsePersonalInbox(authMode: string, hasManagedSession: boolean): boolean {
  return authMode === "managedSession" && hasManagedSession;
}

class InboxStore {
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
        if (request === this.generation) this.set({ data, error: null, loading: false });
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
  const { client } = useAppContext();
  const store = storeFor(client);
  const enabled = options.enabled ?? true;
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
  return { ...state, refresh, patchItems };
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
