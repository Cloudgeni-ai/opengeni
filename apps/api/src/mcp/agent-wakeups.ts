/**
 * OPE-550 experiment: agent-to-agent wakeups.
 *
 * Staging (2026-10-03..10) spent 44% of list cost on turns started by Agent
 * messages, a quarter of them no-ops: progress and FYI messages woke a parent
 * that only re-armed its wait, and agent-to-agent text degraded into run-together
 * shorthand. With `OPENGENI_EXPERIMENT_AGENT_WAKEUPS=1` (API environment,
 * default off) `session_send_message` accepts `wake: "deferred"` for messages the
 * recipient need not act on now, and its description asks for plain prose and
 * for progress only when it changes what the recipient would do. A deferred
 * message is an ordinary durable `agent_message` row with `payload.wake`; it
 * registers no wake and rides the recipient's next claim (see
 * `docs/durable-agent-inputs.md`). Off, the schema, description and receipt are
 * byte-identical to before.
 */
export const AGENT_WAKEUPS_EXPERIMENT_FLAG = "OPENGENI_EXPERIMENT_AGENT_WAKEUPS";

export function agentWakeupsExperimentEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[AGENT_WAKEUPS_EXPERIMENT_FLAG] === "1";
}

export const SESSION_SEND_MESSAGE_WAKE_FIELD_DESCRIPTION =
  "immediate (default) starts the recipient's next turn now. deferred stores the message and delivers it with the recipient's next turn, which its own wait deadline, another immediate input (such as your final result), or a human message starts; it does not end the recipient's wait_for_input or session_wait. Use deferred for progress, status and FYI the recipient does not have to act on now. Use immediate for a question that needs an answer, a blocker, a request to act, or a result the recipient is waiting for.";

/**
 * Prepended to the unchanged base description when the experiment is on, so the
 * existing delivery guidance stays word for word.
 */
export const SESSION_SEND_MESSAGE_AGENT_WAKEUPS_GUIDANCE =
  "Every message costs the recipient a model turn over its whole context, so send one only when it changes what the recipient would do: a question, a blocker, a request, a decision, or a result it needs. A child's final answer reaches its parent automatically when the child finishes, so do not also send it, and do not send repeated status such as still running, no change, or waiting. Set wake=deferred for progress or FYI that can wait for the recipient's next turn. Write the text as plain prose for a reader with no context: full sentences with normal spaces between words, lists one item per line, and no squeezed shorthand such as 'ALL49ok/API=45PASS2FAIL'; summarize instead of compressing.";

export function sessionSendMessageDescription(base: string, agentWakeups: boolean): string {
  return agentWakeups ? `${SESSION_SEND_MESSAGE_AGENT_WAKEUPS_GUIDANCE} ${base}` : base;
}
