/**
 * Conversation-first session history: which durable events are the steps of a
 * turn, and which tool results stay visible without opening those steps.
 * Dependency-free so browser packages can import it without the schema bundle.
 */
/**
 * The bulk of a long agent turn: tool calls, their outputs and streamed
 * reasoning or command output. Conversation-first history reads exclude these
 * and load a turn's steps only when a reader asks for them.
 */
export const SESSION_EVENT_STEP_TYPES = [
  "agent.toolCall.created",
  "agent.toolCall.output",
  "agent.reasoning.delta",
  "sandbox.command.output.delta",
  "terminal.pty.output.delta",
] as const;

/**
 * Tools whose result is primary output a reader sees without opening the
 * turn's steps: presented images and published files, Skill changes that may
 * need review, and learning writes whose refusal is told outside the folded
 * work row. Matched on the tool name's leaf (`x__leaf` or `leaf`).
 */
export const SESSION_EVENT_PRESENTED_TOOL_LEAVES = [
  "generate_image",
  "image_generation_call",
  "sandbox_file_publish",
  "skill_save",
  "skill_remove",
  "skill_install",
  "skill_publish",
  "instruction_policy_save",
  "knowledge_save",
] as const;

/** Whether a tool name is one of {@link SESSION_EVENT_PRESENTED_TOOL_LEAVES}. */
export function isPresentedSessionToolName(name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  return SESSION_EVENT_PRESENTED_TOOL_LEAVES.some(
    (leaf) => name === leaf || name.endsWith(`__${leaf}`),
  );
}
