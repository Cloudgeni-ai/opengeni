import { describe, expect, test } from "bun:test";
import { OpenGeniClient, type Session, type SessionEvent } from "@opengeni/sdk";

import { registerDom, renderHook, flush, actRun } from "./render-hook";
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
    expect(hook.result.current.readRevision).toBe(1);

    await hook.rerender([titleEvent("Renamed")]);
    await flush();
    const renamed = hook.result.current.session;
    expect(renamed?.title).toBe("Renamed");
    expect(hook.result.current.readRevision).toBe(1);

    // The route/context bridge may re-render the hook after applying the
    // title. Reusing the projection prevents that render from retriggering its
    // session synchronization effect indefinitely.
    await hook.rerender([titleEvent("Renamed")]);
    expect(hook.result.current.session).toBe(renamed);
    await hook.unmount();
  });

  test("increments its authoritative read revision only after a trailing fresh detail read", async () => {
    const options: Array<{ fresh?: boolean } | undefined> = [];
    let channelId = "channel-old";
    const client = fakeClient({
      getSession: async (_workspaceId, _sessionId, requestOptions) => {
        options.push(requestOptions);
        return { ...serverSession, channelId };
      },
    });
    const hook = await renderHook(
      () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush();

    expect(hook.result.current.readRevision).toBe(1);
    expect(options.map((option) => option?.fresh)).toEqual([true]);

    channelId = "channel-new";
    await actRun(async () => await hook.result.current.refresh());
    expect(hook.result.current.readRevision).toBe(2);
    expect(hook.result.current.session?.channelId).toBe("channel-new");
    expect(options.map((option) => option?.fresh)).toEqual([true, true]);
    await hook.unmount();
  });

  test("cancels its session detail read when the hook unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = fakeClient({
      getSession: async (_workspaceId, _sessionId, requestOptions) => {
        requestSignal = requestOptions?.signal;
        return await new Promise<Session>(() => {});
      },
    });
    const hook = await renderHook(
      () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush();

    expect(requestSignal?.aborted).toBe(false);
    await hook.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("captures shared causality when a queued fresh detail GET actually starts", async () => {
    let requests = 0;
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let channelId = "channel-old";
    let causalGeneration = 0;
    const beginRead = () => ++causalGeneration;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () => {
        requests += 1;
        const requestChannel = channelId;
        if (requests === 1) await activeGate;
        return new Response(JSON.stringify({ ...serverSession, channelId: requestChannel }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const active = client.getSession(WORKSPACE_ID, SESSION_ID);
    const hook = await renderHook(
      () =>
        useSession(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: [],
          beginRead,
        }),
      undefined,
    );
    await flush();
    expect(requests).toBe(1);
    expect(hook.result.current.readGeneration).toBe(0);

    const laterListGeneration = beginRead();
    channelId = "channel-new";
    releaseActive();
    await active;
    await flush();

    expect(requests).toBe(2);
    expect(hook.result.current.session?.channelId).toBe("channel-new");
    expect(hook.result.current.readGeneration).toBeGreaterThan(laterListGeneration);
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
