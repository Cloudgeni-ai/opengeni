import { describe, expect, test } from "bun:test";
import type { SessionAgentSuggestion, SessionEvent } from "@opengeni/sdk";

import { currentAgentSuggestion, latestStreamedAgentSuggestion } from "./agent-suggestions";

const kept: SessionAgentSuggestion = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "create",
  agentId: null,
  name: "Invoice checker",
  description: "Checks invoices",
  avatar: { kind: "emoji", emoji: "🧾", hue: 60 },
  instructions: "Check each invoice.",
  firstMessage: null,
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

describe("agent suggestions", () => {
  test("reads the receipt from an MCP tool output", () => {
    const receipt = {
      type: "agent_suggestion",
      status: "suggested",
      ...kept,
      id: "22222222-2222-4222-8222-222222222222",
      kind: "reuse",
      agentId: "33333333-3333-4333-8333-333333333333",
      instructions: null,
      createdAt: "2026-10-27T11:00:00.000Z",
    };
    const events = [
      toolOutput({ content: [{ type: "text", text: JSON.stringify(receipt) }], isError: false }),
      toolOutput({ content: [{ type: "text", text: "unrelated" }] }),
    ];
    expect(latestStreamedAgentSuggestion(events)).toMatchObject({
      id: receipt.id,
      kind: "reuse",
      agentId: receipt.agentId,
      name: "Invoice checker",
    });
    // The newer of the streamed receipt and the kept copy wins.
    expect(currentAgentSuggestion({ agentSuggestion: kept }, events)?.id).toBe(receipt.id);
    expect(
      currentAgentSuggestion(
        { agentSuggestion: { ...kept, createdAt: "2026-10-27T12:00:00.000Z" } },
        events,
      )?.id,
    ).toBe(kept.id);
  });

  test("ignores declined calls, errors and a reuse without its agent", () => {
    const declined = { type: "agent_suggestion", status: "not_suggested", code: "name_taken" };
    const errored = { isError: true, content: [{ type: "text", text: JSON.stringify(kept) }] };
    const noAgent = { type: "agent_suggestion", status: "suggested", ...kept, kind: "reuse" };
    const events = [toolOutput(JSON.stringify(declined)), toolOutput(errored), toolOutput(noAgent)];
    expect(latestStreamedAgentSuggestion(events)).toBeNull();
    expect(currentAgentSuggestion({ agentSuggestion: kept }, events)?.id).toBe(kept.id);
    expect(currentAgentSuggestion({}, events)).toBeNull();
  });
});
