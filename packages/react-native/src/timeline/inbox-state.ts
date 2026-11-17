// The inbox list and its state, without any of its UI, so the state is
// shared (the app's badge and its Inbox screen) and tested on its own.
import type { ChatClient } from "@opengeni/sdk";
import type { InboxItem, ListInboxResponse, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

export type NativeInboxClient = Pick<
  ChatClient<OpenGeniClient>,
  | "listInbox"
  | "updateInboxItem"
  | "sendApprovalDecision"
  | "getHumanInputRequest"
  | "submitHumanInputResponse"
>;

type InboxState = { data: ListInboxResponse | null; error: unknown; loading: boolean };

export function snoozedNow(item: InboxItem, now: number): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now;
}

/** Questions, approvals and paused goals wait on the person; notes and replies don't. */
export function isNeedsYouKind(kind: InboxItem["kind"]): boolean {
  return kind === "question" || kind === "approval" || kind === "goal_paused";
}

/** What waits on the person right now: needs-you items plus unread notes, unsnoozed. */
export function nativeInboxAttentionCount(data: ListInboxResponse | null): number {
  if (!data) return 0;
  const now = Date.now();
  return data.items.filter(
    (item) => !snoozedNow(item, now) && (isNeedsYouKind(item.kind) || item.unread),
  ).length;
}

/**
 * An item as this app reads it. Servers from before rich notifications leave
 * out the subtitle, facts, link and moment; read those as empty.
 */
function normalizeInboxItem(item: InboxItem): InboxItem {
  return {
    ...item,
    subtitle: item.subtitle ?? "",
    facts: Array.isArray(item.facts) ? item.facts : [],
    link: item.link ?? null,
    eventSequence: item.eventSequence ?? null,
    choices: Array.isArray(item.choices) ? item.choices : [],
    serverQuestion: item.serverQuestion ?? null,
  };
}

const NOTHING_YET: InboxState = { data: null, error: null, loading: true };

/**
 * The person's inbox, refreshed on an interval, on foreground and after every
 * action. `enabled: false` (signed out, still loading) reads nothing.
 */
export function useNativeInbox(
  client: NativeInboxClient,
  options: { pollMs?: number; enabled?: boolean } = {},
) {
  // What was read belongs to the client that read it: another account's
  // client starts empty, and a late answer for the last client never shows.
  const [held, setHeld] = useState<InboxState & { client: NativeInboxClient }>({
    client,
    ...NOTHING_YET,
  });
  const state: InboxState = held.client === client ? held : NOTHING_YET;
  const enabled = options.enabled ?? true;
  const pollMs = options.pollMs ?? 30_000;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++generation.current;
    try {
      const listed = await client.listInbox();
      const data = { ...listed, items: listed.items.map(normalizeInboxItem) };
      if (request === generation.current) setHeld({ client, data, error: null, loading: false });
    } catch (error) {
      if (request === generation.current)
        setHeld((current) =>
          current.client === client
            ? { ...current, error, loading: false }
            : { client, data: null, error, loading: false },
        );
    }
  }, [client, enabled]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [enabled, pollMs, refresh]);
  const patch = useCallback((update: (items: InboxItem[]) => InboxItem[]) => {
    setHeld((current) =>
      current.data
        ? { ...current, data: { ...current.data, items: update(current.data.items) } }
        : current,
    );
  }, []);
  return { ...state, refresh, patch };
}
