import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
import { OpenGeniApiError, type ToolActionReview } from "@opengeni/sdk";
import type { PendingApproval } from "@opengeni/react/session";
import {
  flush,
  registerDom,
  renderComponent,
  type RenderedComponent,
} from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements. The approval strip and its review loading are
 * the real ones.
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
    const node = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({
      clear: () => {
        if (node.current) node.current.value = "";
      },
      measureInWindow: () => undefined,
    }));
    return createElement("input", {
      ref: node,
      "aria-label": props.accessibilityLabel,
      placeholder: props.placeholder,
      disabled: props.editable === false,
      onChange: (event: { target: { value: string } }) =>
        (props.onChangeText as ((value: string) => void) | undefined)?.(event.target.value),
    });
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

const { ApprovalStrip } = await import("../src/timeline/decisions");

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  const current = mounted;
  mounted = null;
  await current?.unmount();
});

// A write tool whose arguments are only identifiers: on its own the card can
// show nothing but the tool's title and those identifiers.
const approval: PendingApproval = {
  id: "call-move",
  name: "tracker__move_card",
  arguments: {
    cardId: "crd_7Q2x9",
    commandId: "cmd_51f0",
    expectedVersion: "v_9a8b7c6d",
  },
  display: { toolName: "move_card", title: "Move Card" },
} as PendingApproval;

function hostReview(overrides: Partial<ToolActionReview> = {}): ToolActionReview {
  return {
    version: 1,
    id: approval.id,
    actionDigest: "",
    revision: "host",
    status: "pending",
    title: "Move “Fix the login page” to Done?",
    consequence: "The card leaves In progress and its assignee is told it is finished.",
    effects: [],
    fields: [],
    moreFields: 0,
    reason: "",
    createdAt: "",
    updatedAt: "",
    approveLabel: "Move card",
    availableActions: ["approve", "reject"],
    detailsAvailable: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const text = () => mounted!.container.textContent ?? "";
const button = (label: string) =>
  [...mounted!.container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
const strip = (
  loadReview: ((approval: PendingApproval) => Promise<ToolActionReview | null>) | undefined,
  approvals: PendingApproval[] = [approval],
  decided: string[] = [],
) =>
  createElement(ApprovalStrip, {
    approvals,
    loadReview,
    onDecide: async (id: string, decision: "approve" | "reject") => {
      decided.push(`${id}:${decision}`);
    },
  });

describe("ApprovalStrip loadReview", () => {
  test("without a loader the card is today's: the tool's title and its identifiers", async () => {
    mounted = await renderComponent(strip(undefined));
    expect(text()).toContain("Move Card");
    expect(text()).toContain("crd_7Q2x9");
    expect(button("Approve")?.disabled).toBe(false);
  });

  test("the host's review replaces the title and raw identifiers, and decides the same approval", async () => {
    const decided: string[] = [];
    const read: PendingApproval[] = [];
    mounted = await renderComponent(
      strip(
        async (value) => {
          read.push(value);
          return hostReview();
        },
        [approval],
        decided,
      ),
    );
    await flush();
    expect(read).toEqual([approval]);
    expect(text()).toContain("Move “Fix the login page” to Done?");
    expect(text()).toContain(
      "The card leaves In progress and its assignee is told it is finished.",
    );
    for (const raw of ["Move Card", "crd_7Q2x9", "cmd_51f0", "v_9a8b7c6d", "Command"])
      expect(text()).not.toContain(raw);
    // The raw call still waits behind Details.
    await act(async () => button("Details")!.click());
    expect(text()).toContain("cmd_51f0");
    await act(async () => button("Move card")!.click());
    expect(decided).toEqual(["call-move:approve"]);
  });

  test("while the review loads, the card keeps today's title and holds Approve; Reject still works", async () => {
    const decided: string[] = [];
    const pending = deferred<ToolActionReview>();
    mounted = await renderComponent(strip(() => pending.promise, [approval], decided));
    expect(text()).toContain("Move Card");
    expect(text()).not.toContain("crd_7Q2x9");
    expect(
      mounted.container.querySelector('[data-role="progressbar"]')?.getAttribute("aria-label"),
    ).toBe("Loading action details…");
    expect(button("Approve")?.disabled).toBe(true);
    expect(button("Details")).toBeUndefined();
    await act(async () => pending.resolve(hostReview()));
    await flush();
    expect(mounted.container.querySelector('[data-role="progressbar"]')).toBeNull();
    expect(text()).toContain("Move “Fix the login page” to Done?");
    expect(button("Move card")?.disabled).toBe(false);
    await act(async () => button("Reject")!.click());
    expect(decided).toEqual(["call-move:reject"]);
  });

  const keepsStandardCard: Array<[string, () => Promise<ToolActionReview | null>]> = [
    ["resolves null", async () => null],
    [
      "has no saved review (404)",
      async () => {
        throw new OpenGeniApiError(404, "Review not found");
      },
    ],
  ];
  test.each(keepsStandardCard)(
    "a loader that %s keeps today's card, decidable",
    async (_case, loadReview) => {
      mounted = await renderComponent(strip(loadReview));
      await flush();
      expect(text()).toContain("Move Card");
      expect(text()).toContain("crd_7Q2x9");
      expect(text()).not.toContain("Couldn't load");
      expect(button("Approve")?.disabled).toBe(false);
    },
  );

  test("a failed read falls back to today's card, decidable, and Try again reads it again", async () => {
    let calls = 0;
    mounted = await renderComponent(
      strip(async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return hostReview();
      }),
    );
    await flush();
    expect(text()).toContain("Couldn't load the summary of this action.");
    expect(text()).toContain("crd_7Q2x9");
    expect(button("Approve")?.disabled).toBe(false);
    await act(async () => button("Try again")!.click());
    await flush();
    expect(calls).toBe(2);
    expect(text()).not.toContain("Couldn't load");
    expect(text()).toContain("Move “Fix the login page” to Done?");
  });

  test("a review of another action never stands in for this one", async () => {
    mounted = await renderComponent(strip(async () => hostReview({ id: "call-other" })));
    await flush();
    expect(text()).not.toContain("Fix the login page");
    expect(text()).toContain("Couldn't load the summary of this action.");
  });

  test("equal approvals re-projected by unrelated updates share one read; changed facts read again", async () => {
    let calls = 0;
    const loadReview = async () => {
      calls++;
      return hostReview();
    };
    mounted = await renderComponent(strip(loadReview, [structuredClone(approval)]));
    await flush();
    for (let index = 0; index < 3; index++) {
      await mounted.rerender(strip(loadReview, [structuredClone(approval)]));
      await flush();
    }
    expect(calls).toBe(1);
    expect(text()).toContain("Move “Fix the login page” to Done?");
    await mounted.rerender(
      strip(loadReview, [
        {
          ...approval,
          arguments: { ...(approval.arguments as Record<string, unknown>), cardId: "crd_2" },
        },
      ]),
    );
    await flush();
    expect(calls).toBe(2);
  });

  test("a review only its account's owner may approve offers Reject alone and says who decides", async () => {
    mounted = await renderComponent(
      strip(async () =>
        hostReview({
          availableActions: ["reject"],
          approvedBy: "account_owner",
          accountOwnerLabel: "Sam",
        }),
      ),
    );
    await flush();
    expect(button("Move card")).toBeUndefined();
    expect(button("Reject")?.disabled).toBe(false);
    expect(text()).toContain("Sam");
  });

  test("a server's question on the call is never read as a review", async () => {
    let calls = 0;
    mounted = await renderComponent(
      strip(async () => {
        calls++;
        return hostReview();
      }, [
        {
          ...approval,
          elicitation: {
            server: "Tracker",
            round: 1,
            requests: [
              {
                id: "q-1",
                mode: "form",
                message: "Which column?",
                requestedSchema: {
                  type: "object",
                  properties: { column: { type: "string", title: "Column" } },
                },
              },
            ],
          },
        } as PendingApproval,
      ]),
    );
    await flush();
    expect(calls).toBe(0);
    expect(text()).toContain("Tracker asks");
  });
});
