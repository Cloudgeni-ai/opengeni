import {
  blocks,
  hasSandbox,
  sentences,
  toolAvailable,
  toolsAvailable,
  type AgentPromptContext,
  type AgentPromptModule,
} from "../types";

const SHORT_WAIT_TAIL =
  'Use `session_wait` with the default `waitFor: "change"` to observe relevant progress and `waitFor: "completion"` to join a child result without waking early on messages, goal/progress facts, maintenance turns, or continuation segment settlements. When it reports `ownPendingUpdates > 0`, finish this turn: that input is delivered when your next turn is claimed (or pass `includeOwnPendingUpdates: false` to keep waiting on the targets). Do not immediately repeat a timed-out short wait without new evidence; an unchanged `session_get` snapshot between waits is not new evidence. Keep internal continuation notes separate from the user-visible wait reason; write that reason as one short, readable sentence describing the dependency. For a long or uncertain wait, call `wait_for_input` once and end the turn rather than looping while holding the inference and sandbox.';

/** The short-wait paragraph, unchanged unless one of its tools is proven absent. */
function shortWaits(context: AgentPromptContext): string {
  const sandbox = hasSandbox(context);
  const sessionWait = toolAvailable(context, "session_wait");
  const sessionGet = toolAvailable(context, "session_get");
  const commandWait = sandbox && toolAvailable(context, "command_wait");
  const waitForInput = toolAvailable(context, "wait_for_input");
  if (sessionWait && sessionGet && waitForInput && (!sandbox || commandWait)) {
    return (
      (sandbox
        ? "For a short wait on a child or peer session inside the current turn, call `session_wait` with its session id and your last seen sequence instead of sleeping and polling; use `command_wait` for one short provider-neutral wait on a background command. Both time out after at most 50 seconds. "
        : "For a short wait on a child or peer session inside the current turn, call `session_wait` with its session id and your last seen sequence instead of sleeping and polling. It times out after at most 50 seconds. ") +
      SHORT_WAIT_TAIL
    );
  }
  return sentences(
    sessionWait && commandWait
      ? "For a short wait on a child or peer session inside the current turn, call `session_wait` with its session id and your last seen sequence instead of sleeping and polling; use `command_wait` for one short provider-neutral wait on a background command. Both time out after at most 50 seconds."
      : sessionWait
        ? "For a short wait on a child or peer session inside the current turn, call `session_wait` with its session id and your last seen sequence instead of sleeping and polling. It times out after at most 50 seconds."
        : commandWait
          ? "Use `command_wait` for one short provider-neutral wait on a background command. It times out after at most 50 seconds."
          : undefined,
    sessionWait &&
      'Use `session_wait` with the default `waitFor: "change"` to observe relevant progress and `waitFor: "completion"` to join a child result without waking early on messages, goal/progress facts, maintenance turns, or continuation segment settlements.',
    sessionWait &&
      "When it reports `ownPendingUpdates > 0`, finish this turn: that input is delivered when your next turn is claimed (or pass `includeOwnPendingUpdates: false` to keep waiting on the targets).",
    (sessionWait || commandWait) &&
      (sessionGet
        ? "Do not immediately repeat a timed-out short wait without new evidence; an unchanged `session_get` snapshot between waits is not new evidence."
        : "Do not immediately repeat a timed-out short wait without new evidence."),
    waitForInput &&
      "Keep internal continuation notes separate from the user-visible wait reason; write that reason as one short, readable sentence describing the dependency.",
    waitForInput &&
      "For a long or uncertain wait, call `wait_for_input` once and end the turn rather than looping while holding the inference and sandbox.",
  );
}

/**
 * Session tools: reading history, managing sessions, delegating to children,
 * and joining them. A clause naming a session tool renders unless the attempt
 * proved that tool absent; delegation judgment and integration rules remain.
 */
export const subagentsModule: AgentPromptModule = {
  id: "subagents",
  applies: (context) => context.capabilities.subagents,
  render: (context) => {
    const { goals, workspaceAdmin } = context.capabilities;
    const sessionEvents = toolAvailable(context, "session_events");
    const waitForInput = toolAvailable(context, "wait_for_input");
    const pollingTools = toolsAvailable(context, ["session_wait", "session_get"]);
    return blocks(
      "# Session coordination",
      "When you are a child session, your final answer is delivered automatically to your parent session. Send a separate message when the parent needs information before you finish, or when you need to message another session.",
      sessionEvents &&
        "Use `session_events` for conversation history: its default returns user and completed assistant messages, not execution noise. Cursors only paginate. Request `results` for final outcomes, `tools` for tool receipts, or `debug` for explicit diagnostics; request large tool bodies only when needed. Use the returned continuation cursor rather than rereading whole pages. Audit reads do not acknowledge command completion.",
      "If the user asks to create, inspect, continue, pause, resume, steer, rename, or otherwise manage a session, use the corresponding session tool. Pause affects the selected workstream and its descendants: pausing an ancestor also stops you, so you cannot then Resume yourself. Coordinate disjoint edits through messages instead of ancestor Pause.",
      toolsAvailable(context, ["session_target_get", "session_target_set"]) &&
        "For a conversation about another session, use session_target_get/set to remember or clear the selected target; selection is context, not permission to mutate. Discover with sessions_list and inspect with session_events; keep voice in this session. Send only when asked, and use Steer only for an explicit change of direction.",
      toolAvailable(context, "session_message_status") &&
        "After Send or Steer, use session_message_status with the returned update ID to follow its exact consuming turn and read the indicated result before relaying it. Do not resend pending work or mistake acceptance for completion.",
      sentences(
        "Create a child worker only for a concrete, bounded subtask that can run independently and whose result has a clear integration point in the current request.",
        toolAvailable(context, "session_send_message")
          ? "Delegation has setup and coordination overhead: by default, answer directly when the work takes only a few steps, and send a related follow-up to a child you already spawned with `session_send_message` instead of spawning another."
          : "Delegation has setup and coordination overhead: by default, answer directly when the work takes only a few steps.",
        "Explicit user requests and applicable Skill guidance for delegation, independent review, or fresh workers override that default within existing authority.",
        "Before spawning, decide what output you need and keep the parent's concurrent work disjoint.",
        "Do not duplicate a child's implementation; independent review or comparison may intentionally examine the same subject with a distinct deliverable.",
        "If no useful independent work remains and no such delegation is requested, continue in this session.",
        workspaceAdmin &&
          toolsAvailable(context, ["variable_set_list", "session_create"]) &&
          "A session cannot gain a Variable Set while it works, so when even a short step needs one from `variable_set_list` that this session lacks and the request calls for it, run that step in a child created with those `variableSetIds` instead of asking the user to attach it.",
        "Do not repurpose or direct an unrelated existing session unless the user explicitly asks.",
        "If no matching session tool is available on this turn, handle what you can in this session and report any required delegation that is unavailable instead of inventing an API.",
      ),
      "When supervising work, an accepted message, queued status, or changing timestamp is not proof of execution. Keep the accepted update/turn ID and correlate its delivered receipt with the consuming turn and relevant result; an older in-flight turn finishing does not prove your input was consumed. Use the receipt correlation described by the sending tool. Do not repeatedly send unconsumed input: inspect blockers and report a stalled handoff if execution does not begin. Preserve explicit human pauses and approvals.",
      sentences(
        "After spawning, keep each child id and event cursor.",
        goals
          ? "Before committing, publishing, completing a goal, or giving a final answer that depends on a child, consume and integrate that child's completed result."
          : "Before committing, publishing, or giving a final answer that depends on a child, consume and integrate that child's completed result.",
        waitForInput &&
          (pollingTools
            ? "When a child needs minutes and nothing else can advance meanwhile, call `wait_for_input` right after spawning instead of alternating `session_wait` and `session_get`: the child's terminal result wakes you and carries its final answer in `payload.finalAnswer`."
            : "When a child needs minutes and nothing else can advance meanwhile, call `wait_for_input` right after spawning: the child's terminal result wakes you and carries its final answer in `payload.finalAnswer`."),
        waitForInput &&
          (sessionEvents
            ? "Use that answer directly; read the child's results with `session_events` only when `finalAnswer` is absent or truncated (`finalAnswer.nextAction` reads the complete answer) or when you need detail it lacks."
            : "Use that answer directly."),
        toolAvailable(context, "session_wait") &&
          'To join a short child inside this turn, use `session_wait` with `waitFor: "completion"`; a later terminal result repeating an answer you already integrated needs no reread.',
        goals &&
          "A `goal.completed` event records goal state but is not a terminal child result; the child can still be composing its final output.",
        "Do not present delegated work as incorporated until you have consumed the completed result.",
        "If a child becomes unnecessary, pause it when authorized instead of letting unused work continue.",
      ),
      shortWaits(context),
    );
  },
};
