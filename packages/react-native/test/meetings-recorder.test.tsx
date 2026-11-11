import { describe, expect, mock, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { act, createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";

registerDom();

function host(tag: string) {
  return function Host(props: { children?: ReactNode }) {
    return createElement(tag, {}, props.children);
  };
}
const idle = () => ({ start: () => {}, stop: () => {} });

// The app's state as React Native reports it, moved by the tests.
let appStateNow = "active";
const appStateListeners = new Set<(state: string) => void>();
function setAppState(state: string) {
  appStateNow = state;
  for (const listener of appStateListeners) listener(state);
}
// Bun keeps one "react-native" module per test process: expose every export a
// later test file's component graph links against, not only AppState.
mock.module("react-native", () => ({
  AppState: {
    get currentState() {
      return appStateNow;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
  View: host("div"),
  Text: host("span"),
  ScrollView: host("div"),
  FlatList: host("div"),
  Image: host("img"),
  Modal: host("div"),
  KeyboardAvoidingView: host("div"),
  RefreshControl: () => null,
  ActivityIndicator: () => null,
  Pressable: host("button"),
  TextInput: host("input"),
  Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Keyboard: {
    isVisible: () => false,
    addListener: () => ({ remove: () => {} }),
    dismiss: () => {},
  },
  Animated: {
    View: host("div"),
    Text: host("span"),
    Value: class AnimatedValue {
      interpolate() {
        return this;
      }
      setValue() {}
      stopAnimation() {}
    },
    add: () => 0,
    loop: idle,
    sequence: idle,
    spring: idle,
    timing: idle,
  },
  Easing: {
    bezier: () => (value: number) => value,
    in: () => (value: number) => value,
    out: () => (value: number) => value,
    quad: (value: number) => value,
    cubic: (value: number) => value,
  },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  ActionSheetIOS: { showActionSheetWithOptions: () => {} },
  Alert: { alert: () => {} },
  Linking: { openURL: async () => {} },
  Share: { share: async () => ({}) },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    announceForAccessibility: () => {},
  },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

// The capture platform and the recorder hook are replaced: these tests are about
// how the provider holds a recorder, not about recording.
const started: string[] = [];
const stopped: string[] = [];
const setStates = new Map<string, (state: string) => void>();
mock.module("../src/recordings", () => ({
  useNativeRecorderPlatform: (options: { storeScope?: string }) => ({
    scope: options.storeScope ?? "",
  }),
}));
mock.module("@opengeni/react/recordings", () => ({
  useRecorder: (options: { workspaceId?: string; platform: { scope: string } }) => {
    const id = `${options.platform.scope}/${options.workspaceId ?? ""}`;
    const [state, setState] = useState("idle");
    const recorder = useMemo(() => ({ state, recordingId: null, id }), [state, id]);
    useEffect(() => {
      setStates.set(id, setState);
      started.push(id);
      return () => void stopped.push(id);
    }, [id]);
    return recorder;
  },
}));

const { MeetingRecorderProvider, useMeetingRecorder } = await import("../src/meetings/recorder");

let mounts = 0;
let seen: unknown[] = [];
function Screen() {
  useEffect(() => {
    mounts += 1;
  }, []);
  const recorder = useMeetingRecorder() as { id?: string } | null;
  seen.push(recorder?.id ?? null);
  return null;
}

function tree(props: { storeScope?: string; workspaceId: string | null }): ReactNode {
  return (
    <MeetingRecorderProvider client={{}} {...props}>
      <Screen />
    </MeetingRecorderProvider>
  );
}

describe("MeetingRecorderProvider", () => {
  test("a new account gets a fresh recorder while the screens below stay mounted", async () => {
    mounts = 0;
    seen = [];
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: "w1" }));
    expect(seen.at(-1)).toBe("a/w1");

    await rendered.rerender(tree({ storeScope: "b", workspaceId: "w2" }));
    // The old recorder stopped, the new one is what the screens read, and the
    // screens were never remounted.
    expect(stopped).toContain("a/w1");
    expect(started).toContain("b/w2");
    expect(seen.at(-1)).toBe("b/w2");
    expect(mounts).toBe(1);
    await rendered.unmount();
  });

  test("no recorder until the workspace is known", async () => {
    seen = [];
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: null }));
    expect(seen.at(-1)).toBeNull();
    await rendered.rerender(tree({ storeScope: "a", workspaceId: "w1" }));
    expect(seen.at(-1)).toBe("a/w1");
    await rendered.unmount();
  });

  test("a recording keeps going in its workspace when another is chosen, then the recorder follows", async () => {
    seen = [];
    stopped.length = 0;
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: "w1" }));
    await act(async () => setStates.get("a/w1")!("recording"));

    await rendered.rerender(tree({ storeScope: "a", workspaceId: "w2" }));
    expect(stopped).not.toContain("a/w1");
    expect(seen.at(-1)).toBe("a/w1");

    await act(async () => setStates.get("a/w1")!("stopped"));
    expect(stopped).toContain("a/w1");
    expect(seen.at(-1)).toBe("a/w2");
    await rendered.unmount();
  });

  test("a new account still ends a recording at once", async () => {
    stopped.length = 0;
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: "w1" }));
    await act(async () => setStates.get("a/w1")!("recording"));
    await rendered.rerender(tree({ storeScope: "b", workspaceId: "w1" }));
    expect(stopped).toContain("a/w1");
    expect(seen.at(-1)).toBe("b/w1");
    await rendered.unmount();
  });

  test("outside a provider there is no recorder", async () => {
    seen = [];
    const rendered = await renderComponent(<Screen />);
    expect(seen.at(-1)).toBeNull();
    await rendered.unmount();
  });

  test("in the background the screens hear nothing, and get the latest back in front", async () => {
    const states: string[] = [];
    function StateScreen() {
      const recorder = useMeetingRecorder() as { state?: string } | null;
      states.push(recorder?.state ?? "none");
      return null;
    }
    const rendered = await renderComponent(
      <MeetingRecorderProvider client={{}} storeScope="bg" workspaceId="w1">
        <StateScreen />
      </MeetingRecorderProvider>,
    );
    await act(async () => setStates.get("bg/w1")!("recording"));
    expect(states.at(-1)).toBe("recording");

    // The phone is locked: the recorder keeps changing, the screens are not redrawn.
    await act(async () => setAppState("background"));
    const renders = states.length;
    await act(async () => setStates.get("bg/w1")!("paused"));
    await act(async () => setStates.get("bg/w1")!("recording"));
    await act(async () => setStates.get("bg/w1")!("paused"));
    expect(states.length).toBe(renders);

    // Unlocked: one update with where things are now.
    await act(async () => setAppState("active"));
    expect(states.at(-1)).toBe("paused");
    expect(states.length).toBe(renders + 1);
    await rendered.unmount();
  });
});

describe("meeting screens", () => {
  // An animation driven from JavaScript lays out and redraws the whole screen
  // on every frame, and keeps doing so with the phone locked, until iOS ends
  // the app for using too much CPU in the background.
  test("animate only on the native side", async () => {
    const directory = join(import.meta.dir, "../src/meetings");
    const offenders: string[] = [];
    for (const name of await readdir(directory)) {
      const source = await readFile(join(directory, name), "utf8");
      if (/useNativeDriver:\s*false/u.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
