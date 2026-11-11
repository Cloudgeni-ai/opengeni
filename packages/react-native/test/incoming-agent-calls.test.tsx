import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { AgentCall, OpenGeniClient } from "@opengeni/sdk";
import { registerDom, renderHook } from "../../react/test/render-hook";
import { incomingEndReason, useIncomingAgentCalls } from "../src/realtime/incoming-agent-calls";
import type {
  NativeCallAdapter,
  NativeCallEvent,
  NativeIncomingCall,
} from "../src/realtime/native-call";

registerDom();

const ringing: NativeIncomingCall = {
  callId: "44444444-4444-4444-8444-444444444444",
  sessionId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "user:ada",
  title: "Deploy watcher",
  reason: "Production is down",
  ringUntil: null,
  state: "ringing",
};

function serverCall(patch: Partial<AgentCall>): AgentCall {
  return {
    id: ringing.callId,
    workspaceId: ringing.workspaceId,
    sessionId: ringing.sessionId,
    callerLabel: "Deploy watcher",
    reason: "Production is down",
    state: "ringing",
    ringUntil: "2026-10-26T18:00:40.000Z",
    createdAt: "2026-10-26T18:00:00.000Z",
    endedAt: null,
    answeredHere: false,
    ...patch,
  };
}

function fakes(server: { answer: AgentCall; current?: AgentCall }) {
  const log: string[] = [];
  let listener: ((event: NativeCallEvent) => void) | null = null;
  const call: NativeCallAdapter = {
    startCall: async () => undefined,
    reportConnected: () => undefined,
    endCall: async () => undefined,
    setMuted: async () => undefined,
    setSpeaker: async () => undefined,
    takeStartRequest: async () => null,
    subscribe: (next: (event: NativeCallEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    incoming: {
      getVoipToken: async () => "f".repeat(64),
      takeIncomingCalls: async () => [],
      endIncomingCall: (_callId: string, reason: string) => void log.push(`end:${reason}`),
    },
  } as unknown as NativeCallAdapter;
  const client = {
    getAgentCall: async () => server.current ?? serverCall({}),
    answerAgentCall: async (_ws: string, _id: string, options?: { device?: string }) => {
      log.push(`answer:${options?.device ? "named" : "anonymous"}`);
      return server.answer;
    },
    declineAgentCall: async () => {
      log.push("decline");
      return serverCall({ state: "declined" });
    },
  } as unknown as OpenGeniClient;
  return { call, client, log, emit: (event: NativeCallEvent) => listener?.(event) };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("incoming agent calls", () => {
  test("prepares once on ring, retains it through the answer claim, and starts only after winning", async () => {
    const { call, client, log, emit } = fakes({
      answer: serverCall({ state: "answered", answeredHere: true }),
    });
    let finish!: (result: AgentCall) => void;
    client.answerAgentCall = async () => {
      log.push("claim");
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const hook = await renderHook(
      () =>
        useIncomingAgentCalls({
          client,
          callAdapter: call,
          onRinging: () => void log.push("prepare"),
          onEnded: () => void log.push("release"),
          onAnswered: () => void log.push("start"),
        }),
      undefined,
    );
    await settle();
    await act(async () => {
      emit({ type: "incoming", call: ringing });
      emit({ type: "incoming", call: ringing });
    });
    expect(log).toEqual(["prepare"]);
    await act(async () =>
      emit({ type: "incomingAnswered", call: { ...ringing, state: "answered" } }),
    );
    expect(log).toEqual(["prepare", "claim"]);
    await act(async () => finish(serverCall({ state: "answered", answeredHere: true })));
    expect(log.at(-1)).toBe("start");
    expect(log).not.toContain("release");
    await hook.unmount();
  });

  test("a call ended during the answer request releases preparation and never starts late", async () => {
    const { call, client, log, emit } = fakes({ answer: serverCall({}) });
    let finish!: (result: AgentCall) => void;
    client.answerAgentCall = async () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const hook = await renderHook(
      () =>
        useIncomingAgentCalls({
          client,
          callAdapter: call,
          onRinging: () => void log.push("prepare"),
          onEnded: () => void log.push("release"),
          onAnswered: () => void log.push("start"),
        }),
      undefined,
    );
    await settle();
    await act(async () =>
      emit({ type: "incomingAnswered", call: { ...ringing, state: "answered" } }),
    );
    await act(async () => emit({ type: "ended", callId: ringing.callId }));
    await act(async () => finish(serverCall({ state: "answered", answeredHere: true })));
    expect(log).toEqual(["prepare", "release"]);
    await hook.unmount();
  });

  test("decline, remote settlement, timeout, and unmount release ring preparation", async () => {
    for (const ending of ["decline", "remote", "timeout", "unmount"] as const) {
      const { call, client, log, emit } = fakes({
        answer: serverCall({}),
        current: serverCall(ending === "remote" ? { state: "cancelled" } : {}),
      });
      const hook = await renderHook(
        () =>
          useIncomingAgentCalls({
            client,
            callAdapter: call,
            onRinging: () => void log.push("prepare"),
            onEnded: () => void log.push("release"),
            onAnswered: () => void log.push("start"),
          }),
        undefined,
      );
      await settle();
      await act(async () => emit({ type: "incoming", call: ringing }));
      if (ending === "decline")
        await act(async () =>
          emit({ type: "incomingDeclined", call: { ...ringing, state: "declined" } }),
        );
      if (ending === "timeout")
        await act(async () =>
          emit({ type: "incomingEnded", callId: ringing.callId, reason: "unanswered" }),
        );
      await hook.unmount();
      expect(log.filter((event) => event === "release")).toHaveLength(1);
      expect(log).not.toContain("start");
    }
  });

  test("answering on the ring screen claims the call and opens it here", async () => {
    const { call, client, log, emit } = fakes({
      answer: serverCall({ state: "answered", answeredHere: true }),
    });
    const answered: string[] = [];
    const hook = await renderHook(
      () =>
        useIncomingAgentCalls({
          client,
          callAdapter: call,
          onAnswered: (incoming) => void answered.push(incoming.sessionId),
        }),
      undefined,
    );
    await settle();
    await act(async () =>
      emit({ type: "incomingAnswered", call: { ...ringing, state: "answered" } }),
    );
    await settle();
    expect(log).toEqual(["answer:named"]);
    expect(answered).toEqual([ringing.sessionId]);
    await hook.unmount();
  });

  test("a phone that lost the race to another stops ringing and opens nothing", async () => {
    const { call, client, log, emit } = fakes({
      answer: serverCall({ state: "answered", answeredHere: false }),
    });
    const answered: string[] = [];
    const hook = await renderHook(
      () =>
        useIncomingAgentCalls({
          client,
          callAdapter: call,
          onAnswered: (incoming) => void answered.push(incoming.sessionId),
        }),
      undefined,
    );
    await settle();
    await act(async () =>
      emit({ type: "incomingAnswered", call: { ...ringing, state: "answered" } }),
    );
    await settle();
    expect(log).toEqual(["answer:named", "end:answeredElsewhere"]);
    expect(answered).toEqual([]);
    await hook.unmount();
  });

  test("a call settled elsewhere while it rings stops ringing here", async () => {
    const { call, client, log, emit } = fakes({
      answer: serverCall({ state: "answered" }),
      current: serverCall({ state: "declined" }),
    });
    const hook = await renderHook(
      () => useIncomingAgentCalls({ client, callAdapter: call, onAnswered: () => undefined }),
      undefined,
    );
    await settle();
    await act(async () => emit({ type: "incoming", call: ringing }));
    await settle();
    expect(log).toEqual(["end:declinedElsewhere"]);
    await hook.unmount();
  });

  test("declining tells the server once", async () => {
    const { call, client, log, emit } = fakes({ answer: serverCall({}) });
    const hook = await renderHook(
      () => useIncomingAgentCalls({ client, callAdapter: call, onAnswered: () => undefined }),
      undefined,
    );
    await settle();
    await act(async () =>
      emit({ type: "incomingDeclined", call: { ...ringing, state: "declined" } }),
    );
    await act(async () =>
      emit({ type: "incomingDeclined", call: { ...ringing, state: "declined" } }),
    );
    await settle();
    expect(log).toEqual(["decline"]);
    await hook.unmount();
  });

  test("maps how the server settled a call to how the ring ends", () => {
    expect(incomingEndReason({ state: "answered" })).toBe("answeredElsewhere");
    expect(incomingEndReason({ state: "declined" })).toBe("declinedElsewhere");
    expect(incomingEndReason({ state: "missed" })).toBe("unanswered");
    expect(incomingEndReason({ state: "cancelled" })).toBe("remoteEnded");
  });
});
