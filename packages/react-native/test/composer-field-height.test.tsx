import { expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * The iPhone composer (12 Nov 2026) stayed one line tall while typing: it set
 * the field's height from `onContentSizeChange`, which iOS on the new
 * architecture reports only when the field's layout changes. With text, the
 * field must size itself (no fixed height) up to its maximum.
 *
 * Bun cannot parse react-native's Flow sources, so host components are DOM
 * stand-ins; the text field records the style it was given.
 */
type FieldStyle = { height?: number; minHeight?: number; maxHeight?: number };
const fieldStyles: FieldStyle[] = [];
let platform: "ios" | "android" = "ios";
function host(tag: string) {
  return function Host(props: { children?: ReactNode }) {
    return createElement(tag, null, props.children);
  };
}
mock.module("react-native", () => ({
  View: host("div"),
  Text: host("span"),
  ScrollView: host("div"),
  Modal: host("div"),
  KeyboardAvoidingView: host("div"),
  FlatList: host("div"),
  Image: host("img"),
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
  Linking: { openURL: async () => {} },
  Share: { share: async () => ({}) },
  ActivityIndicator: () => null,
  Pressable: (props: { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode) }) =>
    createElement(
      "button",
      null,
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    ),
  TextInput: (props: { style: FieldStyle }) => {
    fieldStyles.push(props.style);
    return createElement("textarea");
  },
  AccessibilityInfo: {
    isReduceTransparencyEnabled: async () => false,
    addEventListener: () => ({ remove: () => {} }),
  },
  Keyboard: {
    metrics: () => undefined,
    addListener: () => ({ remove: () => {} }),
  },
  NativeModules: {},
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
  Platform: {
    get OS() {
      return platform;
    },
    select: (options: Record<string, unknown>) => options[platform] ?? options.default,
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
mock.module("expo-glass-effect", () => ({
  GlassView: host("div"),
  isLiquidGlassAvailable: () => false,
}));
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    default: nothing,
    Circle: nothing,
    Line: nothing,
    Path: nothing,
    Polyline: nothing,
    Rect: nothing,
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

const { SessionComposer } = await import("../src/timeline/composer");

async function fieldStyle(value: string): Promise<FieldStyle> {
  fieldStyles.length = 0;
  const rendered = await renderComponent(
    createElement(SessionComposer, {
      value,
      onChangeText: () => {},
      onSend: () => {},
      canSend: value.length > 0,
      // The session screen's model pill, which gives the stacked layout.
      options: createElement("span", null, "Opus 5.5"),
    }),
  );
  const style = fieldStyles.at(-1)!;
  await rendered.unmount();
  return style;
}

test("on iOS the field sizes itself once it has text, up to six lines", async () => {
  platform = "ios";
  const typed = await fieldStyle("Can you check why\nthe Slack thread\nForgot\nFlg");
  expect(typed.height).toBeUndefined();
  expect(typed.maxHeight).toBe(16 + 6 * 22);
  // Empty, it stays one line, however long the placeholder.
  expect((await fieldStyle("")).height).toBe(40);
});

test("Android never gets a fixed height", async () => {
  platform = "android";
  expect((await fieldStyle("")).height).toBeUndefined();
  expect((await fieldStyle("a\nb\nc")).height).toBeUndefined();
});
