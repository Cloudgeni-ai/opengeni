import { expect, mock, test } from "bun:test";
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * The native timeline draws a question the parent agent answered as one quiet
 * row inside the turn's work, and keeps a person's answer in the conversation.
 * Host components are DOM stand-ins.
 */
type Recorded = { props: Record<string, unknown>; clears: number };
const inputs = new Map<string, Recorded>();

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
    const key = String(props.testID ?? props.accessibilityLabel);
    const entry = inputs.get(key) ?? { props, clears: 0 };
    entry.props = props;
    inputs.set(key, entry);
    useImperativeHandle(ref, () => ({
      clear: () => {
        entry.clears += 1;
      },
      focus: () => undefined,
    }));
    return createElement("input", {
      "data-key": key,
      "aria-label": props.accessibilityLabel,
    });
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
    ScrollView: host("div"),
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
    AccessibilityInfo: { isReduceMotionEnabled: async () => false },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    default: nothing,
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

function subSession(respondedByKind: string): SessionEvent[] {
  sequence = 0;
  const questions = [
    {
      id: "base",
      kind: "single_select",
      label: "Target branch",
      prompt: "Where should the fix land?",
      options: [{ id: "both", label: "main and release/2026.10" }],
    },
  ];
  return [
    event("user.message", { text: "Land the fix." }, null),
    event("turn.started", {}),
    event("agent.message.completed", {
      messageId: "m1",
      text: "Which branches?",
    }),
    event("agent.toolCall.created", {
      id: "ask-1",
      name: "request_human_input",
      arguments: { questions },
    }),
    event("session.humanInput.requested", {
      request: { id: "review-base", toolCallId: "ask-1", questions },
    }),
    event("user.humanInputResponse", {
      requestId: "review-base",
      respondedByKind,
      response: {
        outcome: "answered",
        answers: [{ questionId: "base", values: ["both"] }],
      },
    }),
    event("agent.toolCall.output", { id: "ask-1", output: "{}" }),
    event("agent.message.completed", {
      messageId: "m2",
      text: "Landing it on both.",
    }),
    event("turn.completed", {}),
  ];
}

async function pressLabelled(container: HTMLElement, label: RegExp) {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    label.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? ""),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test("a question the parent agent answered is a quiet row inside the turn's work", async () => {
  const view = await renderComponent(<MessageTimeline events={subSession("agent_attempt")} />);
  try {
    const collapsed = view.container.textContent ?? "";
    expect(collapsed).toContain("Landing it on both.");
    expect(collapsed).not.toContain("Agent asked");
    expect(collapsed).not.toContain("Agent answered");
    expect(collapsed).not.toContain("You answered");

    await pressLabelled(view.container, /Worked for/);
    const work = view.container.textContent ?? "";
    expect(work).toContain("Asked");
    expect(work).toContain("Target branch → main and release/2026.10");
    expect(work).not.toContain("Agent answered");

    await pressLabelled(view.container, /^Asked: /);
    const details = view.container.textContent ?? "";
    expect(details).toContain("Where should the fix land?");
    expect(details).toContain("Agent answered");
    expect(details).not.toContain("You answered");
  } finally {
    await view.unmount();
  }
});

test("a question a person answered keeps its conversation card", async () => {
  const view = await renderComponent(<MessageTimeline events={subSession("human")} />);
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Agent asked");
    expect(text).toContain("You answered");
    expect(text).toContain("main and release/2026.10");
  } finally {
    await view.unmount();
  }
});
