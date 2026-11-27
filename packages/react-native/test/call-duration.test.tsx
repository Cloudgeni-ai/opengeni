import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { act, createElement, useState, type ReactNode } from "react";
import type { OpenGeniClient } from "@opengeni/sdk";
import type { NativeCallAdapter } from "../src/realtime/native-call";
import { registerDom, renderComponent } from "../../react/test/render-hook";

registerDom();

const platform = { OS: "ios" };
const host = (props: { children?: ReactNode }) => createElement("div", null, props.children);
mock.module("react-native", () => ({
  View: host,
  Text: (props: { children?: ReactNode }) => createElement("span", null, props.children),
  Pressable: (props: { accessibilityLabel?: string; onPress?(): void; children?: unknown }) =>
    createElement(
      "button",
      { "aria-label": props.accessibilityLabel, onClick: props.onPress },
      typeof props.children === "function" ? null : (props.children as ReactNode),
    ),
  // Like React Native's Modal, a hidden one renders nothing: the call screen unmounts.
  Modal: (props: { visible: boolean; children?: ReactNode }) =>
    props.visible ? host(props) : null,
  Alert: { alert() {} },
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
  Platform: platform,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  Keyboard: { dismiss() {} },
  Animated: {
    Value: class {
      interpolate() {
        return this;
      }
    },
    View: host,
    // Slides finish at once: hiding the call screen unmounts it, as on device.
    timing: () => ({
      start(finish: (result: { finished: boolean }) => void) {
        finish({ finished: true });
      },
      stop() {},
    }),
  },
}));
mock.module("react-native-screens", () => ({ FullWindowOverlay: host }));
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
mock.module("../src/timeline/theme", () => ({
  useNativeTimelineTheme: () => ({ colors: {}, scheme: "light" }),
  fontStyle: () => ({}),
}));
mock.module("../src/timeline/icon", () => ({ Icon: () => null }));
mock.module("../src/timeline/thinking-orb", () => ({ ThinkingOrb: () => null }));
mock.module("@opengeni/react/session", () => ({
  useSessionEvents: () => ({ events: [], initialLoading: false }),
  useSession: () => ({ session: { title: "Test session", status: "idle" } }),
  useTurnQueue: () => ({ effectiveControl: { state: "active", settlement: null } }),
}));
// Voice goes live as soon as it starts.
mock.module("../src/realtime/use-native-session-realtime", () => ({
  useNativeSessionRealtime: () => {
    const [status, setStatus] = useState<"idle" | "active">("idle");
    return {
      canStart: true,
      admissionBlocker: null,
      prepare: async () => {},
      prepareIncoming: async () => {},
      start: async () => setStatus("active"),
      stop: async () => setStatus("idle"),
      setInputMuted() {},
      snapshot: { status, inputMuted: false, diagnostic: null, error: null },
    };
  },
}));
const { NativeAgentCallProvider, useNativeAgentCall } = await import("../src/realtime/agent-call");

const client = {
  getWorkspaceRealtimeModelCatalog: async () => ({
    models: [{ id: "gpt-live-1-boulder-alpha", label: "Live", available: true }],
  }),
} as unknown as OpenGeniClient;
const adapter: NativeCallAdapter = {
  subscribe: () => () => {},
  takePendingStartRequest: async () => null,
  startCall: async () => {},
  reportConnected() {},
  endCall: async () => {},
  setMuted: async () => {},
  setSpeaker: async () => {},
};

const start = Date.parse("2026-11-27T12:00:00Z");
const at = (seconds: number) => setSystemTime(new Date(start + seconds * 1000));
const press = async (label: string) => {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`No button "${label}"`);
  await act(async () => button.click());
};

describe("call duration", () => {
  afterEach(() => setSystemTime());

  // iOS draws the call in a window layer, Android in a Modal; both unmount it when minimized.
  test.each(["ios", "android"])(
    "on %s, minimizing and expanding a call keeps the time running from the call's start",
    async (os) => {
      platform.OS = os;
      let calls!: ReturnType<typeof useNativeAgentCall>;
      function Child() {
        calls = useNativeAgentCall();
        return null;
      }
      at(0);
      const rendered = await renderComponent(
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
      );
      await act(async () => calls.callSession("s"));
      expect(document.body.textContent).toContain("Listening · 0:00");

      // Minimize 49 seconds in: the pill shows the same running time.
      at(49);
      await press("Back to chat");
      expect(document.body.textContent).not.toContain("Listening");
      expect(document.body.textContent).toContain("On call · 0:49 · Test session");

      // Expand again later: the call screen continues from the call's start, not from 0:00.
      at(62);
      await act(async () => calls.callSession("s"));
      expect(document.body.textContent).toContain("Listening · 1:02");

      // And again: no restart on any number of round trips.
      await press("Back to chat");
      at(125);
      await act(async () => calls.callSession("s"));
      expect(document.body.textContent).toContain("Listening · 2:05");
      await rendered.unmount();
    },
  );
});
