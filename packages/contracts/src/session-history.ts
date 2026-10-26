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

/** The tool leaf a session runs the app's own actions through. */
export const SESSION_EVENT_APP_ACTION_CALL_LEAF = "admin_action_call";

/** The page an app action opens: buying credits, starting a subscription, or the billing portal. */
export type PresentedAppActionPage = "credits" | "subscription" | "portal";

/**
 * App actions whose call is primary output too: each opens a payment page,
 * and the chat shows it as a button that later confirms the payment, which a
 * person returning to the chat (often in a reloaded tab) needs to see.
 * Keyed by action id, with the "METHOD /path" a call may name it by instead
 * (as `findAppAction` accepts) and the page it opens.
 */
export const SESSION_EVENT_PRESENTED_APP_ACTIONS = {
  createBillingCheckout: { route: "POST /v1/billing/checkout", page: "credits" },
  createSubscriptionCheckout: {
    route: "POST /v1/billing/subscription/checkout",
    page: "subscription",
  },
  createBillingPortalSession: { route: "POST /v1/billing/portal", page: "portal" },
  createSubscriptionPortalSession: {
    route: "POST /v1/billing/subscription/portal",
    page: "portal",
  },
} as const satisfies Record<string, { route: string; page: PresentedAppActionPage }>;

export type PresentedAppActionId = keyof typeof SESSION_EVENT_PRESENTED_APP_ACTIONS;

/**
 * The whitespace a call's action id is trimmed of before it's matched: exactly
 * what `String.prototype.trim` removes, as the action runner trims the id
 * (`findAppAction`), spelled out so the history query (Postgres `btrim`) and
 * every client agree.
 */
export const SESSION_EVENT_APP_ACTION_ID_SPACE =
  " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Every name that calls one of {@link SESSION_EVENT_PRESENTED_APP_ACTIONS}: each id and its "METHOD /path". */
export const SESSION_EVENT_PRESENTED_APP_ACTION_NAMES: readonly string[] = Object.entries(
  SESSION_EVENT_PRESENTED_APP_ACTIONS,
).flatMap(([id, { route }]) => [id, route]);

const PRESENTED_APP_ACTION_BY_NAME: ReadonlyMap<string, PresentedAppActionId> = new Map(
  Object.entries(SESSION_EVENT_PRESENTED_APP_ACTIONS).flatMap(([id, { route }]) => [
    [id, id as PresentedAppActionId],
    [route, id as PresentedAppActionId],
  ]),
);

function trimActionId(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && SESSION_EVENT_APP_ACTION_ID_SPACE.includes(value[start]!)) start += 1;
  while (end > start && SESSION_EVENT_APP_ACTION_ID_SPACE.includes(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

/**
 * Which of {@link SESSION_EVENT_PRESENTED_APP_ACTIONS} an app action call's
 * `id` names, by its id or its "METHOD /path"; undefined for anything else.
 */
export function presentedAppActionId(id: unknown): PresentedAppActionId | undefined {
  return typeof id === "string" ? PRESENTED_APP_ACTION_BY_NAME.get(trimActionId(id)) : undefined;
}

/**
 * Whether a tool call's result is primary output: a presented tool
 * ({@link isPresentedSessionToolName}), or an app action call that runs one of
 * {@link SESSION_EVENT_PRESENTED_APP_ACTIONS} (its arguments' top-level `id`,
 * see {@link presentedAppActionId}). Takes the `agent.toolCall.created`
 * payload (its `name` and `arguments`, an object or JSON text).
 */
export function isPresentedSessionToolCall(call: unknown): boolean {
  if (!call || typeof call !== "object") return false;
  const { name, arguments: args } = call as { name?: unknown; arguments?: unknown };
  if (isPresentedSessionToolName(name)) return true;
  const leaf = SESSION_EVENT_APP_ACTION_CALL_LEAF;
  if (typeof name !== "string" || (name !== leaf && !name.endsWith(`__${leaf}`))) return false;
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return presentedAppActionId((parsed as { id?: unknown }).id) !== undefined;
}
