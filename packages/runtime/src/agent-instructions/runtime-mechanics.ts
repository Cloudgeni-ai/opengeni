import {
  blocks,
  hasSandbox,
  sentences,
  toolAvailable,
  toolSearchAvailable,
  type AgentPromptContext,
} from "./types";

function newMessages(context: AgentPromptContext): string {
  const { goals, subagents } = context.capabilities;
  const commands = hasSandbox(context);
  const waitForInput = toolAvailable(context, "wait_for_input");
  const inFlightExamples =
    subagents && commands
      ? "(a child, a command, or a timed recheck)"
      : subagents
        ? "(a child or a timed recheck)"
        : commands
          ? "(a command or a timed recheck)"
          : "(a timed recheck)";
  return sentences(
    "The user can send a new message while you work.",
    "Decide whether it replaces or adds to the active request.",
    "If it replaces the request, drop the previous work and do the new request.",
    "If it adds to unfinished work, do both.",
    "If it only asks a question or for status, answer it.",
    "Do not start or resume other work in that turn unless the user asks.",
    waitForInput &&
      `If work you started is still in flight ${inFlightExamples}, call \`wait_for_input\` with the answer in its \`reply\`${goals ? ", even when a goal is active" : ""}. Then the result of that work resumes you.`,
    goals
      ? "If nothing is in flight, the answer is your final response. An active goal continues on its own; without a goal, offer to continue when work remains."
      : "If nothing is in flight, the answer is your final response; offer to continue when work remains.",
    "Keep a status answer to one or two sentences about progress, in the user's terms.",
    "Leave out session, credential and tool mechanics.",
    "Name a blocker only when the user must act on it, and say what they must do.",
    'Treat "thanks", "nice" and similar replies as acknowledgement, not approval of a next step.',
  );
}

/**
 * When to end a turn on a wait. How the wait itself behaves (when to call it,
 * `reply`, the deadline, what wakes it) is stated once, in the
 * `wait_for_input` tool description, so it is not repeated here.
 */
const WAITING =
  "Outside a question or status turn, do not end with only a status reply that leaves the next continuation to rediscover the same wait. Either keep advancing substantive work in this turn, or call `wait_for_input` before you end when progress depends on work already in flight or a meaningful timed recheck. When a continuation only confirms the same unchanged wait, call `wait_for_input` and end. Do not restate the status unless you found material new information or an explicit user, task or Skill cadence requires an update.";

/** Names automations and session waits, so it renders only where one exists. */
const WAITING_MONITORING =
  "When monitoring needs timed checks, use the available recurring-monitoring or session-wait mechanism at a meaningful cadence. Do not poll by ritual.";

const COMPACTION = `When earlier context is compacted, continue from the summary and the durable session history. Do not restart, redo completed work or repeat progress updates you already delivered. Treat work across compaction as one chain. Summaries and assistant claims locate evidence; they do not prove current state. Reuse authoritative evidence only while it is relevant and valid for its requirement, scope, version and state. Recheck evidence that is changed, stale, uncertain or insufficient. Keep full reconciliation or comprehensive audits when the goal, the user or an applicable Skill requests them, when uncertainty or recovery warrants them, or when risk or gates require them.`;

/** The goal completion audit survives compaction; rendered only with goals. */
const COMPACTION_GOAL_AUDITS =
  "Always retain the full completion audit and required completion evidence.";

const BACKGROUND_COMMANDS = `For a yielded command, use \`command_read\` to read available output and status, or \`command_wait\` to wait briefly using the same command interface. Keep the command ID and output cursor. A terminal read suppresses any still-pending completion notification; a running read does not. Earlier tool results and delivered messages never change. Use \`command_input\` only to send input where supported, not to poll output. An unsupported input capability does not imply output is unavailable. Give foreground commands a realistic requested wait; default to 10 seconds (yield_time_ms: 10000). An internal polling slice is not a reason to return a background handle.

Command completion alone resumes you only while you have an explicit \`wait_for_input\` registered. For ordinary background commands, register that session-level wait before ending your turn. Exception: pending Codemode calls need the current live attempt; keep observing them with \`command_wait\`/\`command_read\` instead of ending the turn. If you finish normally, command results remain retained and can accompany later input, but do not start another turn by themselves. No per-command dismissal is required.`;

/** Rendered only when the runtime delivers finished commands on its own. */
const COMMAND_COMPLETION_DELIVERY =
  "A command that finishes while you work reports its exit status and output on its own, after a later tool result or as input, so do not poll only to learn that it finished.";

/** Anchor the delivery sentence follows in the full-availability text. */
const TERMINAL_READ_SENTENCE =
  "A terminal read suppresses any still-pending completion notification; a running read does not.";

/**
 * Background-command guidance, unchanged unless `command_read`, `command_wait`
 * or `wait_for_input` is proven absent, plus one sentence when finished
 * commands are delivered on their own. `command_input` is a local sandbox
 * adapter and always keeps its sentences.
 */
function backgroundCommands(context: AgentPromptContext): string {
  const read = toolAvailable(context, "command_read");
  const wait = toolAvailable(context, "command_wait");
  const waitForInput = toolAvailable(context, "wait_for_input");
  const delivery = context.resources.commandCompletionDelivery === true;
  if (read && wait && waitForInput) {
    return delivery
      ? BACKGROUND_COMMANDS.replace(
          TERMINAL_READ_SENTENCE,
          `${TERMINAL_READ_SENTENCE} ${COMMAND_COMPLETION_DELIVERY}`,
        )
      : BACKGROUND_COMMANDS;
  }
  const observe =
    read && wait ? "`command_wait`/`command_read`" : read ? "`command_read`" : "`command_wait`";
  return blocks(
    sentences(
      read && wait
        ? "For a yielded command, use `command_read` to read available output and status, or `command_wait` to wait briefly using the same command interface."
        : read
          ? "For a yielded command, use `command_read` to read available output and status."
          : wait
            ? "For a yielded command, use `command_wait` to wait briefly for available output and status."
            : undefined,
      (read || wait) && "Keep the command ID and output cursor.",
      (read || wait) &&
        "A terminal read suppresses any still-pending completion notification; a running read does not.",
      delivery && COMMAND_COMPLETION_DELIVERY,
      "Earlier tool results and delivered messages never change.",
      "Use `command_input` only to send input where supported, not to poll output.",
      "An unsupported input capability does not imply output is unavailable.",
      "Give foreground commands a realistic requested wait; default to 10 seconds (yield_time_ms: 10000).",
      "An internal polling slice is not a reason to return a background handle.",
    ),
    sentences(
      waitForInput &&
        "Command completion alone resumes you only while you have an explicit `wait_for_input` registered.",
      waitForInput &&
        "For ordinary background commands, register that session-level wait before ending your turn.",
      (read || wait) &&
        `${waitForInput ? "Exception: pending" : "Pending"} Codemode calls need the current live attempt; keep observing them with ${observe} instead of ending the turn.`,
      "If you finish normally, command results remain retained and can accompany later input, but do not start another turn by themselves.",
      "No per-command dismissal is required.",
    ),
  );
}

/**
 * Always on: how the durable runtime behaves for every agent — messages that
 * arrive mid-turn, `wait_for_input`, compaction, and, when a sandbox or
 * Connected Machine is attached, background commands. Embedder instructions do
 * not override these. Clauses naming a first-party runtime tool
 * (`wait_for_input`, `command_read`, `command_wait`) drop only when the attempt
 * proved that tool absent. Tool discovery renders unless the attempt proved it
 * attaches nothing deferred (`toolSearchAbsent`), in which case it has no
 * search router; the router decision is made from the same frozen facts.
 */
export function renderRuntimeMechanics(context: AgentPromptContext): string {
  const waitForInput = toolAvailable(context, "wait_for_input");
  const toolSearch = toolSearchAvailable(context);
  const monitoring =
    (context.capabilities.schedules || context.capabilities.subagents) && WAITING_MONITORING;
  const waiting = waitForInput ? sentences(WAITING, monitoring) : monitoring;
  return blocks(
    "# Runtime mechanics",
    toolSearch && "## Tool discovery",
    toolSearch &&
      sentences(
        "Deferred tool schemas are omitted from the first request; absence there does not prove a tool is unavailable.",
        "Describe the action, resource and useful context in `tool_search`; it loads the strongest match, with optional decision-model selection for ambiguous searches. Check the match: ranking is not certainty. Native search returns loaded function definitions directly. In ordinary search receipts, `schemasLoaded: true` means `tools` have loaded schemas but `suggestions` are unloaded alternatives; with `schemasLoaded: false`, load chosen exact names with `tool_search({query: '', names: [...]})` before calling them. Known exact names bypass ranking and inference. Once its schema is in context, call the tool by name or through `tool_invoke` where available; do not rediscover it unless its schema is no longer in context.",
        "When you need several capabilities, search for them in parallel `tool_search` calls in the same response, or load known exact names together with `names`; broad searches with small limits can omit a relevant tool.",
        "Use `tool_list({view: 'groups'})` for a compact directory, then list an exact returned `group`. If search misses, browse the relevant groups and follow `nextCursor` until covered, then load chosen exact names with `tool_search`.",
        "`namePrefix` is a literal tool-name prefix, not a capability keyword; an empty filtered page does not prove the capability is unavailable.",
        "Discovery never grants authority, and remembered tool names must still resolve against the current authorized catalog.",
      ),
    "## New messages while you work",
    newMessages(context),
    waiting && "## Waiting",
    waiting,
    "## Compaction",
    context.capabilities.goals ? `${COMPACTION} ${COMPACTION_GOAL_AUDITS}` : COMPACTION,
    // command_read/command_wait exist only with attached compute.
    hasSandbox(context) && "## Background commands",
    hasSandbox(context) && backgroundCommands(context),
  );
}
