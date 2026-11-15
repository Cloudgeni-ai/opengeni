import { expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { LEVEL_MODELS, LEVELS, levelModel } from "../../react/test/fixtures/level-models";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * The native level control. Bun cannot parse react-native's Flow sources, so
 * host components are DOM stand-ins; the control's root records the
 * accessibility props it was given, which is how VoiceOver and TalkBack (and
 * this test) drive it.
 */
type RootProps = {
  accessibilityValue?: { text?: string };
  accessibilityHint?: string;
  accessibilityActions?: Array<{ name: string; label?: string }>;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};
let root: RootProps | null = null;
function host(tag: string) {
  return function Host(props: { children?: ReactNode; testID?: string }) {
    if (props.testID === "model-level-control") root = props as RootProps;
    return createElement(tag, null, props.children);
  };
}
type Pan = {
  onPanResponderGrant: () => void;
  onPanResponderRelease: (event: unknown, gesture: { dx: number }) => void;
};
let pan: Pan | null = null;
class AnimatedValue {
  setValue() {}
  stopAnimation() {}
  interpolate() {
    return this;
  }
}
mock.module("react-native", () => ({
  View: host("div"),
  Text: host("span"),
  Animated: {
    View: host("div"),
    Text: host("span"),
    Value: AnimatedValue,
    spring: () => ({ start: () => {} }),
    timing: () => ({ start: () => {} }),
  },
  PanResponder: {
    create: (config: Pan) => {
      pan = config;
      return { panHandlers: {} };
    },
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => true,
    addEventListener: () => ({ remove: () => {} }),
  },
  Platform: {
    OS: "ios",
    select: (options: Record<string, unknown>) => options.ios ?? options.default,
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
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

registerDom();

const { ModelLevelControl } = await import("../src/timeline/model-level-control");

const models = LEVEL_MODELS;
const levels = LEVELS;

async function render(state: {
  model: string;
  effort: "low" | "medium" | "high";
  latencyMode: "standard" | "ultrafast";
}) {
  const changes: string[] = [];
  const feedback: string[] = [];
  root = null;
  const rendered = await renderComponent(
    createElement(ModelLevelControl, {
      levels,
      models,
      ...state,
      onModelChange: (id: string) => changes.push(`model:${id}`),
      onEffortChange: (effort: string) => changes.push(`effort:${effort}`),
      onLatencyModeChange: (mode: string) => changes.push(`speed:${mode}`),
      onSelectionFeedback: (kind: string) => feedback.push(kind),
      fallback: createElement("span", null, "Full picker"),
    }),
  );
  const action = async (actionName: string) => {
    await act(async () => root!.onAccessibilityAction!({ nativeEvent: { actionName } }));
  };
  return { rendered, changes, feedback, action, root: () => root! };
}

test("stepping up moves to the next level and commits only what changed", async () => {
  const view = await render({ model: "codex/everyday", effort: "high", latencyMode: "standard" });
  expect(view.root().accessibilityValue?.text).toBe("Standard");
  // Ultrafast is offered only on the level that allows it.
  expect(view.root().accessibilityActions?.map((a) => a.name)).toEqual(["increment", "decrement"]);
  await view.action("increment");
  expect(view.changes).toEqual(["model:codex/deep"]);
  expect(view.feedback).toEqual(["level"]);
  await view.rendered.unmount();
});

test("on the level that allows it, Ultrafast is an explicit action", async () => {
  const view = await render({ model: "codex/deep", effort: "high", latencyMode: "standard" });
  const ultrafast = view.root().accessibilityActions?.find((a) => a.name === "ultrafast");
  expect(ultrafast?.label).toBe("Turn on Ultrafast");
  expect(view.root().accessibilityHint).toBeTruthy();
  // Stepping up at the end never turns Ultrafast on by itself.
  await view.action("increment");
  expect(view.changes).toEqual([]);
  await view.action("ultrafast");
  expect(view.changes).toEqual(["speed:ultrafast"]);
  expect(view.feedback).toEqual(["ultrafast"]);
  await view.rendered.unmount();
});

test("holding the control charges Ultrafast on any level that allows it", async () => {
  const changes: string[] = [];
  const feedback: string[] = [];
  root = null;
  const rendered = await renderComponent(
    createElement(ModelLevelControl, {
      levels: levels.map((level) => ({ ...level, ultrafast: true })),
      models: [levelModel("codex/everyday", "Everyday", true), models[1]!],
      model: "codex/everyday",
      effort: "high",
      latencyMode: "standard",
      onModelChange: (id: string) => changes.push(`model:${id}`),
      onEffortChange: () => {},
      onLatencyModeChange: (mode: string) => changes.push(`speed:${mode}`),
      onSelectionFeedback: (kind: string) => feedback.push(kind),
    }),
  );
  expect(root!.accessibilityHint).toBe("Hold for Ultrafast");
  expect(root!.accessibilityActions?.map((a) => a.name)).toContain("ultrafast");
  const press = async (ms: number) => {
    await act(async () => pan!.onPanResponderGrant());
    await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
    await act(async () => pan!.onPanResponderRelease({}, { dx: 0 }));
  };
  // Let go short of full: nothing changes, not even the level.
  await press(400);
  expect(changes).toEqual([]);
  await press(800);
  expect(changes).toEqual(["speed:ultrafast"]);
  expect(feedback).toEqual(["armed", "ultrafast"]);
  // A quick press is a tap: it steps to the next level.
  await press(20);
  expect(changes).toEqual(["speed:ultrafast", "model:codex/deep"]);
  await rendered.unmount();
});

test("with Ultrafast on, stepping down turns it off first", async () => {
  const view = await render({ model: "codex/deep", effort: "high", latencyMode: "ultrafast" });
  expect(view.root().accessibilityValue?.text).toContain("Ultrafast");
  expect(view.root().accessibilityActions?.map((a) => a.name)).toContain("standardSpeed");
  await view.action("decrement");
  expect(view.changes).toEqual(["speed:standard"]);
  await view.rendered.unmount();
});

test("a chat on another model shows that model until a level is picked", async () => {
  const view = await render({ model: "codex/small", effort: "low", latencyMode: "standard" });
  expect(view.root().accessibilityValue?.text).toContain("Small");
  await view.action("increment");
  expect(view.changes).toEqual(["model:codex/everyday", "effort:high"]);
  await view.rendered.unmount();
});

test("a new chat outside the levels starts on the first one", async () => {
  const changes: string[] = [];
  const rendered = await renderComponent(
    createElement(ModelLevelControl, {
      levels,
      models,
      model: "codex/everyday",
      effort: "medium",
      latencyMode: "standard",
      startOnFirstLevel: true,
      onModelChange: (id: string) => changes.push(`model:${id}`),
      onEffortChange: (effort: string) => changes.push(`effort:${effort}`),
      onLatencyModeChange: () => {},
    }),
  );
  expect(changes).toEqual(["effort:high"]);
  await rendered.unmount();
});

test("with no runnable level the host's fallback shows", async () => {
  root = null;
  const rendered = await renderComponent(
    createElement(ModelLevelControl, {
      levels: [{ id: "x", label: "X", model: "codex/missing", effort: "high" }],
      models,
      model: "codex/everyday",
      effort: "high",
      latencyMode: "standard",
      onModelChange: () => {},
      onEffortChange: () => {},
      onLatencyModeChange: () => {},
      fallback: createElement("span", null, "Full picker"),
    }),
  );
  expect(root).toBeNull();
  expect(document.body.textContent).toContain("Full picker");
  await rendered.unmount();
});
