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

function titleEvent(title: string, sequence = 1, source: "user" | "agent" = "user"): SessionEvent {
  return {
    id: `title-event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type: "session.title_set",
    payload: { title, source },
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

  test("does not let historical title replay undo an authoritative row quarantine", async () => {
    const quarantinedSession = {
      ...serverSession,
      lastSequence: 7,
      title: "New conversation",
      titleSource: "agent",
    } as Session;
    const client = fakeClient({ getSession: async () => quarantinedSession });
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

    // A shared route feed can publish its historical tail only after the row
    // fetch completes. Sequence 7 is already represented by the fetched row,
    // whose title was quarantined independently of the append-only event.
    await hook.rerender([titleEvent("Password: swordfish", 7, "agent")]);
    await flush();
    expect(hook.result.current.session).toMatchObject({
      title: "New conversation",
      titleSource: "agent",
    });

    // A genuinely newer title event still updates the live projection.
    await hook.rerender([
      titleEvent("Password: swordfish", 7, "agent"),
      titleEvent("OAuth callback failures", 8, "agent"),
    ]);
    await flush();
    expect(hook.result.current.session).toMatchObject({
      title: "OAuth callback failures",
      titleSource: "agent",
    });
    await hook.unmount();
  });
});
