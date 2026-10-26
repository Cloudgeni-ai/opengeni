import { describe, expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so its host components are
 * stood in for by DOM elements. The guide under test is the real one.
 */
const platform = { OS: "ios", Version: "18.2" as string | number };
const openedSettings: number[] = [];

function host(tag: string) {
  return function Host(props: { children?: ReactNode; accessibilityLabel?: string }) {
    return createElement(tag, { "aria-label": props.accessibilityLabel }, props.children);
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
  ActivityIndicator: () => null,
  Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    accessibilityLabel?: string;
  }) {
    return createElement(
      "button",
      { type: "button", onClick: () => props.onPress?.(), "aria-label": props.accessibilityLabel },
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    );
  },
  TextInput: host("input"),
  Platform: { ...platform, select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Keyboard: { dismiss: () => {}, addListener: () => ({ remove: () => {} }) },
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
  Linking: {
    openURL: async () => {},
    openSettings: async () => {
      openedSettings.push(Date.now());
    },
  },
  Share: { share: async () => ({}) },
  AccessibilityInfo: { isReduceMotionEnabled: async () => false },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

registerDom();

const { WakePhraseGuide, wakePhraseSetupAvailable } =
  await import("../src/realtime/wake-phrase-guide");

describe("wake phrase guide", () => {
  test("names the phrase and the Siri request after the agent", async () => {
    const view = await renderComponent(
      <WakePhraseGuide assistantName="Opengeni" copyText={() => {}} />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("Say “Hey Opengeni”");
    expect(text).toContain("Talk to Opengeni");
    expect(text).toContain("Vocal Shortcuts");
  });

  test("copies the request and opens Settings", async () => {
    const copied: string[] = [];
    openedSettings.length = 0;
    const view = await renderComponent(
      <WakePhraseGuide
        assistantName="Ada"
        request="Call Ada"
        phrase="Hello Ada"
        copyText={(value) => void copied.push(value)}
      />,
    );
    const button = (label: string) =>
      [...view.container.querySelectorAll("button")].find(
        (element) =>
          element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
      )!;
    await act(async () => button("Copy “Hello Ada”").click());
    expect(copied).toEqual(["Hello Ada"]);
    await act(async () => button("Copy and open Settings").click());
    expect(copied).toEqual(["Hello Ada", "Call Ada"]);
    expect(openedSettings).toHaveLength(1);
  });

  test("is offered on iOS 18 and later only", () => {
    expect(wakePhraseSetupAvailable()).toBe(true);
  });
});
