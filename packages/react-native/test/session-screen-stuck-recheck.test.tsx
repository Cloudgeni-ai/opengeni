import { beforeEach, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { actRun, registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so the host components are
 * stood in for by DOM elements. The session screen and its stuck card are the
 * real ones; the timeline only draws its trailing slot.
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

/*
 * The native stuck card's "Try again" must stay busy while its recheck is in
 * flight, so a second tap cannot send a second Resume.
 */
const timelinePath = new URL("../src/timeline/message-timeline.tsx", import.meta.url).pathname;
mock.module(timelinePath, () => ({
  MessageTimeline: (props: { trailing?: ReactNode }) =>
    createElement("div", { "data-testid": "timeline" }, props.trailing),
}));
const annotationsPath = new URL("../src/timeline/annotations.tsx", import.meta.url).pathname;
mock.module(annotationsPath, () => ({
  AnnotationsChip: () => null,
  AnnotationsSheet: () => null,
}));

const composerPath = new URL("../src/timeline/composer.tsx", import.meta.url).pathname;
mock.module(composerPath, () => ({ SessionComposer: () => null }));
const attachmentsPath = new URL("../src/timeline/message-attachments.tsx", import.meta.url)
  .pathname;
mock.module(attachmentsPath, () => ({ NativeMessageAttachments: () => null }));

const { NativeSessionScreen } = await import("../src/timeline/session-screen");
const { OpenGeniContext } = await import("../../react/src/session-context");
const { useSessionControl } = await import("../../react/src/hooks/use-session-control");
const { flush } = await import("../../react/test/render-hook");

const session = {
  id: "session-a",
  workspaceId: "workspace-a",
  status: "requires_action",
  activeSandboxId: null,
  effectiveControl: { state: "active", controlVersion: 4, controlEtag: "etag-4" },
  admissionBlock: {
    reason: "personal_resource_grant_required",
    retryPolicy: "explicit_recheck",
    blockedAt: "2026-10-21T12:40:43Z",
  },
};

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const resumes: { args: unknown[]; done: ReturnType<typeof deferred> }[] = [];
const client = new Proxy(
  {
    resumeSession: (...args: unknown[]) => {
      const done = deferred();
      resumes.push({ args, done });
      return done.promise;
    },
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (key === "then" || typeof key !== "string") return undefined;
      return target[key] ?? (async () => null);
    },
  },
);

beforeEach(() => {
  resumes.length = 0;
});

const noop = async () => {};
function Screen() {
  const control = useSessionControl("session-a", {
    client: client as never,
    workspaceId: "workspace-a",
  });
  const controller = {
    sessionId: "session-a",
    workspaceId: "workspace-a",
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
      queue: [],
      pendingInputs: [],
      acceptedSteers: [],
      effectiveControl: session.effectiveControl,
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
    approvals: [],
    control,
    humanInput: { requests: [], respondingRequestId: null, respond: noop },
    goal: { goal: null },
    lineage: { lineage: null },
    active: true,
    admissionBlocked: true,
    displayStatus: "blocked",
    runActive: false,
    error: null,
    refresh: noop,
  };
  return createElement(NativeSessionScreen, {
    controller: controller as never,
    renderComposer: () => null,
  } as never);
}

async function renderScreen() {
  const view = await renderComponent(
    createElement(
      OpenGeniContext.Provider,
      { value: { client, workspaceId: "workspace-a" } as never },
      createElement(Screen),
    ),
  );
  const retry = () => {
    const button = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Try again"]',
    );
    if (!button) throw new Error("Try again is not shown");
    return button;
  };
  return { view, retry };
}

test("the stuck card's Try again stays busy while its recheck runs, so a second tap sends nothing", async () => {
  const { view, retry } = await renderScreen();
  expect(retry().disabled).toBe(false);
  await actRun(() => retry().click());
  await flush();
  expect(resumes).toHaveLength(1);
  expect(resumes[0]!.args.slice(0, 2)).toEqual(["workspace-a", "session-a"]);
  expect(resumes[0]!.args[2]).toMatchObject({ expectedControlEtag: "etag-4" });
  // In flight: the button is disabled (busy) and a second tap is ignored.
  expect(retry().disabled).toBe(true);
  await actRun(() => retry().click());
  await flush();
  expect(resumes).toHaveLength(1);
  // The recheck settles: the button is usable again.
  await actRun(async () => {
    resumes[0]!.done.resolve({ session });
  });
  await flush();
  expect(retry().disabled).toBe(false);
  expect(view.container.textContent).not.toContain("That didn't go through");
  await view.unmount();
});

test("a refused recheck says so and lets the person try again", async () => {
  const { view, retry } = await renderScreen();
  await actRun(() => retry().click());
  await flush();
  expect(retry().disabled).toBe(true);
  await actRun(async () => {
    resumes[0]!.done.reject(new Error("control conflict"));
  });
  await flush();
  expect(view.container.textContent).toContain("That didn't go through");
  expect(retry().disabled).toBe(false);
  await actRun(() => retry().click());
  await flush();
  expect(resumes).toHaveLength(2);
  await actRun(async () => {
    resumes[1]!.done.resolve({ session });
  });
  await flush();
  await view.unmount();
});
