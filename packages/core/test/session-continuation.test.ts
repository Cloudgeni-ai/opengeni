import { describe, expect, test } from "bun:test";
import {
  buildSessionContinuationContext,
  defaultSessionContinuationMessage,
  SESSION_CONTINUATION_CONTEXT_MAX_CHARS,
  type SessionContinuationMessage,
} from "../src/domain/session-continuation";

const source = {
  sourceSessionId: "11111111-1111-4111-8111-111111111111",
  sourceTitle: "Billing migration",
  sourceModel: "codex/gpt-6-astra",
};

describe("continuation context", () => {
  test("a short chat is copied whole, oldest first", () => {
    const context = buildSessionContinuationContext({
      ...source,
      messages: [
        { role: "user", text: "Plan the migration" },
        { role: "assistant", text: "Step one: add the table" },
      ],
    });
    expect(context).toContain(source.sourceSessionId);
    expect(context).toContain("codex/gpt-6-astra");
    expect(context.indexOf("[User]\nPlan the migration")).toBeLessThan(
      context.indexOf("[Assistant]\nStep one: add the table"),
    );
    expect(context).not.toMatch(/earlier messages? left out\]/);
  });

  test("a long chat keeps the first request and the latest messages within the bound", () => {
    const messages: SessionContinuationMessage[] = Array.from({ length: 200 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index} ${"x".repeat(900)}`,
    }));
    const context = buildSessionContinuationContext({ ...source, messages });
    expect(context.length).toBeLessThanOrEqual(SESSION_CONTINUATION_CONTEXT_MAX_CHARS);
    expect(context).toContain("message 0 ");
    expect(context).toContain("message 199 ");
    expect(context).not.toContain("message 1 ");
    expect(context).toMatch(/\[\d+ earlier messages left out\]/);
  });

  test("one huge message is shortened rather than crowding out the rest", () => {
    const context = buildSessionContinuationContext({
      ...source,
      messages: [
        { role: "user", text: `start ${"a".repeat(50_000)} end` },
        { role: "assistant", text: "latest answer" },
      ],
    });
    expect(context.length).toBeLessThanOrEqual(SESSION_CONTINUATION_CONTEXT_MAX_CHARS);
    expect(context).toContain("[…shortened…]");
    expect(context).toContain("latest answer");
  });

  test("an empty chat still explains where the new chat came from", () => {
    const context = buildSessionContinuationContext({ ...source, messages: [] });
    expect(context).toContain("no messages yet");
  });

  test("the visible first message links back to the earlier chat", () => {
    expect(
      defaultSessionContinuationMessage({
        sourceSessionId: source.sourceSessionId,
        sourceTitle: "Fix [prod] outage",
      }),
    ).toBe(
      `Continue from [Fix prod outage](session:${source.sourceSessionId}). Start with a short summary of where things stand.`,
    );
  });
});
