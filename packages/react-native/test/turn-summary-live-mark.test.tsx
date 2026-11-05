import { expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { flush, registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements; the turn row itself is the real one.
 */
function host(tag: string) {
  return function Host(props: { children?: ReactNode; testID?: string }) {
    return createElement(tag, { "data-testid": props.testID }, props.children);
  };
}

mock.module("react-native", () => {
  function Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
  }) {
    return createElement(
      "button",
      { type: "button", onClick: () => props.onPress?.() },
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    );
  }
  return {
    View: host("div"),
    Text: host("span"),
    ScrollView: host("div"),
    ActivityIndicator: () => null,
    Pressable,
    Animated: {
      View: host("div"),
      Value: function AnimatedValue() {},
      timing: () => ({ start: () => {} }),
    },
    Easing: { out: () => (value: number) => value, cubic: (value: number) => value },
    AccessibilityInfo: { isReduceMotionEnabled: async () => false },
    AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
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
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

registerDom();

const { TurnSummary } = await import("../src/timeline/turn");
type Status = Parameters<typeof TurnSummary>[0]["status"];
type MarkState = { kind: string; waitingOn?: string | undefined };

function mark(state: MarkState) {
  return createElement("i", {
    "data-mascot": state.waitingOn ? `${state.kind}-${state.waitingOn}` : state.kind,
  });
}

async function rowWith(status: Status, renderLiveMark: typeof mark | null = mark) {
  const view = await renderComponent(
    <TurnSummary items={[]} status={status} renderLiveMark={renderLiveMark ?? undefined}>
      {null}
    </TurnSummary>,
  );
  await flush(20);
  return view;
}

test("the host mark leads a live row with its state", async () => {
  const since = new Date(Date.now() - 8_000).toISOString();
  for (const [status, slot, mascot] of [
    [{ kind: "working", since }, "live-mark-working", "working"],
    [{ kind: "waiting", since, waitingOn: "you" }, "live-mark-waiting", "waiting-you"],
    [{ kind: "waiting", since }, "live-mark-waiting", "waiting"],
    [{ kind: "paused", durationMs: 8_000 }, "live-mark-paused", "paused"],
  ] as const) {
    const view = await rowWith(status);
    try {
      expect(view.container.querySelector(`[data-testid="${slot}"]`)).not.toBeNull();
      expect(view.container.querySelector("[data-mascot]")?.getAttribute("data-mascot")).toBe(
        mascot,
      );
    } finally {
      await view.unmount();
    }
  }
});

test("a settled row and the default draw no mark", async () => {
  const settled = await rowWith({ kind: "worked", durationMs: 8_000 });
  try {
    expect(settled.container.querySelector("[data-testid^='live-mark']")).toBeNull();
    expect(settled.container.querySelector("[data-mascot]")).toBeNull();
  } finally {
    await settled.unmount();
  }
  const plain = await rowWith({ kind: "working", since: new Date().toISOString() }, null);
  try {
    expect(plain.container.textContent).toContain("Working");
    expect(plain.container.querySelector("[data-testid^='live-mark']")).toBeNull();
  } finally {
    await plain.unmount();
  }
});
