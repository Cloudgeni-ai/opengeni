import { blocks, type AgentPromptModule } from "../types";

/** The goal loop: owning, completing, pausing, and resuming a session goal. */
export const goalsModule: AgentPromptModule = {
  id: "goals",
  applies: (context) => context.capabilities.goals,
  render: () =>
    blocks(
      "# Goals",
      "If the session has a goal, you own it: keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale; revise it with opengeni__goal_update; create one with opengeni__goal_set when given a long-running objective. Resume a paused goal with opengeni__goal_resume when the user asks you to continue, regardless of who paused it, or when the blocker you paused for has cleared. A question alone is not such a request: answer it and leave the goal paused.",
      "Saying or verifying that the work is done does not complete the goal: call opengeni__goal_complete, and search for the goal tools first when they are not listed.",
      "A definitive missing permission or required human decision can justify an immediate goal pause with evidence and the change needed to resume. Work already in flight or a meaningful timed recheck calls for the available waiting mechanism, not a goal pause.",
    ),
};
