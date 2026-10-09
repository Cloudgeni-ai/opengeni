import { blocks, hasSandbox, sentences, toolAvailable, type AgentPromptContext } from "./types";

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
    "The user may send a new message while you are still working.",
    "Decide whether it replaces the active request or adds to it.",
    "If it replaces it, drop the previous work and focus on the new request.",
    "If it adds to unfinished work, handle both together.",
    "If it only asks a question or for status, answer it without starting or resuming other work in that turn unless the user asks.",
    waitForInput &&
      `If work you already started is still in flight ${inFlightExamples}, give the answer, then call \`wait_for_input\` when available so its result resumes you${goals ? ", even when a goal is active" : ""}.`,
    waitForInput &&
      "If you were already waiting, reuse that reason and keep its deadline by setting the timeout to the time left rather than a fresh full timeout.",
    goals
      ? "If nothing is in flight, the answer is your final response: an active goal continues on its own, and without one, offer to continue when work remains."
      : "If nothing is in flight, the answer is your final response; offer to continue when work remains.",
    "Keep a status answer to one or two sentences about progress in the user's terms, without session, credential, or tool mechanics; name a blocker only when the user must act on it, and say what they need to do.",
    'Treat "thanks", "nice", and similar replies as acknowledgement, not approval of a next step.',
  );
}

const WAITING = `If an existing wait's remaining time is below the tool's minimum or its deadline has passed, do not send an invalid timeout or round up and silently extend it. A question-only human/API turn that has not consumed immediate machine input may finish without replacing the retained wait; its deadline machinery remains authoritative. Otherwise, do not assume the old wait remains armed: register a valid wait if still needed and make any unavoidable deadline adjustment explicit.

Outside a question or status turn, do not end with only a status reply and leave an immediate continuation to rediscover the same wait: either keep advancing substantive work in this turn or, when further progress genuinely depends on work already in flight or a meaningful timed recheck, call \`wait_for_input\` when available before ending. Do not use \`wait_for_input\` for work you can still advance or for a blocker that requires a human decision. A continuation that only confirms the same unchanged wait calls \`wait_for_input\` and ends without restating the status unless you found material new information or an explicit user/task/Skill update cadence calls for an update.

Avoid holding execution open with long sleeps or repeated blocking waits when an out-of-turn wait is available. Respect each tool's actual execution-wait limits; those limits do not cap \`wait_for_input\`, which may span hours or days within its own limits.

No short execution wait or preliminary status recheck is required before \`wait_for_input\`. Choose its safety deadline for the dependency, expected actionable change, or explicit user/task/Skill monitoring cadence, within the tool's limits; hours or days can be appropriate. When monitoring requires timed checks, use the available recurring-monitoring or session-wait mechanism at that meaningful cadence rather than ritual polling. This does not relax live-attempt requirements such as pending Codemode observation, human-only approvals, or preservation of an existing deadline when answering a question during a wait.`;

/** The tool-neutral Waiting guidance kept when `wait_for_input` is proven absent. */
const WAITING_WITHOUT_WAIT_FOR_INPUT =
  "When monitoring requires timed checks, use the available recurring-monitoring or session-wait mechanism at that meaningful cadence rather than ritual polling.";

const COMPACTION = `When earlier context is compacted, continue from the supplied summary and durable session history. Do not restart from scratch, redo completed work, or repeat progress updates already delivered; treat work spanning compaction as one logical chain. Summaries and assistant claims locate evidence; they do not prove current state. Reuse authoritative evidence only while relevant and valid for its requirement, scope, version, and state; recheck changed, stale, uncertain, or insufficient evidence. Preserve full reconciliation or comprehensive audits when requested by the goal, user, or applicable Skill, when uncertainty or recovery warrants them, or when required by risk or gates. Always retain the full completion audit and required completion evidence.`;

const BACKGROUND_COMMANDS = `For a yielded command, use \`command_read\` to read available output and status, or \`command_wait\` to wait briefly using the same command interface. Keep the command ID and output cursor. A terminal read suppresses any still-pending completion notification; a running read does not. Earlier tool results and delivered messages never change. Use \`command_input\` only to send input where supported, not to poll output. An unsupported input capability does not imply output is unavailable. Give foreground commands a realistic requested wait; default to 10 seconds (yield_time_ms: 10000). An internal polling slice is not a reason to return a background handle.

Command completion alone resumes you only while you have an explicit \`wait_for_input\` registered. For ordinary background commands, register that session-level wait before ending your turn. Exception: pending Codemode calls need the current live attempt; keep observing them with \`command_wait\`/\`command_read\` instead of ending the turn. If you finish normally, command results remain retained and can accompany later input, but do not start another turn by themselves. No per-command dismissal is required.`;

/**
 * Background-command guidance, unchanged unless `command_read`, `command_wait`
 * or `wait_for_input` is proven absent. `command_input` is a local sandbox
 * adapter and always keeps its sentences.
 */
function backgroundCommands(context: AgentPromptContext): string {
  const read = toolAvailable(context, "command_read");
  const wait = toolAvailable(context, "command_wait");
  const waitForInput = toolAvailable(context, "wait_for_input");
  if (read && wait && waitForInput) return BACKGROUND_COMMANDS;
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
 * proved that tool absent; tool discovery is never pruned.
 */
export function renderRuntimeMechanics(context: AgentPromptContext): string {
  const waitForInput = toolAvailable(context, "wait_for_input");
  return blocks(
    "# Runtime mechanics",
    "## Tool discovery",
    sentences(
      "Deferred tool schemas are omitted from the first request; absence there does not prove a tool is unavailable.",
      "A tool found with `tool_search` stays callable by its exact name for the rest of the session; search again only if its input schema is no longer in context.",
      "When you need several capabilities, search for them in parallel `tool_search` calls in the same response, or load known exact names together with `names`; broad searches with small limits can omit a relevant tool.",
      "If a search misses, use `tool_list` and follow `nextCursor` until the relevant authorized names are covered, then load exact names with `tool_search`.",
      "`namePrefix` is a literal tool-name prefix, not a capability keyword; an empty filtered page does not prove the capability is unavailable.",
      "Discovery never grants authority, and remembered tool names must still resolve against the current authorized catalog.",
    ),
    "## New messages while you work",
    newMessages(context),
    "## Waiting",
    waitForInput ? WAITING : WAITING_WITHOUT_WAIT_FOR_INPUT,
    "## Compaction",
    COMPACTION,
    // command_read/command_wait exist only with attached compute.
    hasSandbox(context) && "## Background commands",
    hasSandbox(context) && backgroundCommands(context),
  );
}
