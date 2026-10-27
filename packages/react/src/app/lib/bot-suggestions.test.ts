import { describe, expect, test } from "bun:test";
import type { SessionBotSuggestion, SessionEvent } from "@opengeni/sdk";

import { currentBotSuggestion, latestStreamedBotSuggestion } from "./bot-suggestions";

const kept: SessionBotSuggestion = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "create",
  sessionId: null,
  templateId: null,
  name: "Invoice checker",
  description: "Checks invoices",
  avatar: { kind: "emoji", emoji: "🧾", hue: 60 },
  setupInstructions: "Check each invoice.",
  reason: "Three checks so far.",
  createdAt: "2026-10-27T10:00:00.000Z",
};

function toolOutput(output: unknown, id = crypto.randomUUID()): SessionEvent {
  return {
    id,
    type: "agent.toolCall.output",
    payload: { id: "call_1", output },
  } as unknown as SessionEvent;
}

describe("bot suggestions", () => {
  test("reads the receipt from an MCP tool output", () => {
    const receipt = {
      type: "bot_suggestion",
      status: "suggested",
      ...kept,
      id: "22222222-2222-4222-8222-222222222222",
      kind: "reuse",
      sessionId: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-10-27T11:00:00.000Z",
    };
    const events = [
      toolOutput({ content: [{ type: "text", text: JSON.stringify(receipt) }], isError: false }),
      toolOutput({ content: [{ type: "text", text: "unrelated" }] }),
    ];
    expect(latestStreamedBotSuggestion(events)).toMatchObject({
      id: receipt.id,
      kind: "reuse",
      sessionId: receipt.sessionId,
      name: "Invoice checker",
    });
    // The newer of the streamed receipt and the kept copy wins.
    expect(currentBotSuggestion({ botSuggestion: kept }, events)?.id).toBe(receipt.id);
    expect(
      currentBotSuggestion(
        { botSuggestion: { ...kept, createdAt: "2026-10-27T12:00:00.000Z" } },
        events,
      )?.id,
    ).toBe(kept.id);
  });

  test("ignores declined calls and errors, and falls back to the kept copy", () => {
    const declined = { type: "bot_suggestion", status: "not_suggested", code: "name_taken" };
    const errored = { isError: true, content: [{ type: "text", text: JSON.stringify(kept) }] };
    const events = [toolOutput(JSON.stringify(declined)), toolOutput(errored)];
    expect(latestStreamedBotSuggestion(events)).toBeNull();
    expect(currentBotSuggestion({ botSuggestion: kept }, events)?.id).toBe(kept.id);
    expect(currentBotSuggestion({}, events)).toBeNull();
  });
});
