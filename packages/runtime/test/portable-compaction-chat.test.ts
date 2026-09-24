import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  EmptyCompactionSummaryError,
  compactionSummaryOutputTokens,
  summarizeForCompaction,
} from "../src/index";

type Options = NonNullable<Parameters<typeof summarizeForCompaction>[2]>;
type Request = Record<string, unknown>;

function chatClient(
  create: (request: Request) => Promise<unknown>,
): NonNullable<Options["client"]> {
  return { chat: { completions: { create } } } as unknown as NonNullable<Options["client"]>;
}

const history = [{ type: "message", role: "user", content: "Keep the approved task" }];

test("Chat compaction carries the agent instructions and bounds output on a small model", async () => {
  const settings = testSettings({ contextWindowTokens: 8_000 });
  let request: Request | undefined;
  const summary = await summarizeForCompaction(settings, history, {
    api: "chat",
    client: chatClient(async (value) => {
      request = value;
      return {
        choices: [{ finish_reason: "stop", message: { content: "Continue approved task" } }],
      };
    }),
    systemInstructions: "Follow the active agent instructions",
  });

  expect(summary).toBe("Continue approved task");
  expect(compactionSummaryOutputTokens(8_000)).toBe(2_000);
  expect(request).toMatchObject({
    max_tokens: 2_000,
    messages: [
      { role: "system", content: "Follow the active agent instructions" },
      { role: "user", content: expect.stringContaining("Keep the approved task") },
    ],
  });
});

test.each(["length", "content_filter", "tool_calls", "unknown", null])(
  "Chat compaction preserves source history on non-stop finish %s",
  async (finishReason) => {
    const original = JSON.stringify(history);
    await expect(
      summarizeForCompaction(testSettings({ contextWindowTokens: 8_000 }), history, {
        api: "chat",
        client: chatClient(async () => ({
          choices: [
            {
              finish_reason: finishReason,
              message: { content: "Plausible but incomplete summary" },
            },
          ],
        })),
      }),
    ).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
    expect(JSON.stringify(history)).toBe(original);
  },
);

test("Chat failure diagnostics never persist an arbitrary provider finish reason", async () => {
  const providerText = "private conversation content";
  let failure: unknown;
  try {
    await summarizeForCompaction(testSettings(), history, {
      api: "chat",
      client: chatClient(async () => ({
        choices: [{ finish_reason: providerText, message: { content: "partial" } }],
      })),
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: "EmptyCompactionSummaryError",
    diagnostics: { finishReason: "unknown" },
  });
  expect(String(failure)).not.toContain(providerText);
});
