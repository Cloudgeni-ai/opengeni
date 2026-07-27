import { describe, expect, test } from "bun:test";
import type { Session, SessionEvent } from "@opengeni/sdk";

import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { useSession } from "../src/hooks/use-session";

registerDom();

const serverSession = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  lastSequence: 0,
  title: null,
  titleSource: null,
} as Session;

function titleEvent(title: string): SessionEvent {
  return {
    id: "title-event-1",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    type: "session.title_set",
    payload: { title, source: "user" },
    occurredAt: "2026-07-27T00:00:00.000Z",
    clientEventId: null,
    turnId: null,
  };
}

describe("useSession", () => {
  test("keeps its live title projection identity stable between parent renders", async () => {
    const client = fakeClient({ getSession: async () => serverSession });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useSession(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events,
        }),
      [] as SessionEvent[],
    );
    await flush();

    await hook.rerender([titleEvent("Renamed")]);
    await flush();
    const renamed = hook.result.current.session;
    expect(renamed?.title).toBe("Renamed");

    // The route/context bridge may re-render the hook after applying the
    // title. Reusing the projection prevents that render from retriggering its
    // session synchronization effect indefinitely.
    await hook.rerender([titleEvent("Renamed")]);
    expect(hook.result.current.session).toBe(renamed);
    await hook.unmount();
  });
});
