import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import {
  blocks,
  sentences,
  toolAvailable,
  type AgentPromptContext,
  type AgentPromptModule,
} from "../types";

const GOAL_OWNERSHIP =
  "If the session has a goal, you own it: keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale; revise it with opengeni__goal_update; create one with opengeni__goal_set when given a long-running objective. Resume a paused goal with opengeni__goal_resume when the user asks you to continue, regardless of who paused it, or when the blocker you paused for has cleared. A question alone is not such a request: answer it and leave the goal paused.";

const GOAL_COMPLETION_HANDOFF =
  "Goal completion records short ledger proof, not the user-facing deliverable. After goal_complete succeeds, finish the same turn with the requested answer, or a concise summary and retained artifact link. Never use evidence as the final reply. A later child result after completion is context to integrate, not a reason to stay silent or restart the completed goal.";

const GOAL_COMPLETION_CALL =
  "Saying or verifying that the work is done does not complete the goal: call opengeni__goal_complete by its exact name, and search for a goal tool only when its input schema is not in context.";

const GOAL_COMPLETION_UNAVAILABLE =
  "Saying or verifying that the work is done does not complete the goal, and this session has no goal-completion tool: report the outcome instead of claiming the goal is complete.";

const GOAL_PAUSE_JUDGMENT =
  "A definitive missing permission or required human decision can justify an immediate goal pause with evidence and the change needed to resume. Work already in flight or a meaningful timed recheck calls for the available waiting mechanism, not a goal pause.";

const GOAL_TOOLS = [
  "goal_set",
  "goal_update",
  "goal_complete",
  "goal_pause",
  "goal_resume",
] as const satisfies readonly FirstPartyMcpToolName[];

/** The ownership paragraph, naming only goal tools not proven absent. */
function goalOwnership(context: AgentPromptContext): string {
  const has = (name: FirstPartyMcpToolName) => toolAvailable(context, name);
  if (GOAL_TOOLS.every(has)) return GOAL_OWNERSHIP;
  const complete = has("goal_complete");
  const pause = has("goal_pause");
  const until =
    complete && pause
      ? "keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale"
      : complete
        ? "keep working until you call opengeni__goal_complete with concrete evidence"
        : pause
          ? "keep working toward it, or call opengeni__goal_pause with a rationale"
          : "keep working toward it";
  const ownership = [
    `If the session has a goal, you own it: ${until}`,
    has("goal_update") && "revise it with opengeni__goal_update",
    has("goal_set") && "create one with opengeni__goal_set when given a long-running objective",
  ]
    .filter((part): part is string => typeof part === "string")
    .join("; ");
  return sentences(
    `${ownership}.`,
    has("goal_resume") &&
      "Resume a paused goal with opengeni__goal_resume when the user asks you to continue, regardless of who paused it, or when the blocker you paused for has cleared. A question alone is not such a request: answer it and leave the goal paused.",
  );
}

/**
 * The goal loop: owning, completing, pausing, and resuming a session goal.
 * Each clause naming a goal tool renders unless the attempt proved that tool
 * absent; goal ownership and the truthful completion rule always remain.
 */
export const goalsModule: AgentPromptModule = {
  id: "goals",
  applies: (context) => context.capabilities.goals,
  render: (context) => {
    const complete = toolAvailable(context, "goal_complete");
    return blocks(
      "# Goals",
      goalOwnership(context),
      complete && GOAL_COMPLETION_HANDOFF,
      complete ? GOAL_COMPLETION_CALL : GOAL_COMPLETION_UNAVAILABLE,
      toolAvailable(context, "goal_pause") && GOAL_PAUSE_JUDGMENT,
    );
  },
};
