// Opening a chat reads the dock's links and artifacts once. History arriving
// after the dock mounts (the first page, then older pages) is not a change:
// only events newer than the loaded history re-read them.
import type { SessionEvent } from "@opengeni/sdk";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";

import { AppContext, type AppContextValue } from "../src/app/app-context";
import { useSessionLinks } from "../src/app/components/session/linked-panel";
import {
  latestSequenceAfter,
  useSessionHistoryBaseline,
} from "../src/hooks/use-live-session-events";
import { SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

function event(sequence: number, type: string): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload: {},
    occurredAt: "2026-11-26T10:00:00.000Z",
  } as unknown as SessionEvent;
}

type Props = { events: SessionEvent[]; ready: boolean };

let linkReads = 0;
const linksContext = {
  client: {
    listSessionLinks: async () => {
      linkReads += 1;
      return { links: [] };
    },
  },
} as unknown as AppContextValue;

function LinksContext({ children }: { children: ReactNode }) {
  return <AppContext.Provider value={linksContext}>{children}</AppContext.Provider>;
}

function useDockLinks({ events, ready }: Props) {
  const historyBaseline = useSessionHistoryBaseline(SESSION_ID, events, ready);
  return useSessionLinks({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    events,
    historyBaseline,
  });
}

describe("dock reads when a chat opens", () => {
  test("links are read once while the history loads, and again only for a newer change", async () => {
    linkReads = 0;
    const reads = () => linkReads;
    const initial: Props = { events: [], ready: false };
    const hook = await renderHook(useDockLinks, initial, { wrapper: LinksContext });
    await flush(20);
    // The history has not loaded yet: nothing to compare a change with.
    expect(reads()).toBe(0);

    // The newest page arrives with an earlier links change in it.
    const tail = [event(40, "session.links.changed"), event(41, "turn.completed")];
    await hook.rerender({ events: tail, ready: true });
    await flush(20);
    expect(reads()).toBe(1);
    expect(hook.result.current.status).toBe("ready");

    // Older pages fill in, with more links changes far in the past.
    const older = [event(3, "session.links.changed"), event(9, "session.links.changed")];
    await hook.rerender({ events: [...older, ...tail], ready: true });
    await flush(20);
    expect(reads()).toBe(1);

    // A live links change re-reads.
    await hook.rerender({
      events: [...older, ...tail, event(42, "session.links.changed")],
      ready: true,
    });
    await flush(20);
    expect(reads()).toBe(2);
    await hook.unmount();
  });

  test("the refresh key ignores older history and waits for the baseline", () => {
    const isTurnEnd = (candidate: SessionEvent) => candidate.type === "turn.completed";
    const tail = [event(40, "turn.completed"), event(41, "message")];
    expect(latestSequenceAfter(tail, null, isTurnEnd)).toBeNull();
    expect(latestSequenceAfter(tail, 41, isTurnEnd)).toBe(0);
    expect(latestSequenceAfter([event(2, "turn.completed"), ...tail], 41, isTurnEnd)).toBe(0);
    expect(latestSequenceAfter([...tail, event(50, "turn.completed")], 41, isTurnEnd)).toBe(50);
  });

  test("the session route renders one dock across loading and loaded", () => {
    // A dock that moves between parent slots, or loses its key, remounts once
    // the history arrives and repeats every dock read (capabilities, capture,
    // links, artifacts) a few hundred milliseconds after opening the chat.
    const source = readFileSync(new URL("../src/app/routes/session.tsx", import.meta.url), "utf8");
    const keyed = source.match(/<SessionDock\s+key=\{SESSION_DOCK_KEY\}/g) ?? [];
    const all = source.match(/<SessionDock\b/g) ?? [];
    expect(all.length).toBe(2);
    expect(keyed.length).toBe(all.length);
    expect(source).toContain(
      "<SessionStartupProvider session={null}>{loadingView}</SessionStartupProvider>",
    );
  });
});
