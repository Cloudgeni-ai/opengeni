import { expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { flush, registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements. The session screen, its signals, queue dock,
 * approval strip and question card are the real ones; the timeline only draws
 * its trailing slot and the composer only its `above` slot.
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

const timelinePath = new URL("../src/timeline/message-timeline.tsx", import.meta.url).pathname;
// What the screen hands the timeline, for the turn-detail switch.
const timelineSignals: unknown[] = [];
mock.module(timelinePath, () => ({
  MessageTimeline: (props: { trailing?: ReactNode; agentSignals?: unknown }) => {
    timelineSignals.push(props.agentSignals);
    return createElement("div", { "data-testid": "timeline" }, props.trailing);
  },
}));
const annotationsPath = new URL("../src/timeline/annotations.tsx", import.meta.url).pathname;
mock.module(annotationsPath, () => ({
  AnnotationsChip: () => null,
  AnnotationsSheet: () => null,
}));
const attachmentsPath = new URL("../src/timeline/message-attachments.tsx", import.meta.url)
  .pathname;
mock.module(attachmentsPath, () => ({ NativeMessageAttachments: () => null }));

const { NativeSessionScreen } = await import("../src/timeline/session-screen");
const { useSessionControl } = await import("../../react/src/hooks/use-session-control");
const { fakeGoal, fakeTurn } = await import("../../react/test/fake-client");

const effectiveControl = { state: "active", controlVersion: 4, controlEtag: "etag-4" };
const session = {
  id: "session-a",
  workspaceId: "workspace-a",
  status: "requires_action",
  effectiveControl,
  backgroundCommandActivity: { count: 1 },
};
const helper = {
  session: {
    id: "session-child",
    title: "Measure the bathroom",
    status: "running",
    effectiveControl: { state: "active" },
    createdAt: "2026-11-05T08:00:00.000Z",
    updatedAt: "2026-11-05T08:00:00.000Z",
  },
  children: [],
};
const question = {
  id: "request-1",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  turnId: "turn-1",
  status: "pending",
  questions: [
    {
      id: "colour",
      kind: "text",
      prompt: "Which colour should the kitchen wall be?",
      options: [],
      required: true,
      allowOther: false,
    },
  ],
  allowSkip: true,
  response: null,
  expiresAt: null,
  createdAt: "2026-11-05T08:00:00.000Z",
  updatedAt: "2026-11-05T08:00:00.000Z",
};
const client = new Proxy({} as Record<string, unknown>, {
  get(target, key) {
    if (key === "then" || typeof key !== "string") return undefined;
    return target[key] ?? (async () => null);
  },
});

const noop = async () => {};
function Screen(props: { agentSignals?: unknown; loadReview?: unknown }) {
  const control = useSessionControl("session-a", {
    client: client as never,
    workspaceId: "workspace-a",
  });
  const controller = {
    sessionId: "session-a",
    workspaceId: "workspace-a",
    client,
    session: { session, refresh: noop, loading: false, error: null },
    events: [],
    timeline: [],
    timelineGroups: [],
    connectionState: "live",
    sessionStatus: "requires_action",
    initialLoading: false,
    hasOlder: false,
    loadingOlder: false,
    loadOlder: async () => false,
    queue: {
      snapshot: null,
      queue: [fakeTurn({ prompt: "Also order the tiles" })],
      pendingInputs: [],
      acceptedSteers: [],
      effectiveControl,
      mutationFor: () => null,
      refresh: noop,
    },
    composer: {
      value: "",
      setValue: () => {},
      send: noop,
      canSend: false,
      sending: false,
      pausing: false,
      resuming: false,
      pause: noop,
      resume: noop,
      annotations: [],
      optimisticMessages: [],
    },
    attachments: { pickImages: noop, addFiles: noop, attachments: [] },
    approvals: [{ id: "call-1", name: "deploy", arguments: { environment: "test" } }],
    control,
    humanInput: { requests: [question], respondingRequestId: null, respond: noop },
    goal: { goal: fakeGoal({ status: "paused", pausedReason: "agent" }) },
    lineage: { lineage: { ancestors: [], children: [helper] } },
    active: true,
    admissionBlocked: false,
    displayStatus: "requires_action",
    runActive: false,
    error: null,
    refresh: noop,
  };
  return createElement(NativeSessionScreen, {
    controller: controller as never,
    // The composer draws only what sits above it: queue, signals and approvals.
    renderComposer: (composer: { above?: ReactNode }) =>
      createElement("div", { "data-testid": "above-composer" }, composer.above),
    ...(props.agentSignals === undefined ? {} : { agentSignals: props.agentSignals }),
    ...(props.loadReview === undefined ? {} : { loadReview: props.loadReview }),
  } as never);
}

const chip = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith(`${label}, `),
  ) ?? null;

test("by default the screen shows the goal, agents and commands chips", async () => {
  const view = await renderComponent(createElement(Screen));
  await flush();
  expect(chip(view.container, "Goal")).not.toBeNull();
  expect(chip(view.container, "1 agent")).not.toBeNull();
  expect(chip(view.container, "1 command")).not.toBeNull();
  await view.unmount();
});

test("agentSignals={false} hides the chips but keeps the queue, approvals and the question", async () => {
  const view = await renderComponent(createElement(Screen, { agentSignals: false }));
  await flush();
  expect(chip(view.container, "Goal")).toBeNull();
  expect(chip(view.container, "1 agent")).toBeNull();
  expect(chip(view.container, "1 command")).toBeNull();
  const text = view.container.textContent ?? "";
  expect(text).toContain("1 queued");
  expect(text).toContain("Approval needed");
  expect(text).toContain("Which colour should the kitchen wall be?");
  await view.unmount();
});

test("{ goal: false } hides only the goal chip: queue, agents and commands stay", async () => {
  const view = await renderComponent(createElement(Screen, { agentSignals: { goal: false } }));
  await flush();
  expect(chip(view.container, "Goal")).toBeNull();
  expect(chip(view.container, "1 agent")).not.toBeNull();
  expect(chip(view.container, "1 command")).not.toBeNull();
  expect(view.container.textContent).toContain("1 queued");
  await view.unmount();
});

test("{ agents: false } and { commands: false } each hide only their chip", async () => {
  const noAgents = await renderComponent(
    createElement(Screen, { agentSignals: { agents: false } }),
  );
  await flush();
  expect(chip(noAgents.container, "Goal")).not.toBeNull();
  expect(chip(noAgents.container, "1 agent")).toBeNull();
  expect(chip(noAgents.container, "1 command")).not.toBeNull();
  await noAgents.unmount();
  const noCommands = await renderComponent(
    createElement(Screen, { agentSignals: { commands: false } }),
  );
  await flush();
  expect(chip(noCommands.container, "Goal")).not.toBeNull();
  expect(chip(noCommands.container, "1 agent")).not.toBeNull();
  expect(chip(noCommands.container, "1 command")).toBeNull();
  await noCommands.unmount();
});

test("the turn-detail switch reaches the timeline unchanged", async () => {
  for (const agentSignals of [{ goal: false }, { turnDetail: false }, false]) {
    timelineSignals.length = 0;
    const view = await renderComponent(createElement(Screen, { agentSignals }));
    await flush();
    expect(timelineSignals.at(-1)).toEqual(agentSignals);
    await view.unmount();
  }
});

test("the chips share the composer's own block with the queue", async () => {
  const view = await renderComponent(createElement(Screen, { agentSignals: { goal: false } }));
  await flush();
  const above = view.container.querySelector('[data-testid="above-composer"]');
  expect(above?.contains(chip(view.container, "1 agent"))).toBe(true);
  expect(above?.textContent).toContain("1 queued");
  await view.unmount();
});

test("the host's loadReview reaches the approval card", async () => {
  const read: string[] = [];
  const loadReview = async (approval: { id: string }) => {
    read.push(approval.id);
    return {
      version: 1,
      id: approval.id,
      actionDigest: "",
      revision: "host",
      status: "pending",
      title: "Deploy the test site?",
      consequence: "People using the test site see the new version.",
      effects: [],
      fields: [],
      moreFields: 0,
      reason: "",
      createdAt: "",
      updatedAt: "",
      approveLabel: "Deploy",
      availableActions: ["approve", "reject"],
      detailsAvailable: true,
    };
  };
  const view = await renderComponent(createElement(Screen, { loadReview }));
  await flush();
  const text = view.container.textContent ?? "";
  expect(read).toEqual(["call-1"]);
  expect(text).toContain("Deploy the test site?");
  expect(text).toContain("People using the test site see the new version.");
  expect(text).not.toContain("Environment");
  await view.unmount();
});
