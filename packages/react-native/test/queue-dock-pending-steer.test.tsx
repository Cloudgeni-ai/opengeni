import { expect, mock, test } from "bun:test";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import type { useTurnQueue } from "@opengeni/react/session";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements. The dock under test is the real one.
 */
function host(tag: string) {
  return function Host(props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) {
    return createElement(
      tag,
      { "aria-label": props.accessibilityLabel, "data-role": props.accessibilityRole },
      props.children,
    );
  };
}

mock.module("react-native", () => {
  function Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) {
    return createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled,
        onClick: () => props.onPress?.(),
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
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
    Modal: host("div"),
    KeyboardAvoidingView: host("div"),
    Animated: {
      View: host("div"),
      Value: function AnimatedValue() {},
      timing: () => ({ start: () => {} }),
    },
    Easing: { out: () => (value: number) => value, cubic: (value: number) => value },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    ActionSheetIOS: { showActionSheetWithOptions: () => {} },
    Alert: { alert: () => {} },
    AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
    FlatList: host("div"),
    Image: host("img"),
    Linking: { openURL: async () => {} },
    Share: { share: async () => ({}) },
    TextInput: host("input"),
    AccessibilityInfo: { isReduceMotionEnabled: async () => false },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
const layoutAnimation = { duration: () => layoutAnimation, delay: () => layoutAnimation };
mock.module("react-native-reanimated", () => ({
  default: { View: host("div"), Text: host("span"), ScrollView: host("div") },
  cancelAnimation: () => undefined,
  Easing: { linear: (value: number) => value, inOut: () => (value: number) => value },
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

registerDom();

type TurnQueue = ReturnType<typeof useTurnQueue>;
const { QueueDock } = (await import("../src/timeline/queue-dock")) as {
  QueueDock: ComponentType<{ queue: TurnQueue }>;
};

function pendingSteerQueue(overrides: Partial<TurnQueue>): TurnQueue {
  return {
    snapshot: null,
    queue: [],
    pendingInputs: [],
    pendingInputAttachment: null,
    activePersonalConnections: [],
    effectiveControl: null,
    stoppingPreviousAttempt: false,
    pendingSteer: { turnId: "steer-1", turnVersion: 2 },
    loading: false,
    error: null,
    refresh: async () => {},
    moveTurn: async () => true,
    editTurn: async () => null,
    steerTurn: async () => true,
    removeTurn: async () => true,
    pendingByTurn: {},
    mutationFor: () => null,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
    ...overrides,
  } as TurnQueue;
}

test("a waiting Steer with no queued prompts shows its delivery and a failure, with no Send now", async () => {
  const view = await renderComponent(
    <QueueDock
      queue={pendingSteerQueue({
        mutationError: new Error("The message could not be sent."),
      })}
    />,
  );
  expect(view.container.textContent).toContain("Sending your message to the agent.");
  // Delivery is already immediate; there is no separate interrupting action.
  const buttons = [...view.container.querySelectorAll("button")];
  expect(buttons.every((button) => button.getAttribute("data-role") === "alert")).toBe(true);
  expect(view.container.textContent).not.toContain("Send now");
  const alert = view.container.querySelector('[data-role="alert"]');
  expect(alert?.textContent).toBe("The message could not be sent.");
  await view.unmount();
});
