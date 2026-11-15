import { describe, expect, mock, test } from "bun:test";
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import type { OpenGeniClient } from "@opengeni/sdk";
import type {
  NativeCallAdapter,
  NativeCallEvent,
  NativeIncomingCall,
} from "../src/realtime/native-call";
import type { NativeOutsideCallContext } from "../src/realtime/agent-call";
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
const prepareIncoming = async () => {
  log.push("prepareIncoming");
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
      prepareIncoming,
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

function fixture(
  connectsBeforeAnswer?: boolean,
  serverPrepares = false,
  extra: { resolveOutsideCall?(context: NativeOutsideCallContext): Promise<string> } = {},
) {
  const listeners = new Set<(event: NativeCallEvent) => void>();
  let finishAnswer!: (value: unknown) => void;
  let catalogLoads = 0;
  const catalogWorkspaces: string[] = [];
  const systemTargets: (string | null)[] = [];
  const client = {
    getWorkspaceRealtimeModelCatalog: async (workspaceId: string) => {
      catalogLoads++;
      catalogWorkspaces.push(workspaceId);
      return {
        models: [
          {
            id: "gpt-live-1-boulder-alpha",
            label: "Live",
            available: true,
            incomingPreparation: serverPrepares,
          },
        ],
      };
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
      connectsBeforeAnswer,
      takeIncomingCalls: async () => [],
      getVoipToken: async () => null,
      endIncomingCall() {},
    },
    takePendingStartRequest: async () => null,
    startCall: async ({ target }) => {
      systemTargets.push(target);
    },
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
            ...extra,
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
    catalogWorkspaces,
    systemTargets,
    call: () => calls.callSession("s"),
  };
}

describe("native call preparation lifecycle", () => {
  test.each([
    [true, true, "prepareIncoming"],
    [false, true, "prepare"],
    [undefined, true, "prepare"],
    [true, false, "prepare"],
  ] as const)(
    "preconnect requires both the native audio gate (%s) and server support (%s)",
    async (nativeGate, serverGate, expected) => {
      log.length = 0;
      instance = 0;
      const f = fixture(nativeGate, serverGate);
      const rendered = await f.render();
      await act(async () => f.emit({ type: "incoming", call: incoming }));
      expect(log).toEqual([expected]);
      expect(document.body.textContent).not.toContain("Call screen");
      await act(async () =>
        f.emit({ type: "incomingDeclined", call: { ...incoming, state: "declined" } }),
      );
      expect(log).toEqual([expected, "close:1"]);
      await rendered.unmount();
    },
  );
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

  test("a voice command calls its chat in the workspace it names, not the current one", async () => {
    log.length = 0;
    instance = 0;
    const contexts: NativeOutsideCallContext[] = [];
    const f = fixture(undefined, false, {
      resolveOutsideCall: async (context) => {
        contexts.push(context);
        return context.requested ?? "fresh";
      },
    });
    const rendered = await f.render();
    await act(async () => f.emit({ type: "startRequested", target: "s2", workspaceId: "w2" }));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      workspaceId: "w2",
      requested: "s2",
      requestedWorkspaceId: "w2",
    });
    // The call runs in the named workspace, and Phone recents calls it back there.
    expect(f.catalogWorkspaces.at(-1)).toBe("w2");
    expect(f.systemTargets).toEqual(["w2/s2"]);
    expect(document.body.textContent).toContain("Call screen");
    await rendered.unmount();
  });

  test("a request without a session stays in the current workspace and generic in recents", async () => {
    log.length = 0;
    instance = 0;
    const contexts: NativeOutsideCallContext[] = [];
    const f = fixture(undefined, false, {
      resolveOutsideCall: async (context) => {
        contexts.push(context);
        return "fresh";
      },
    });
    const rendered = await f.render();
    await act(async () => f.emit({ type: "startRequested", target: null, workspaceId: "w2" }));
    expect(contexts[0]).toMatchObject({ workspaceId: "w", requested: null });
    expect(contexts[0]?.requestedWorkspaceId).toBeNull();
    expect(f.systemTargets).toEqual([null]);
    await rendered.unmount();
  });
});
