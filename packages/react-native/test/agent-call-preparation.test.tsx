import { describe, expect, mock, test } from "bun:test";
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import type { OpenGeniClient } from "@opengeni/sdk";
import type {
  NativeCallAdapter,
  NativeCallEvent,
  NativeIncomingCall,
} from "../src/realtime/native-call";
import { registerDom, renderComponent } from "../../react/test/render-hook";

registerDom();
const host = (props: { children?: ReactNode }) => createElement("div", null, props.children);
mock.module("react-native", () => ({
  View: host,
  Text: host,
  Pressable: host,
  Modal: (props: { visible: boolean; children?: ReactNode }) =>
    props.visible ? host(props) : null,
  Alert: { alert() {} },
  StyleSheet: { create: (value: unknown) => value },
}));
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
mock.module("../src/timeline/theme", () => ({ useNativeTimelineTheme: () => ({ colors: {} }) }));
mock.module("../src/realtime/call-view", () => ({
  DEFAULT_OPENGENI_NATIVE_CALL_LABELS: () => ({}),
  OpenGeniNativeCallView: () => createElement("div", null, "Call screen"),
}));
mock.module("@opengeni/react/session", () => ({
  useSessionEvents: () => ({ events: [], initialLoading: false }),
  useSession: () => ({ session: { title: "Test session", status: "idle" } }),
  useTurnQueue: () => ({ effectiveControl: { state: "active", settlement: null } }),
}));
const log: string[] = [];
let instance = 0;
const prepare = async () => {
  log.push("prepare");
};
const start = async () => {
  log.push("start");
};
mock.module("../src/realtime/use-native-session-realtime", () => ({
  useNativeSessionRealtime: () => {
    const [id] = useState(() => ++instance);
    useEffect(
      () => () => {
        log.push(`close:${id}`);
      },
      [id],
    );
    return {
      canStart: true,
      admissionBlocker: null,
      prepare,
      start,
      stop: async () => {
        log.push("stop");
      },
      setInputMuted() {},
      snapshot: { status: "idle", inputMuted: false },
    };
  },
}));
const { NativeAgentCallProvider, useNativeAgentCall } = await import("../src/realtime/agent-call");
const incoming: NativeIncomingCall = {
  callId: "c",
  sessionId: "s",
  workspaceId: "w",
  subjectId: null,
  title: "Test",
  reason: null,
  ringUntil: null,
  state: "ringing",
};

function fixture() {
  const listeners = new Set<(event: NativeCallEvent) => void>();
  let finishAnswer!: (value: unknown) => void;
  let catalogLoads = 0;
  const client = {
    getWorkspaceRealtimeModelCatalog: async () => {
      catalogLoads++;
      return { models: [{ id: "gpt-live-1-boulder-alpha", label: "Live", available: true }] };
    },
    getAgentCall: async () => ({ state: "ringing" }),
    answerAgentCall: async () => {
      log.push("claim");
      return new Promise((resolve) => {
        finishAnswer = resolve;
      });
    },
    declineAgentCall: async () => ({ state: "declined" }),
  } as unknown as OpenGeniClient;
  const adapter: NativeCallAdapter = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    incoming: {
      takeIncomingCalls: async () => [],
      getVoipToken: async () => null,
      endIncomingCall() {},
    },
    takePendingStartRequest: async () => null,
    startCall: async () => {},
    reportConnected() {},
    endCall: async () => {},
    setMuted: async () => {},
    setSpeaker: async () => {},
  };
  let calls: ReturnType<typeof useNativeAgentCall>;
  function Child() {
    calls = useNativeAgentCall();
    return null;
  }
  return {
    render: () =>
      renderComponent(
        createElement(
          NativeAgentCallProvider,
          {
            client,
            workspaceId: "w",
            codexConnected: true,
            callAdapter: adapter,
            webrtc: {
              createPeerConnection: () => {
                throw Error("mocked");
              },
              getUserMedia: async () => {
                throw Error("mocked");
              },
            },
          },
          createElement(Child),
        ),
      ),
    emit: (event: NativeCallEvent) => {
      for (const listener of listeners) listener(event);
    },
    answer: () => finishAnswer({ state: "answered", answeredHere: true }),
    catalogLoads: () => catalogLoads,
    call: () => calls.callSession("s"),
  };
}

describe("native call preparation lifecycle", () => {
  test("loads catalog before the call, hides ring preparation, and retains it on Answer", async () => {
    log.length = 0;
    instance = 0;
    const f = fixture();
    const rendered = await f.render();
    expect(f.catalogLoads()).toBe(1);
    expect(instance).toBe(0);
    await act(async () => f.emit({ type: "incoming", call: incoming }));
    expect(instance).toBe(1);
    expect(log).toEqual(["prepare"]);
    expect(document.body.textContent).not.toContain("Call screen");
    await act(async () =>
      f.emit({ type: "incomingAnswered", call: { ...incoming, state: "answered" } }),
    );
    expect(log).toEqual(["prepare", "claim"]);
    await act(async () => f.answer());
    expect(instance).toBe(1);
    expect(log).toContain("start");
    expect(log).not.toContain("close:1");
    expect(document.body.textContent).toContain("Call screen");
    await rendered.unmount();
    expect(log).toContain("close:1");
  });

  test("decline disposes the hidden preparation without starting voice", async () => {
    log.length = 0;
    instance = 0;
    const f = fixture();
    const rendered = await f.render();
    await act(async () => f.emit({ type: "incoming", call: incoming }));
    await act(async () =>
      f.emit({ type: "incomingDeclined", call: { ...incoming, state: "declined" } }),
    );
    expect(log).toEqual(["prepare", "close:1"]);
    await rendered.unmount();
  });

  test("a fully warmed outgoing call is not mistaken for an ended call on its first render", async () => {
    log.length = 0;
    instance = 0;
    const f = fixture();
    const rendered = await f.render();
    await act(async () => f.call());
    expect(log).toContain("start");
    expect(log).not.toContain("close:1");
    expect(document.body.textContent).toContain("Call screen");
    await rendered.unmount();
  });
});
