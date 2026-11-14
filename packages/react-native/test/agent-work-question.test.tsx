import { expect, mock, test } from "bun:test";
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * The native timeline draws a question the parent agent answered as one quiet
 * row inside the turn's work, and keeps a person's answer in the conversation.
 * An automation run is one plain line and its answer: never its instructions,
 * nothing for a run with nothing to say, and no work row for a reader who
 * never sees the agent's work. Host components are DOM stand-ins.
 */
type Recorded = { props: Record<string, unknown>; clears: number };
const inputs = new Map<string, Recorded>();
type Layout = { nativeEvent: { layout: { y: number; height: number } } };
type Scroll = {
  nativeEvent: {
    contentOffset: { y: number };
    contentSize: { height: number };
    layoutMeasurement: { height: number };
  };
};
type ScrollProps = {
  children?: ReactNode;
  onLayout(event: Layout): void;
  onContentSizeChange(width: number, height: number): void;
  onScrollBeginDrag(): void;
  onScroll(event: Scroll): void;
  onScrollEndDrag(event: Scroll): void;
  onMomentumScrollEnd(event: Scroll): void;
};
let scrollProps: ScrollProps;
let promptLayout: ((event: Layout) => void) | undefined;
const scrollOffsets: number[] = [];

function host(tag: string) {
  return function Host(props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    testID?: string;
    onLayout?: (event: Layout) => void;
  }) {
    const child = props.children as {
      props?: { group?: { kind: string; item?: { kind: string } } };
    } | null;
    if (child?.props?.group?.kind === "item" && child.props.group.item?.kind === "user-message") {
      promptLayout = props.onLayout;
    }
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
    ScrollView: forwardRef(function ScrollView(props: ScrollProps, ref) {
      scrollProps = props;
      useImperativeHandle(ref, () => ({
        scrollTo: ({ y }: { y: number }) => scrollOffsets.push(y),
        scrollToEnd: () => scrollOffsets.push(Number.POSITIVE_INFINITY),
      }));
      return createElement("div", {}, props.children);
    }),
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
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove: () => {} }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    // Only the drawing surface is a DOM stand-in, so a test can find the orb.
    default: (props: { testID?: string }) => createElement("svg", { "data-testid": props.testID }),
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
const { NativeTimelineMessagesProvider } = await import("../src/timeline/messages");

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

function subSession(respondedByKind: string, outcome = "answered"): SessionEvent[] {
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
      response:
        outcome === "answered"
          ? { outcome, answers: [{ questionId: "base", values: ["both"] }] }
          : { outcome },
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

test("an agent's skip is quiet work that honours the host's outcome copy", async () => {
  const view = await renderComponent(
    <NativeTimelineMessagesProvider
      messages={{
        humanInputOutcome: {
          answered: "You answered",
          skipped: "Skipped",
          expired: "Expired",
          cancelled: "Cancelled",
          agentSkipped: "Parent skipped",
        },
      }}
    >
      <MessageTimeline events={subSession("agent_attempt", "skipped")} />
    </NativeTimelineMessagesProvider>,
  );
  try {
    expect(view.container.textContent).not.toContain("Agent asked");
    await pressLabelled(view.container, /Worked for/);
    expect(view.container.textContent).toContain("Target branch → Skipped");
    // The spoken label has no arrow for screen readers to announce.
    await pressLabelled(view.container, /^Asked: Target branch: Skipped$/);
    expect(view.container.textContent).toContain("Parent skipped");
  } finally {
    await view.unmount();
  }
});

test("a system skip (a scheduled run's unanswered question) keeps its card", async () => {
  const view = await renderComponent(<MessageTimeline events={subSession("system", "skipped")} />);
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Agent asked");
    expect(text).toContain("Skipped");
  } finally {
    await view.unmount();
  }
});

test("startup disappears on first useful output, not just on turn completion", async () => {
  sequence = 0;
  // A start that just happened; one 30 seconds old says it is taking longer.
  const now = (each: SessionEvent): SessionEvent => ({
    ...each,
    occurredAt: new Date().toISOString(),
  });
  const events = [
    event("user.message", { text: "Plan a garden afternoon." }),
    event("turn.started", {}),
    event("turn.startup.phase.started", { phase: "model_preparation" }),
  ].map(now);
  const view = await renderComponent(<MessageTimeline events={events} />);
  try {
    expect(view.container.textContent).toContain("Working");
    // The animated orb is the default visual while the reply is prepared.
    expect(view.container.querySelector('[data-testid="thinking-orb"]')).not.toBeNull();
    await view.rerender(
      <MessageTimeline
        events={[
          ...events,
          now(event("agent.message.delta", { text: "Start with a short walk." })),
        ]}
      />,
    );
    expect(view.container.textContent).toContain("Start with a short walk.");
    expect(view.container.textContent).not.toContain("Working");
    expect(view.container.textContent).not.toContain("Waiting for a response");
    expect(view.container.querySelector('[data-testid="thinking-orb"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

test("a start that runs past 30 seconds says it is taking longer than usual", async () => {
  sequence = 0;
  const events = [
    event("user.message", { text: "Plan a garden afternoon." }),
    event("turn.started", {}),
    event("turn.startup.phase.started", { phase: "model_preparation" }),
  ];
  const view = await renderComponent(<MessageTimeline events={events} />);
  try {
    expect(view.container.textContent).toContain("A little longer than usual");
  } finally {
    await view.unmount();
  }
});

test("useful output does not hide a failed preparation row", async () => {
  sequence = 0;
  const events = [
    event("user.message", { text: "Plan a garden afternoon." }),
    event("turn.started", {}),
    event("turn.startup.phase.failed", { phase: "tools", durationMs: 100 }),
  ];
  const view = await renderComponent(<MessageTimeline events={events} />);
  try {
    const failure = view.container.textContent ?? "";
    expect(failure).toMatch(/failed/i);
    await view.rerender(
      <MessageTimeline
        events={[...events, event("agent.message.delta", { text: "Here is what I can do." })]}
      />,
    );
    expect(view.container.textContent).toMatch(/failed/i);
  } finally {
    await view.unmount();
  }
});

test("layout and programmatic momentum keep the answer start; a reader's scroll releases it", async () => {
  sequence = 0;
  scrollOffsets.length = 0;
  promptLayout = undefined;
  const events = [
    event("user.message", { text: "Plan a garden afternoon." }),
    event("turn.started", {}),
  ];
  const view = await renderComponent(<MessageTimeline events={events} />);
  const scrollEvent = (y: number): Scroll => ({
    nativeEvent: {
      contentOffset: { y },
      contentSize: { height: 2000 },
      layoutMeasurement: { height: 500 },
    },
  });
  try {
    await act(async () => {
      scrollProps.onLayout({ nativeEvent: { layout: { y: 0, height: 500 } } });
      scrollProps.onContentSizeChange(390, 2000);
    });
    expect(scrollOffsets).toHaveLength(0);
    await act(async () => {
      promptLayout!({ nativeEvent: { layout: { y: 36, height: 124 } } });
      scrollProps.onContentSizeChange(390, 2000);
    });
    expect(scrollOffsets.at(-1)).toBe(24);
    // UIKit can report momentum completion for our own scroll, without a drag.
    await act(async () => {
      scrollProps.onMomentumScrollEnd(scrollEvent(1500));
      scrollProps.onContentSizeChange(390, 2300);
    });
    expect(scrollOffsets.at(-1)).toBe(24);
    await act(async () => {
      scrollProps.onScrollBeginDrag();
      scrollProps.onScroll(scrollEvent(400));
      scrollProps.onScrollEndDrag(scrollEvent(400));
      scrollProps.onMomentumScrollEnd(scrollEvent(600));
    });
    const count = scrollOffsets.length;
    await act(async () => scrollProps.onContentSizeChange(390, 2500));
    expect(scrollOffsets).toHaveLength(count);
    // Sending resumes answer-start following rather than tail following.
    await view.rerender(<MessageTimeline events={events} followLatestSignal={1} />);
    expect(scrollOffsets.at(-1)).toBe(24);
  } finally {
    await view.unmount();
  }
});

const INSTRUCTIONS = "Continue this conversation when a ticket is assigned to the signed-in user.";

function automationRun(member: Record<string, unknown>, answer: string): SessionEvent[] {
  sequence = 0;
  return [
    event(
      "system.update.delivered",
      {
        members: [
          {
            id: "update-1",
            kind: "scheduled_occurrence",
            sourceId: "run-1",
            classification: "info",
            ...member,
          },
        ],
      },
      "run",
    ),
    event("turn.started", {}, "run"),
    event("agent.toolCall.created", { id: "call-1", name: "get_ticket", arguments: {} }, "run"),
    event("agent.toolCall.output", { id: "call-1", output: "{}" }, "run"),
    event("agent.message.completed", { messageId: "m1", phase: "final", text: answer }, "run"),
    event("turn.completed", {}, "run"),
  ];
}

const named = {
  summary: "Ticket assigned to you",
  automation: {
    name: "Ticket assigned to you",
    eventSummaries: ["T-4907 Refund request"],
    eventCount: 1,
  },
};

const workRow = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) =>
    /Worked for|Steps/.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
  );

test("an automation run reads as one line saying what happened, then the answer", async () => {
  const view = await renderComponent(
    <MessageTimeline events={automationRun(named, "Contoso wants a refund.")} />,
  );
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Ticket assigned to you: T-4907 Refund request");
    expect(text).toContain("Contoso wants a refund.");
    expect(text).not.toContain("Continue this conversation");
  } finally {
    await view.unmount();
  }
});

test("an older run never shows its instructions", async () => {
  const view = await renderComponent(
    <MessageTimeline events={automationRun({ summary: INSTRUCTIONS }, "Done.")} />,
  );
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Automation run");
    expect(text).not.toContain("Continue this conversation");
  } finally {
    await view.unmount();
  }
});

test("a run with nothing for the person is not drawn", async () => {
  const view = await renderComponent(<MessageTimeline events={automationRun(named, "NO_REPLY")} />);
  try {
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Ticket assigned to you");
    expect(text).not.toContain("NO_REPLY");
  } finally {
    await view.unmount();
  }
});

test("without agent signals there is no work row under the line", async () => {
  const events = automationRun(named, "Contoso wants a refund.");
  const full = await renderComponent(<MessageTimeline events={events} />);
  try {
    expect(workRow(full.container)).toBeDefined();
  } finally {
    await full.unmount();
  }
  const simple = await renderComponent(<MessageTimeline events={events} agentSignals={false} />);
  try {
    expect(workRow(simple.container)).toBeUndefined();
    const text = simple.container.textContent ?? "";
    expect(text).toContain("Ticket assigned to you: T-4907 Refund request");
    expect(text).toContain("Contoso wants a refund.");
  } finally {
    await simple.unmount();
  }
});

test("only agentSignals' turnDetail switch replaces the host's facets with the status", async () => {
  sequence = 0;
  const events = [
    event("user.message", { text: "Update the records." }, null),
    event("turn.started", {}),
    event("agent.toolCall.created", { id: "call-1", name: "update_records", arguments: {} }),
    event("agent.toolCall.output", { id: "call-1", output: "{}" }),
    event("agent.message.completed", { messageId: "m1", phase: "final", text: "Done." }),
    event("turn.completed", {}),
  ];
  const facets = {
    replace: [{ id: "records", summarize: () => ({ content: "2 records updated" }) }],
  };
  const rowText = async (agentSignals: Parameters<typeof MessageTimeline>[0]["agentSignals"]) => {
    const view = await renderComponent(
      <MessageTimeline events={events} facets={facets} agentSignals={agentSignals} />,
    );
    try {
      return view.container.textContent ?? "";
    } finally {
      await view.unmount();
    }
  };
  expect(await rowText(undefined)).toContain("2 records updated");
  expect(await rowText({ goal: false, agents: false, commands: false })).toContain(
    "2 records updated",
  );
  expect(await rowText({ turnDetail: false })).not.toContain("2 records updated");
  expect(await rowText(false)).not.toContain("2 records updated");
});

test("an ID in what the event says goes with its label, never leaving it dangling", async () => {
  const withId = {
    summary: "Ticket assigned to you",
    automation: {
      name: "Ticket assigned to you",
      eventSummaries: [
        "T-4907 Refund request. Organisation: 3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c.",
      ],
      eventCount: 1,
    },
  };
  const view = await renderComponent(
    <MessageTimeline events={automationRun(withId, "Contoso wants a refund.")} />,
  );
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Ticket assigned to you: T-4907 Refund request.");
    expect(text).not.toContain("Organisation");
    expect(text).not.toContain("3f2b8c1e");
  } finally {
    await view.unmount();
  }
});
