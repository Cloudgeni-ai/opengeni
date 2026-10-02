import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_SETTINGS } from "./acme-script";
import { INITIAL_GUIDE, guideReducer, parseGuideState, type GuideEvent } from "./guide";

const plain = DEFAULT_AGENT_SETTINGS;
const withTools = { ...DEFAULT_AGENT_SETTINGS, tools: true };
const run = (...events: GuideEvent[]) => events.reduce(guideReducer, INITIAL_GUIDE);

describe("playground guide", () => {
  test("walks ask, restyle, tools, then adding it to a product", () => {
    let state = run({ type: "answered", question: "order", settings: plain });
    expect(state).toEqual({ current: "style", done: ["ask"] });
    state = guideReducer(state, { type: "styled" });
    expect(state).toEqual({ current: "tools", done: ["ask", "style"] });
    // An answer without tools doesn't prove the tools step.
    state = guideReducer(state, { type: "answered", question: "order", settings: plain });
    expect(state.current).toBe("tools");
    state = guideReducer(state, { type: "answered", question: "order", settings: withTools });
    expect(state).toEqual({ current: "ship", done: ["ask", "style", "tools"] });
    state = guideReducer(state, { type: "shipped" });
    expect(state).toEqual({ current: null, done: ["ask", "style", "tools", "ship"] });
  });

  test("nothing is locked: an early step ticks off and is skipped later", () => {
    let state = run({ type: "styled" });
    expect(state).toEqual({ current: "ask", done: ["style"] });
    state = guideReducer(state, { type: "answered", question: "charged", settings: plain });
    expect(state.current).toBe("tools");
    // A first answer that already used tools completes both steps at once.
    expect(run({ type: "answered", question: "order", settings: withTools })).toEqual({
      current: "style",
      done: ["ask", "tools"],
    });
  });

  test("a demo answer outside the script doesn't count as using tools", () => {
    expect(run({ type: "answered", question: "other", settings: withTools }).done).toEqual(["ask"]);
  });

  test("skip, jump, dismiss and restart", () => {
    expect(run({ type: "skip" })).toEqual({ current: "style", done: ["ask"] });
    expect(run({ type: "jump", step: "ship" }).current).toBe("ship");
    expect(run({ type: "dismiss" }).current).toBeNull();
    expect(run({ type: "skip" }, { type: "restart" })).toEqual(INITIAL_GUIDE);
    // Once dismissed, finishing a step doesn't bring the guide back.
    expect(run({ type: "dismiss" }, { type: "styled" })).toEqual({
      current: null,
      done: ["style"],
    });
  });

  test("restores saved progress and ignores anything malformed", () => {
    expect(parseGuideState(JSON.stringify({ current: "tools", done: ["ask", "bogus"] }))).toEqual({
      current: "tools",
      done: ["ask"],
    });
    expect(parseGuideState(JSON.stringify({ current: null, done: [] }))).toEqual({
      current: null,
      done: [],
    });
    expect(parseGuideState("{not json")).toEqual(INITIAL_GUIDE);
    expect(parseGuideState(null)).toEqual(INITIAL_GUIDE);
    expect(parseGuideState(JSON.stringify({ current: "nope", done: [] }))).toEqual(INITIAL_GUIDE);
  });
});
