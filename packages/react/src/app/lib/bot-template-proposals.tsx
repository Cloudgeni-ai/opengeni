import type { SessionEvent } from "@opengeni/sdk";

/** Whether a tool output carried a template-update proposal, checked once per event object. */
const carriesProposal = new WeakMap<SessionEvent, boolean>();

/**
 * How many `bot_template_propose_update` proposals the loaded events carry: a
 * cheap trigger to read the chat's pending proposal again.
 */
export function botTemplateProposalReceiptCount(events: readonly SessionEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== "agent.toolCall.output") continue;
    let carries = carriesProposal.get(event);
    if (carries === undefined) {
      carries = JSON.stringify(event.payload ?? null).includes("bot_template_proposal");
      carriesProposal.set(event, carries);
    }
    if (carries) count += 1;
  }
  return count;
}
