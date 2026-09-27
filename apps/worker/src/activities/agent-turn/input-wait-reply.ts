/**
 * The reply `turn.completed` records when a turn ends through `wait_for_input`
 * (read back with `turnCompletedReply` in `@opengeni/contracts`).
 *
 * Such a turn settles with an empty `output`: the wait, not an answer, ended
 * it. When a human or API message started the turn, its latest assistant
 * message is still that message's answer, for example a status reply given
 * before waiting again on work in flight. That message shares its model
 * response with the wait call, so it streams as commentary, which is activity
 * everywhere else. Recording it lets unread attention and Slack treat it as the
 * answer without relabelling the provider's phase in stored history.
 * Turns that machine input started (goal continuations, child results,
 * schedules) only narrate progress and record nothing.
 */
export function inputWaitReply(input: {
  inputWaitYielded: boolean;
  turnSource: string | undefined;
  latestAssistantMessageText: string | null;
}): string | null {
  if (!input.inputWaitYielded) return null;
  if (input.turnSource !== "user" && input.turnSource !== "api") return null;
  const text = input.latestAssistantMessageText;
  return text !== null && text.trim().length > 0 ? text : null;
}
