import { blocks, type AgentPromptModule } from "../types";

/**
 * What an unattended session means for the agent. Shared with the legacy CORE,
 * which carries the same sentences, so both compositions say the same thing.
 * Interactive sessions never render it.
 */
export const UNATTENDED_SESSION_GUIDANCE =
  "This session is unattended: no person will see or answer a question until the task ends, so asking, or waiting for human input, ends the work unanswered. Where any guidance says to ask, settle open choices with the most conventional option and finish the reversible work inside the workspace. Do not take or stand in for a step only a person can take; leave it undone, with anything destructive, outside the workspace or needing authority you were not given. End with the result, the assumptions you made and the steps left for a person.";

export const unattendedModule: AgentPromptModule = {
  id: "unattended",
  applies: (context) => context.resources.unattended === true,
  render: () => blocks("# Unattended session", UNATTENDED_SESSION_GUIDANCE),
};
