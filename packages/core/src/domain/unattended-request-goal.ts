import type { GoalSpec, ResolvedAgentConfig } from "@opengeni/contracts";

/**
 * The goal Opengeni sets for a headless single request. It names the request
 * instead of copying it: the goal is shown with the first message and with
 * every continuation, so a copy would repeat the whole request in the model's
 * input.
 */
export const UNATTENDED_REQUEST_GOAL: Readonly<GoalSpec> = Object.freeze({
  text: "Complete the request in this session's first message.",
  successCriteria:
    "Everything that message asks for is done and checked where practical, and only steps that need a person are left undone.",
});

/**
 * The goal an API create gets when it gives none: a top-level session that
 * says no person answers (`unattended: true`) and carries its task as the
 * first message. Nobody can tell such a run to keep going, so the goal makes
 * the runtime continue it until the agent completes or pauses it explicitly,
 * as a goal the agent set itself would, without spending a model call on
 * setting it. Interactive sessions, children, Slack chats (a person replies
 * in the thread), scheduled and event-triggered runs (their task configures
 * its own goal), sessions without the goals capability, and a create that
 * passes `goal: null` get none. The text is fixed, so a keyed retry resolves
 * the same goal.
 */
export function unattendedRequestGoal(input: {
  unattended: boolean | undefined;
  goal: GoalSpec | null | undefined;
  initialMessage: string | undefined;
  hasParent: boolean;
  creator: string;
  agentConfig: Pick<ResolvedAgentConfig, "capabilities"> | null;
}): GoalSpec | undefined {
  if (input.unattended !== true || input.goal !== undefined || input.hasParent) return undefined;
  if (input.creator !== "api" || !input.initialMessage?.trim()) return undefined;
  if (input.agentConfig && !input.agentConfig.capabilities.goals) return undefined;
  return { ...UNATTENDED_REQUEST_GOAL };
}
