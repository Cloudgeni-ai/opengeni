import { blocks, sentences, type AgentPromptModule } from "../types";

/** Session tools: reading history, managing sessions, delegating to children, and joining them. */
export const subagentsModule: AgentPromptModule = {
  id: "subagents",
  applies: (context) => context.capabilities.subagents,
  render: (context) => {
    const { goals, workspaceAdmin } = context.capabilities;
    return blocks(
      "# Session coordination",
      "Use `session_events` for conversation history: its default returns user and completed assistant messages, not execution noise. Cursors only paginate. Request `results` for final outcomes, `tools` for tool receipts, or `debug` for explicit diagnostics; request large tool bodies only when needed. Use the returned continuation cursor rather than rereading whole pages. Audit reads do not acknowledge command completion.",
      "If the user asks to create, inspect, continue, pause, resume, steer, rename, or otherwise manage a session, use the corresponding session tool. Pause affects the selected workstream and its descendants: pausing an ancestor also stops you, so you cannot then Resume yourself. Coordinate disjoint edits through messages instead of ancestor Pause.",
      sentences(
        "Create a child worker only for a concrete, bounded subtask that can run independently and whose result has a clear integration point in the current request.",
        "Delegation has setup and coordination overhead: by default, answer directly when the work takes only a few steps, and send a related follow-up to a child you already spawned with `session_send_message` instead of spawning another.",
        "Explicit user requests and applicable Skill guidance for delegation, independent review, or fresh workers override that default within existing authority.",
        "Before spawning, decide what output you need and keep the parent's concurrent work disjoint.",
        "Do not duplicate a child's implementation; independent review or comparison may intentionally examine the same subject with a distinct deliverable.",
        "If no useful independent work remains and no such delegation is requested, continue in this session.",
        workspaceAdmin &&
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
        "When a child needs minutes and nothing else can advance meanwhile, call `wait_for_input` right after spawning instead of alternating `session_wait` and `session_get`: the child's terminal result wakes you and carries its final answer in `payload.finalAnswer`.",
        "Use that answer directly; read the child's results with `session_events` only when `finalAnswer` is absent or truncated (`finalAnswer.nextAction` reads the complete answer) or when you need detail it lacks.",
        'To join a short child inside this turn, use `session_wait` with `waitFor: "completion"`; a later terminal result repeating an answer you already integrated needs no reread.',
        goals &&
          "A `goal.completed` event records goal state but is not a terminal child result; the child can still be composing its final output.",
        "Do not present delegated work as incorporated until you have consumed the completed result.",
        "If a child becomes unnecessary, pause it when authorized instead of letting unused work continue.",
      ),
      'For a short wait on a child or peer session inside the current turn, call `session_wait` with its session id and your last seen sequence instead of sleeping and polling; use `command_wait` for one short provider-neutral wait on a background command. Both time out after at most 50 seconds. Use `session_wait` with the default `waitFor: "change"` to observe relevant progress and `waitFor: "completion"` to join a child result without waking early on messages, goal/progress facts, maintenance turns, or continuation segment settlements. When it reports `ownPendingUpdates > 0`, finish this turn: that input is delivered when your next turn is claimed (or pass `includeOwnPendingUpdates: false` to keep waiting on the targets). Do not immediately repeat a timed-out short wait without new evidence; an unchanged `session_get` snapshot between waits is not new evidence. Keep internal continuation notes separate from the user-visible wait reason; write that reason as one short, readable sentence describing the dependency. For a long or uncertain wait, call `wait_for_input` once and end the turn rather than looping while holding the inference and sandbox.',
    );
  },
};
