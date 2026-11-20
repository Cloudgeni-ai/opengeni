import { expect, mock, test } from "bun:test";
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * The native timeline words a compaction landmark like the web row: a running
 * compaction reads as live work so a long summary request never looks like a
 * stalled turn, and a settled one names its outcome in the host's language.
 * Host components are DOM stand-ins.
 */
function host(tag: string) {
  return function Host(props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    testID?: string;
  }) {
    return createElement(
      tag,
      {
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
        "data-testid": props.testID,
      },
      props.children,
    );
  };
}

mock.module("react-native", () => {
  const TextInput = forwardRef(function TextInput(props: Record<string, unknown>, ref) {
    useImperativeHandle(ref, () => ({ clear: () => undefined, focus: () => undefined }));
    return createElement("input", { "aria-label": props.accessibilityLabel });
  });
  function Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
  }) {
    return createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled,
        onClick: () => props.onPress?.(),
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
        "data-checked": props.accessibilityState?.checked ? "true" : undefined,
      },
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    );
  }
  return {
    View: host("div"),
    Text: host("span"),
    ScrollView: forwardRef(function ScrollView(props: { children?: ReactNode }, ref) {
      useImperativeHandle(ref, () => ({ scrollTo: () => undefined, scrollToEnd: () => undefined }));
      return createElement("div", {}, props.children);
    }),
    ActivityIndicator: () => null,
    Pressable,
    TextInput,
    Platform: {
      OS: "ios",
      select: (options: Record<string, unknown>) => options.ios,
    },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    // Bun keeps one "react-native" module per test process: expose every
    // export a later test file's component graph links against.
    Modal: host("div"),
    KeyboardAvoidingView: host("div"),
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
          return "transparent";
        }
        setValue() {}
        stopAnimation() {}
      },
      add: () => 0,
      loop: () => ({ start: () => {}, stop: () => {} }),
      sequence: () => ({ start: () => {}, stop: () => {} }),
      spring: () => ({ start: () => {}, stop: () => {} }),
      timing: () => ({ start: () => {}, stop: () => {} }),
    },
    Easing: {
      out: () => (value: number) => value,
      cubic: (value: number) => value,
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    ActionSheetIOS: { showActionSheetWithOptions: () => {} },
    Alert: { alert: () => {} },
    AppState: {
      addEventListener: () => ({ remove: () => {} }),
      currentState: "active",
    },
    FlatList: host("div"),
    Image: host("img"),
    Linking: { openURL: async () => {} },
    Share: { share: async () => ({}) },
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove: () => {} }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    // Only the drawing surface is a DOM stand-in, so a test can find the orb.
    default: (props: { testID?: string }) => createElement("svg", { "data-testid": props.testID }),
    Circle: nothing,
    Defs: nothing,
    Line: nothing,
    LinearGradient: nothing,
    Path: nothing,
    Polyline: nothing,
    Rect: nothing,
    Stop: nothing,
  };
});
const layoutAnimation = {
  duration: () => layoutAnimation,
  delay: () => layoutAnimation,
};
mock.module("react-native-reanimated", () => ({
  default: { View: host("div"), Text: host("span"), ScrollView: host("div") },
  cancelAnimation: () => undefined,
  Easing: {
    linear: (value: number) => value,
    inOut: () => (value: number) => value,
  },
  FadeIn: layoutAnimation,
  FadeInDown: layoutAnimation,
  FadeOut: layoutAnimation,
  FadeOutDown: layoutAnimation,
  FadeOutUp: layoutAnimation,
  LinearTransition: layoutAnimation,
  interpolateColor: () => "#000",
  useAnimatedKeyboard: () => ({ height: { value: 0 } }),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
mock.module("react-native-webview", () => ({ WebView: host("div") }));
mock.module("expo-glass-effect", () => ({
  GlassView: host("div"),
  isLiquidGlassAvailable: () => false,
}));
mock.module("expo-file-system", () => ({ Directory: Object, File: Object, Paths: {} }));

registerDom();

const { MessageTimeline } = await import("../src/timeline/message-timeline");

let sequence = 0;
function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
    turnId,
  } as SessionEvent;
}

function runningTurn(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Keep going." }, null),
    event("turn.started", {}),
    event("agent.message.completed", { messageId: "m1", text: "Checking the rest." }),
    event("agent.toolCall.created", { id: "c1", name: "exec_command", arguments: { cmd: "ls" } }),
    event("agent.toolCall.output", { id: "c1", output: "ok" }),
    event("session.context.compaction.started", { trigger: "proactive" }),
  ];
}

function statusText(container: HTMLElement) {
  return container.textContent ?? "";
}

test("a running compaction reads as live work, never as already compacted", async () => {
  const view = await renderComponent(<MessageTimeline events={runningTurn()} />);
  try {
    const text = statusText(view.container);
    expect(text).toContain("Compacting conversation history…");
    expect(text).not.toMatch(/compacted/i);
  } finally {
    await view.unmount();
  }
});

test("a settled compaction names its outcome in the host's language", async () => {
  const events = [
    ...runningTurn(),
    event("session.context.compacted", {
      trigger: "proactive",
      estimatedTokensBefore: 211_700,
      estimatedTokensAfter: 16_600,
    }),
  ];
  const view = await renderComponent(<MessageTimeline events={events} />);
  try {
    const text = statusText(view.container);
    expect(text).not.toContain("Compacting conversation history…");
    expect(text).not.toContain("context compacted");
    // The settled checkpoint folds into the turn's work, as on the web.
    await pressLabelled(view.container, /Work|Worked/);
    expect(statusText(view.container)).toContain(
      "Conversation history compacted · ~211,700 → ~16,600 estimated history tokens · Auto",
    );
  } finally {
    await view.unmount();
  }
});

test("a failed compaction says the chat history is unchanged", async () => {
  const events = [
    ...runningTurn(),
    event("session.context.compaction.skipped", {
      trigger: "proactive",
      reason: "summarization_failed",
    }),
  ];
  const view = await renderComponent(<MessageTimeline events={events} />);
  try {
    const text = statusText(view.container);
    expect(text).toContain("Couldn’t compact conversation history · Auto");
    expect(text).not.toContain("Compacting conversation history…");
  } finally {
    await view.unmount();
  }
});

async function pressLabelled(container: HTMLElement, label: RegExp) {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    label.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? ""),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
