import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  SESSION_READ_ACKNOWLEDGEMENT_RETRY_MS,
  useSessionReadAcknowledgement,
  type UseSessionReadAcknowledgementInput,
} from "../src/hooks/use-session-read-acknowledgement";
import { readAcknowledgementFrontier } from "../src/session-attention-model";
import { SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

type Acknowledgement = {
  workspaceId: string;
  sessionId: string;
  request: { unread?: boolean; acknowledgedThroughSequence?: number };
};

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(0).toISOString(),
    turnId: "turn-1",
    clientEventId: null,
  } as unknown as SessionEvent;
}

const userMessage = (sequence: number) => event(sequence, "user.message", { text: "Hi" });
const delta = (sequence: number) => event(sequence, "agent.message.delta", { delta: "Hel" });
const reply = (sequence: number) =>
  event(sequence, "agent.message.completed", { text: "Hello", phase: "final_answer" });
const turnCompleted = (sequence: number) => event(sequence, "turn.completed", { output: "Hello" });

function recordingClient(respond: (call: number) => Promise<unknown> = async () => ({})): {
  client: UseSessionReadAcknowledgementInput["client"];
  calls: Acknowledgement[];
} {
  const calls: Acknowledgement[] = [];
  return {
    calls,
    client: {
      updateSessionAttention: (workspaceId, sessionId, request) => {
        calls.push({ workspaceId, sessionId, request });
        return respond(calls.length);
      },
    },
  };
}

let mounted: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of mounted) await unmount();
  mounted = [];
});

async function render(input: UseSessionReadAcknowledgementInput) {
  const view = await renderHook(
    (props: UseSessionReadAcknowledgementInput) => useSessionReadAcknowledgement(props),
    input,
  );
  mounted.push(view.unmount);
  await flush();
  return view;
}

const readSession = { id: SESSION_ID, unread: false, lastSequence: 1 };

describe("readAcknowledgementFrontier", () => {
  test("an unread session is acknowledged through its last sequence", () => {
    expect(readAcknowledgementFrontier({ unread: true, lastSequence: 40 }, 0)).toEqual({
      readThrough: 40,
      unread: true,
    });
  });

  test("a read session needs nothing until a newer attention boundary arrives", () => {
    expect(readAcknowledgementFrontier({ unread: false, lastSequence: 40 }, 38).unread).toBe(false);
    expect(readAcknowledgementFrontier({ unread: false, lastSequence: 40 }, 52)).toEqual({
      readThrough: 52,
      unread: true,
    });
  });

  test("no session row means nothing to acknowledge yet", () => {
    expect(readAcknowledgementFrontier(null, 0)).toEqual({ readThrough: 0, unread: false });
  });
});

describe("useSessionReadAcknowledgement", () => {
  test("a watched reply is acknowledged once through its boundary, not per streamed token", async () => {
    const { client, calls } = recordingClient();
    const input = {
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: readSession,
      events: [userMessage(1)],
      active: true,
    };
    const view = await render(input);
    expect(calls).toEqual([]);

    await view.rerender({ ...input, events: [userMessage(1), delta(2)] });
    await view.rerender({ ...input, events: [userMessage(1), delta(2), delta(3)] });
    await flush();
    expect(calls).toEqual([]);

    await view.rerender({ ...input, events: [userMessage(1), delta(2), delta(3), reply(4)] });
    await flush();
    expect(calls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        request: { unread: false, acknowledgedThroughSequence: 4 },
      },
    ]);

    // Re-rendering the same frontier (new array identity) sends nothing more.
    await view.rerender({ ...input, events: [userMessage(1), delta(2), delta(3), reply(4)] });
    await flush();
    expect(calls).toHaveLength(1);

    // The turn's completion is the next boundary.
    await view.rerender({
      ...input,
      events: [userMessage(1), delta(2), delta(3), reply(4), turnCompleted(5)],
    });
    await flush();
    expect(calls.map((call) => call.request.acknowledgedThroughSequence)).toEqual([4, 5]);
  });

  test("a reply nobody watches stays unread until the conversation is seen", async () => {
    const { client, calls } = recordingClient();
    const input = {
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: readSession,
      events: [userMessage(1), reply(2)],
      active: false,
    };
    const view = await render(input);
    expect(calls).toEqual([]);

    await view.rerender({ ...input, events: [userMessage(1), reply(2), turnCompleted(3)] });
    await flush();
    expect(calls).toEqual([]);

    await view.rerender({
      ...input,
      events: [userMessage(1), reply(2), turnCompleted(3)],
      active: true,
    });
    await flush();
    expect(calls.map((call) => call.request.acknowledgedThroughSequence)).toEqual([3]);

    // Looking away and back at the same frontier does not acknowledge again.
    const events = [userMessage(1), reply(2), turnCompleted(3)];
    await view.rerender({ ...input, events, active: false });
    await view.rerender({ ...input, events, active: true });
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("opening an unread conversation acknowledges through the session's last sequence", async () => {
    const { client, calls } = recordingClient();
    await render({
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: { id: SESSION_ID, unread: true, lastSequence: 9 },
      events: [userMessage(1), reply(2)],
      active: true,
    });
    expect(calls.map((call) => call.request)).toEqual([
      { unread: false, acknowledgedThroughSequence: 9 },
    ]);
  });

  test("a session row that belongs to another conversation is ignored", async () => {
    const { client, calls } = recordingClient();
    await render({
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: { id: "another-session", unread: true, lastSequence: 9 },
      events: [],
      active: true,
    });
    expect(calls).toEqual([]);
  });

  test("a client without the attention mutation is left alone", async () => {
    const view = await render({
      client: {},
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: { id: SESSION_ID, unread: true, lastSequence: 9 },
      events: [reply(9)],
      active: true,
    });
    expect(view.result.current).toBeUndefined();
  });

  test("a transient failure is retried once, then waits for the next foreground change", async () => {
    const { client, calls } = recordingClient(async () => {
      throw new Error("network down");
    });
    const events = [userMessage(1), reply(2)];
    const input = {
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: readSession,
      events,
      active: true,
    };
    const view = await render(input);
    expect(calls).toHaveLength(1);
    await flush(SESSION_READ_ACKNOWLEDGEMENT_RETRY_MS + 50);
    expect(calls).toHaveLength(2);
    await flush(SESSION_READ_ACKNOWLEDGEMENT_RETRY_MS + 50);
    expect(calls).toHaveLength(2);

    await view.rerender({ ...input, active: false });
    await view.rerender({ ...input, active: true });
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.request.acknowledgedThroughSequence === 2)).toBe(true);
  });

  test("a permanent rejection stops acknowledging that conversation", async () => {
    const { client, calls } = recordingClient(async () => {
      throw new OpenGeniApiError(404, '{"error":"route_not_allowed"}');
    });
    const input = {
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: readSession,
      events: [userMessage(1), reply(2)],
      active: true,
    };
    const view = await render(input);
    await flush(SESSION_READ_ACKNOWLEDGEMENT_RETRY_MS + 50);
    expect(calls).toHaveLength(1);

    await view.rerender({ ...input, events: [userMessage(1), reply(2), turnCompleted(3)] });
    await view.rerender({
      ...input,
      events: [userMessage(1), reply(2), turnCompleted(3)],
      active: false,
    });
    await view.rerender({ ...input, events: [userMessage(1), reply(2), turnCompleted(3)] });
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("a newer reply during an in-flight acknowledgement is acknowledged too", async () => {
    let release: () => void = () => undefined;
    const { client, calls } = recordingClient(
      (call) =>
        new Promise((resolve) => {
          if (call === 1) release = () => resolve({});
          else resolve({});
        }),
    );
    const input = {
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      session: readSession,
      events: [userMessage(1), reply(2)],
      active: true,
    };
    const view = await render(input);
    await view.rerender({ ...input, events: [userMessage(1), reply(2), turnCompleted(3)] });
    await flush();
    release();
    await flush();
    expect(calls.map((call) => call.request.acknowledgedThroughSequence)).toEqual([2, 3]);
  });
});
