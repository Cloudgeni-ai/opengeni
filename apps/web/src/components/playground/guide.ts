import type { AgentSettings, QuestionId } from "./acme-script";

/* ----------------------------------------------------------------------------
   The playground's light guide: four steps, each done by using the control it
   names. Nothing is locked; doing a later step early just ticks it off, and
   the guide moves to the next step not yet done.
   -------------------------------------------------------------------------- */

export const GUIDE_STEPS = ["ask", "style", "tools", "ship"] as const;
export type GuideStepId = (typeof GUIDE_STEPS)[number];

export type GuideState = Readonly<{
  /** The step the guide points at; null once finished or skipped. */
  current: GuideStepId | null;
  done: readonly GuideStepId[];
}>;

export const INITIAL_GUIDE: GuideState = { current: "ask", done: [] };

export type GuideEvent =
  | { type: "answered"; question: QuestionId; settings: AgentSettings }
  | { type: "styled" }
  | { type: "shipped" }
  | { type: "skip" }
  | { type: "jump"; step: GuideStepId }
  | { type: "dismiss" }
  | { type: "restart" };

function nextOpen(done: readonly GuideStepId[], after: GuideStepId): GuideStepId | null {
  const start = GUIDE_STEPS.indexOf(after) + 1;
  for (const step of GUIDE_STEPS.slice(start)) if (!done.includes(step)) return step;
  for (const step of GUIDE_STEPS.slice(0, start)) if (!done.includes(step)) return step;
  return null;
}

function complete(state: GuideState, step: GuideStepId): GuideState {
  if (state.done.includes(step)) return state;
  const done = [...state.done, step];
  // Finishing the step in view moves on; finishing another one just ticks it.
  return { current: state.current === step ? nextOpen(done, step) : state.current, done };
}

/** Which step an event completes, if any. */
export function completedStep(event: GuideEvent): GuideStepId | null {
  switch (event.type) {
    case "answered":
      // A tool answer proves the tools step; any answer proves asking.
      return event.settings.tools && event.question !== "other" ? "tools" : "ask";
    case "styled":
      return "style";
    case "shipped":
      return "ship";
    default:
      return null;
  }
}

export function guideReducer(state: GuideState, event: GuideEvent): GuideState {
  switch (event.type) {
    case "skip":
      return state.current ? complete(state, state.current) : state;
    case "jump":
      return { ...state, current: event.step };
    case "dismiss":
      return { ...state, current: null };
    case "restart":
      return INITIAL_GUIDE;
    case "answered": {
      // A tool answer is also an answer: it ticks asking too.
      let next = complete(state, "ask");
      if (completedStep(event) === "tools") next = complete(next, "tools");
      return next;
    }
    default: {
      const step = completedStep(event);
      return step ? complete(state, step) : state;
    }
  }
}

export function parseGuideState(raw: string | null): GuideState {
  try {
    const saved = JSON.parse(raw ?? "null") as Partial<GuideState> | null;
    if (!saved || !Array.isArray(saved.done)) return INITIAL_GUIDE;
    const done = saved.done.filter((step): step is GuideStepId =>
      (GUIDE_STEPS as readonly string[]).includes(step),
    );
    const current =
      saved.current === null
        ? null
        : (GUIDE_STEPS as readonly string[]).includes(saved.current as string)
          ? (saved.current as GuideStepId)
          : INITIAL_GUIDE.current;
    return { current, done };
  } catch {
    return INITIAL_GUIDE;
  }
}
