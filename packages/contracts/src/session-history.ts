/**
 * Conversation-first session history: which durable events are the steps of a
 * turn, and which tool results stay visible without opening those steps.
 * Dependency-free so browser packages can import it without the schema bundle.
 */
/**
 * The bulk of a long agent turn: tool calls, their outputs and streamed
 * reasoning or command output. A turn whose window skips any of these has
 * steps a reader can open.
 */
export const SESSION_EVENT_CONTENT_STEP_TYPES = [
  "agent.toolCall.created",
  "agent.toolCall.output",
  "agent.reasoning.delta",
  "sandbox.command.output.delta",
  "terminal.pty.output.delta",
] as const;

/**
 * Turn bookkeeping that renders nothing in the conversation: a turn writes a
 * few `agent.model.request` rows and an `agent.model.usage` row per model
 * call. Only a turn's request rows up to its first model response draw
 * anything (the "first model response" startup phase); a conversation-filter
 * server keeps those, and every bookkeeping row of a turn without other
 * steps, so it never looks like it has steps to open.
 */
export const SESSION_EVENT_BOOKKEEPING_STEP_TYPES = [
  "agent.model.request",
  "agent.model.usage",
] as const;

/**
 * Everything conversation-first history reads exclude and load per turn, only
 * when a reader asks for that turn's steps.
 */
export const SESSION_EVENT_STEP_TYPES = [
  ...SESSION_EVENT_CONTENT_STEP_TYPES,
  ...SESSION_EVENT_BOOKKEEPING_STEP_TYPES,
] as const;

/**
 * The conversation-filter behavior a server applies to a read that sends
 * `presentedToolCalls=include`, announced in the `X-OpenGeni-Conversation-Filter`
 * response header. Version 2 keeps presented tool calls and the bookkeeping
 * rows described by {@link SESSION_EVENT_BOOKKEEPING_STEP_TYPES}; excluded
 * turnless output (PTY and command output) stays out, for the sandbox dock to
 * read itself. A server without the header may ignore `presentedToolCalls`
 * entirely.
 */
export const SESSION_EVENT_CONVERSATION_FILTER_VERSION = 2;
export const SESSION_EVENT_CONVERSATION_FILTER_HEADER = "X-OpenGeni-Conversation-Filter";

/**
 * What a reader excludes from a conversation read when the server has not
 * announced {@link SESSION_EVENT_CONVERSATION_FILTER_VERSION}: tool calls stay
 * in (an older server would otherwise drop presented calls with them) and the
 * reader drops the ones that are not presented.
 */
export const SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES = [
  "agent.toolCall.output",
  "agent.reasoning.delta",
  "sandbox.command.output.delta",
  "terminal.pty.output.delta",
] as const;

/**
 * Whether an `agent.model.request` phase is the model's first response. A
 * turn's request rows after its first response no longer change what the
 * conversation draws.
 */
export function isSessionModelResponsePhase(phase: unknown): boolean {
  return phase === "first_byte" || phase === "first_event";
}

/**
 * Tools whose result is primary output a reader sees without opening the
 * turn's steps: presented images and published files, Skill changes that may
 * need review, learning writes whose refusal is told outside the folded work
 * row, and worker spawns or messages that a turn's wait counts. Matched on the
 * tool name's leaf (`x__leaf` or `leaf`).
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
  "knowledge_retain_file",
  "knowledge_retain_message",
  "knowledge_archive",
  "task_note_promote_knowledge",
  "remember_confirm",
  "session_create",
  "session_send_message",
] as const;

/** Whether a tool name is one of {@link SESSION_EVENT_PRESENTED_TOOL_LEAVES}. */
export function isPresentedSessionToolName(name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  return SESSION_EVENT_PRESENTED_TOOL_LEAVES.some(
    (leaf) => name === leaf || name.endsWith(`__${leaf}`),
  );
}
