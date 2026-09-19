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
  for (const cleanup of ["cancel", "abort", "idle_timeout", "whole_timeout"] as const) {
    for (const meaningful of [false, true]) {
      test(`non-EOF ${cleanup} preserves terminal meaningfulOutput=${meaningful}`, async () => {
        const events: CodexModelRequestEvent[] = [];
        let signalTerminal!: () => void;
        const terminal = new Promise<void>((resolve) => {
          signalTerminal = resolve;
        });
        const abort = new AbortController();
        const context: CodexRequestContext = {
          clientVersion: "test",
          getToken: async () => ({ accessToken: "test", chatgptAccountId: null, isFedramp: false }),
          refresh: async () => ({ accessToken: "test", chatgptAccountId: null, isFedramp: false }),
          resolveModel: (slug) => slug,
          responseTimeoutPolicy: {
            headersTimeoutMs: 5_000,
            streamIdleTimeoutMs: cleanup === "idle_timeout" ? 250 : 5_000,
            wholeRequestTimeoutMs: cleanup === "whole_timeout" ? 250 : 10_000,
          },
          onModelRequestEvent: (event) => {
            events.push(event);
            if (["completed", "failed", "timed_out"].includes(event.phase)) signalTerminal();
          },
        };
        const response = await codexRequestStorage.run(context, () =>
          codexSubscriptionFetch(
            async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify({ type: "response.completed", response: { id: "open-response", status: "completed", output: meaningful ? [textOutput] : [] } })}\n\n`,
                      ),
                    );
                    // Provider never closes EOF; SDK cleanup/abort/timer settles it.
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
          )("https://chatgpt.com/backend-api/responses", {
            method: "POST",
            body: JSON.stringify({ stream: true }),
            signal: abort.signal,
          }),
        );
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        if (cleanup === "cancel") await reader.cancel("SDK terminal cleanup");
        else if (cleanup === "abort") abort.abort("SDK terminal cleanup");
        await terminal;
        if (cleanup !== "cancel") expect((await reader.read()).done).toBe(true);
        const terminalEvents = events.filter((event) =>
          ["completed", "failed", "timed_out"].includes(event.phase),
        );
        expect(terminalEvents).toHaveLength(1);
        expect(terminalEvents[0]).toMatchObject({
          phase: "completed",
          meaningfulOutput: meaningful,
        });
      });
    }
  }

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
