import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, forwardRef, type ComponentType, type ReactNode } from "react";
import type { AuthNeededItem, PendingApproval } from "@opengeni/react/session";
import { registerDom, renderComponent, type RenderedComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements. The cards and the shared connect model under
 * test are the real ones.
 */
function hostElement(tag: string) {
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
    return createElement("input", { ref, "aria-label": props.accessibilityLabel });
  });
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
    View: hostElement("div"),
    Text: hostElement("span"),
    ScrollView: hostElement("div"),
    ActivityIndicator: () => null,
    Pressable,
    TextInput,
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    // Bun keeps one "react-native" module per test process: expose every
    // export a later test file's component graph links against.
    Modal: hostElement("div"),
    KeyboardAvoidingView: hostElement("div"),
    Animated: {
      View: hostElement("div"),
      Value: function AnimatedValue() {},
      timing: () => ({ start: () => {} }),
    },
    Easing: { out: () => (value: number) => value, cubic: (value: number) => value },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    ActionSheetIOS: { showActionSheetWithOptions: () => {} },
    Alert: { alert: () => {} },
    AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
    FlatList: hostElement("div"),
    Image: hostElement("img"),
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
  default: { View: hostElement("div"), Text: hostElement("span"), ScrollView: hostElement("div") },
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

const { NativeAuthNeededRow, nativeConnectWindowHost } =
  (await import("../src/timeline/in-chat-connect")) as typeof import("../src/timeline/in-chat-connect");
const { ApprovalStrip } = (await import("../src/timeline/decisions")) as {
  ApprovalStrip: ComponentType<{
    approvals: PendingApproval[];
    onDecide: (id: string, decision: "approve" | "reject") => Promise<void>;
  }>;
};

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  const current = mounted;
  mounted = null;
  await current?.unmount();
});

function authItem(overrides: Partial<AuthNeededItem> = {}): AuthNeededItem {
  return {
    kind: "auth-needed",
    id: "auth-1",
    turnId: "turn-1",
    serverId: null,
    providerDomain: "linear.app",
    connectionId: null,
    reason: "expired",
    scopes: [],
    resource: null,
    toolName: null,
    authorizationUrl: null,
    occurredAt: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

const buttonLabels = () =>
  [...mounted!.container.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent?.trim(),
  );

describe("native connection row", () => {
  test("a first-time connection says connect, never reconnect", async () => {
    mounted = await renderComponent(
      <NativeAuthNeededRow item={authItem({ reason: "missing_connection" })} />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Connect Linear");
    expect(text).not.toMatch(/reconnect/i);
  });

  test("a lapsed connection with a link offers to reconnect", async () => {
    const opened: string[] = [];
    mounted = await renderComponent(
      <NativeAuthNeededRow
        item={authItem({ connectionId: "conn-1", authorizationUrl: "https://linear.app/auth" })}
        openUrl={(url) => opened.push(url)}
      />,
    );
    expect(mounted.container.textContent).toContain("Reconnect Linear");
    await act(async () => {
      [...mounted!.container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Reconnect"))!
        .click();
    });
    expect(opened).toEqual(["https://linear.app/auth"]);
  });
});

describe("native sign-in window host", () => {
  test("opens the system sign-in browser and reports it closed once it returns", async () => {
    let finish: () => void = () => undefined;
    const opened: string[] = [];
    let dismissed = 0;
    const host = nativeConnectWindowHost({
      openAuthSession: (url) => {
        opened.push(url);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      dismiss: () => {
        dismissed += 1;
      },
    });
    const reserved = host.reserve();
    const popup = reserved.navigation.openPopup("https://provider.example/authorize");
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toEqual(["https://provider.example/authorize"]);
    expect(popup?.closed).toBe(false);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(popup?.closed).toBe(true);
    // Already back in the app: nothing left to dismiss.
    reserved.close();
    expect(dismissed).toBe(0);
  });

  test("closing an open sign-in dismisses the browser, and plain HTTP is refused", () => {
    let dismissed = 0;
    const host = nativeConnectWindowHost({
      openAuthSession: () => new Promise(() => undefined),
      dismiss: () => {
        dismissed += 1;
      },
    });
    const reserved = host.reserve();
    reserved.navigation.openPopup("https://provider.example/authorize");
    reserved.close();
    expect(dismissed).toBe(1);
    expect(() => host.open().redirect("http://provider.example/authorize")).toThrow();
  });
});

describe("native approval card", () => {
  test("an app action reads as one plain question with Allow and Cancel", async () => {
    const decided: string[] = [];
    const args = {
      id: "createOrganizationInvitation",
      pathParameters: { organizationId: "org-1" },
      body: { email: "anna@example.com", role: "member" },
    };
    mounted = await renderComponent(
      <ApprovalStrip
        approvals={[
          {
            id: "call-invite",
            name: "opengeni__admin_action_call",
            arguments: args,
            display: {
              toolName: "admin_action_call",
              title: "Invite anna@example.com to your organization?",
            },
          } as PendingApproval,
        ]}
        onDecide={async (id, decision) => {
          decided.push(`${id}:${decision}`);
        }}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Invite anna@example.com to your organization?");
    expect(text).toContain("anna@example.com");
    // The raw call waits behind Details.
    expect(text).not.toContain("createOrganizationInvitation");
    const labels = buttonLabels();
    expect(labels).toContain("Allow");
    expect(labels).toContain("Cancel");
    expect(labels).toContain("Details");
    await act(async () => {
      [...mounted!.container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Allow")!
        .click();
    });
    expect(decided).toEqual(["call-invite:approve"]);
  });
});
