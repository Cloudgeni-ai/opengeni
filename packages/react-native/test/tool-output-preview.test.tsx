import { expect, mock, test } from "bun:test";
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  type ComponentType,
  type ReactNode,
} from "react";
import type { ToolCallItem } from "@opengeni/react/session";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * A tool row whose output is a bounded preview: a command row reads from it
 * until opened, then waits for the exact output; any row a custom renderer
 * draws reads its exact output first. Host components are DOM stand-ins.
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
    return createElement("input", { "data-key": key, "aria-label": props.accessibilityLabel });
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
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    // Bun keeps one "react-native" module per test process: expose every
    // export a later test file's component graph links against.
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

const { ActivityRow, NativeActivityOptionsProvider } =
  (await import("../src/timeline/activity")) as {
    ActivityRow: ComponentType<{ item: ToolCallItem }>;
    NativeActivityOptionsProvider: ComponentType<{ value: object; children: ReactNode }>;
  };

const LONG = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");

function previewItem(name: string, state: "preview" | "loading" | "error" = "preview") {
  let loads = 0;
  const item = {
    kind: "tool-call",
    id: "tool-1",
    callId: "call-1",
    name,
    status: "complete",
    arguments: { cmd: "seq 500" },
    output: `${LONG.slice(0, 200)}\n…[3000 characters omitted from this preview]…\n${LONG.slice(-100)}`,
    outputPreview: {
      shape: "structured",
      originalBytes: 5000,
      previewBytes: 400,
      state,
      load: () => {
        loads += 1;
      },
    },
  } as ToolCallItem;
  return { item, loads: () => loads };
}

async function press(container: HTMLElement) {
  const button = container.querySelector('button[data-role="button"]') as HTMLButtonElement;
  await act(async () => button.click());
}

test("a command row loads its exact output when opened and waits for it", async () => {
  const { item, loads } = previewItem("exec_command");
  const view = await renderComponent(<ActivityRow item={item} />);
  expect(loads()).toBe(0);
  await press(view.container);
  expect(loads()).toBe(1);
  expect(view.container.textContent).toContain("Loading the full output…");
  expect(view.container.textContent).not.toContain("omitted from this preview");
  await view.rerender(
    <ActivityRow item={{ ...item, output: LONG, outputPreview: null } as ToolCallItem} />,
  );
  expect(view.container.textContent).toContain("line 499");
  expect(loads()).toBe(1);
  await view.unmount();
});

test("a failed read says the body is a preview and retries on request", async () => {
  const { item, loads } = previewItem("exec_command", "error");
  const view = await renderComponent(<ActivityRow item={item} />);
  await press(view.container);
  expect(loads()).toBe(0);
  expect(view.container.textContent).toContain("Showing a preview. The full output didn't load.");
  const retry = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(loads()).toBe(1);
  await view.unmount();
});

test("a custom renderer and a parsed presentation read the exact output first", async () => {
  const seen: unknown[] = [];
  const custom = previewItem("custom_tool");
  const view = await renderComponent(
    <NativeActivityOptionsProvider
      value={{
        toolRenderers: {
          custom_tool: ({ item }: { item: ToolCallItem }) => {
            seen.push(item.output);
            return createElement("span", null, "custom");
          },
        },
      }}
    >
      <ActivityRow item={custom.item} />
    </NativeActivityOptionsProvider>,
  );
  expect(custom.loads()).toBe(1);
  expect(seen).toEqual([]);
  expect(view.container.textContent).toContain("Loading output…");
  await view.unmount();

  const search = previewItem("web_search_call");
  const searchView = await renderComponent(<ActivityRow item={search.item} />);
  expect(search.loads()).toBe(1);
  expect(searchView.container.textContent).toContain("Loading output…");
  await searchView.unmount();
});
