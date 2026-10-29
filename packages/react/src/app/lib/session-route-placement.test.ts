import { expect, test } from "bun:test";
import type { SessionCreationHandoff } from "../app-context";
import { sessionRouteAppState, sessionRouteCreationHandoff } from "./session-route-placement";

function appContext() {
  const calls: string[] = [];
  return {
    calls,
    setSession: (value: unknown) => void calls.push(`session:${String(value)}`),
    setConnectionState: (value: unknown) => void calls.push(`connection:${String(value)}`),
    sessionEventFeedStore: { owner: "app" },
  };
}

test("the page's chat writes the app's open-chat state", () => {
  const context = appContext();
  const state = sessionRouteAppState("page", context, { owner: "panel" });
  expect(state.routed).toBe(true);
  expect(state.sessionEventFeedStore).toBe(context.sessionEventFeedStore);
  state.setSession("s-1");
  state.setConnectionState("live");
  expect(context.calls).toEqual(["session:s-1", "connection:live"]);
});

test("a chat in a panel keeps its session, connection and events to itself", () => {
  const context = appContext();
  const panelFeed = { owner: "panel" };
  const state = sessionRouteAppState("panel", context, panelFeed);
  expect(state.routed).toBe(false);
  expect(state.sessionEventFeedStore).toBe(panelFeed);
  state.setSession("s-1");
  state.setConnectionState("live");
  expect(context.calls).toEqual([]);
});

const handoff = (id: string) => ({ session: { id } }) as unknown as SessionCreationHandoff;

test("a host's creation handoff wins; the app's applies only to the page's own chat", () => {
  const given = handoff("s-1");
  const app = handoff("s-1");
  const base = { sessionId: "s-1", app, appSession: { id: "s-1" } };
  expect(sessionRouteCreationHandoff({ ...base, given, routed: false })).toBe(given);
  expect(sessionRouteCreationHandoff({ ...base, given, routed: true })).toBe(given);
  expect(sessionRouteCreationHandoff({ ...base, given: null, routed: true })).toBe(app);
  // The panel never takes over a chat the page just created.
  expect(sessionRouteCreationHandoff({ ...base, given: null, routed: false })).toBeNull();
  // A handoff for another chat is ignored.
  expect(sessionRouteCreationHandoff({ ...base, given: handoff("s-2"), routed: true })).toBe(app);
  expect(
    sessionRouteCreationHandoff({ ...base, appSession: { id: "s-2" }, given: null, routed: true }),
  ).toBeNull();
});
