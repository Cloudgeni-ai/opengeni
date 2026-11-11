import { describe, expect, test } from "bun:test";
import { ChatPendingFold, ChatTurnFold } from "../src/chat/fold";
import type { SessionEvent } from "../src/types";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const TURN = "33333333-3333-4333-8333-333333333333";

function event(sequence: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    turnId: TURN,
    sequence,
    type,
    payload,
    occurredAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as SessionEvent;
}

const card = (origin?: string) =>
  event(1, "session.humanInput.requested", {
    request: {
      id: "44444444-4444-4444-8444-444444444444",
      questions: [
        {
          id: "secret-approval:55555555-5555-4555-8555-555555555555",
          kind: "single_select",
          prompt: "Allow the agent to use GitHub › password?",
          options: [
            { id: "once", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
          required: true,
          allowOther: false,
        },
      ],
      allowSkip: false,
      expiresAt: null,
      ...(origin ? { origin } : {}),
    },
  });

describe("Opengeni's secret approval cards in the chat fold", () => {
  test("the card shows without ending the turn, which keeps streaming", () => {
    const fold = new ChatTurnFold(WORKSPACE, SESSION, TURN);
    const step = fold.push(card("secret_use_approval"));
    expect(step.terminal).toBeNull();
    expect(step.chunks.map((chunk) => chunk.type)).toEqual(["pending"]);
    expect(fold.push(event(2, "turn.completed", {})).terminal).toBe("completed");
    expect(fold.reply("completed").pending).toBeNull();

    // An agent's own question still hands the turn to the person.
    expect(new ChatTurnFold(WORKSPACE, SESSION, TURN).push(card()).terminal).toBe("pending");
  });

  test("the card stays pending after its turn ends, until it is answered", () => {
    const pending = new ChatPendingFold();
    pending.push(card("secret_use_approval"));
    pending.push(event(2, "turn.completed", {}));
    expect(pending.pending().map((request) => request.requestId)).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
    pending.push(
      event(3, "user.humanInputResponse", { requestId: "44444444-4444-4444-8444-444444444444" }),
    );
    expect(pending.pending()).toEqual([]);

    const question = new ChatPendingFold();
    question.push(card());
    question.push(event(2, "turn.completed", {}));
    expect(question.pending()).toEqual([]);
  });
});
