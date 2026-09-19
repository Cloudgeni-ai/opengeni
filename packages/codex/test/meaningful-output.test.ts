import { describe, expect, test } from "bun:test";
import { hasMeaningfulCodexOutput } from "../src/meaningful-output";
import {
  codexRequestStorage,
  codexSubscriptionFetch,
  type CodexModelRequestEvent,
  type CodexRequestContext,
} from "../src";

const textOutput = {
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Useful progress" }],
};

describe("capacity recovery progress evidence", () => {
  test("empty, reasoning-only, incomplete and bookkeeping output are not progress", () => {
    for (const output of [
      null,
      [],
      [{}],
      [{ type: "reasoning", summary: [{ text: "thinking" }] }],
      [{ ...textOutput, status: "incomplete" }],
      [{ ...textOutput, content: [{ type: "output_text", text: "  " }] }],
    ]) {
      expect(hasMeaningfulCodexOutput(output)).toBe(false);
    }
    expect(hasMeaningfulCodexOutput([textOutput])).toBe(true);
    expect(
      hasMeaningfulCodexOutput([
        { type: "function_call", call_id: "call-1", name: "tool", arguments: "{}" },
      ]),
    ).toBe(true);
  });

  for (const stream of [true, false]) {
    test(`${stream ? "stream" : "JSON"} failed response cannot claim progress even after output`, async () => {
      const events: CodexModelRequestEvent[] = [];
      const context: CodexRequestContext = {
        clientVersion: "test",
        getToken: async () => ({ accessToken: "test", chatgptAccountId: null, isFedramp: false }),
        refresh: async () => ({ accessToken: "test", chatgptAccountId: null, isFedramp: false }),
        resolveModel: (slug) => slug,
        onModelRequestEvent: (event) => {
          events.push(event);
        },
      };
      const body = [
        { type: "response.output_item.done", item: textOutput },
        {
          type: "response.failed",
          response: {
            id: "failed",
            status: "failed",
            error: { code: "rate_limit_exceeded", message: "unavailable" },
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      const response = await codexRequestStorage.run(context, () =>
        codexSubscriptionFetch(
          async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
        )("https://chatgpt.com/backend-api/responses", {
          method: "POST",
          body: JSON.stringify({ stream }),
        }),
      );
      await response.text().catch(() => undefined);
      expect(events.some((event) => event.phase === "completed")).toBe(false);
      expect(events.some((event) => event.meaningfulOutput === true)).toBe(false);
    });
    for (const output of [[], [textOutput], [{ type: "reasoning", summary: [] }]]) {
      test(`${stream ? "stream" : "JSON"} terminal carries only substantive successful output evidence: ${JSON.stringify(output)}`, async () => {
        const events: CodexModelRequestEvent[] = [];
        const context: CodexRequestContext = {
          clientVersion: "test",
          getToken: async () => ({ accessToken: "test", chatgptAccountId: null, isFedramp: false }),
          refresh: async () => ({ accessToken: "test", chatgptAccountId: null, isFedramp: false }),
          resolveModel: (slug) => slug,
          onModelRequestEvent: (event) => {
            events.push(event);
          },
        };
        const body = [
          ...output.map((item) => ({ type: "response.output_item.done", item })),
          {
            type: "response.completed",
            response: { id: "response-1", status: "completed", output: [] },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("");
        const response = await codexRequestStorage.run(context, () =>
          codexSubscriptionFetch(
            async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
          )("https://chatgpt.com/backend-api/responses", {
            method: "POST",
            body: JSON.stringify({ stream }),
          }),
        );
        await response.text();
        const completed = events.filter((event) => event.phase === "completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.meaningfulOutput).toBe(output[0] === textOutput);
      });
    }
  }
});
