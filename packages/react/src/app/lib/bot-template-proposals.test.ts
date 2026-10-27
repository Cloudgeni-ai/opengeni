import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";

import { botTemplateProposalReceiptCount } from "./bot-template-proposals";

function output(value: unknown): SessionEvent {
  return {
    id: crypto.randomUUID(),
    type: "agent.toolCall.output",
    payload: { id: "call_1", output: value },
  } as unknown as SessionEvent;
}

describe("bot template proposal receipts", () => {
  test("counts proposal receipts, in text or structured output", () => {
    const receipt = { type: "bot_template_proposal", status: "proposed" };
    const events = [
      output({ content: [{ type: "text", text: JSON.stringify(receipt) }] }),
      output({ structuredContent: receipt }),
      output({ content: [{ type: "text", text: '{"status":"current"}' }] }),
      { id: "x", type: "agent.message.completed", payload: { text: "bot_template_proposal" } },
    ] as SessionEvent[];
    expect(botTemplateProposalReceiptCount(events)).toBe(2);
    // The same event objects are read once and keep their answer.
    expect(botTemplateProposalReceiptCount(events)).toBe(2);
  });
});
