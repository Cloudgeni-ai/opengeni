import { afterAll, expect, test } from "bun:test";
import { buildOpenAIClientFromSettings } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";

// Google's OpenAI-compatible endpoints answer errors as a JSON array. Synthetic body.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    Response.json(
      [
        {
          error: {
            code: 400,
            message: "Function call is missing a thought_signature in functionCall parts.",
            status: "INVALID_ARGUMENT",
          },
        },
      ],
      { status: 400 },
    ),
});
afterAll(() => server.stop(true));

test("a model client error wrapped in a JSON array names the provider's reason", async () => {
  const client = buildOpenAIClientFromSettings(
    testSettings({
      openaiProvider: "openai",
      openaiApiKey: "fixture",
      openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      openaiMaxRetries: 0,
    }),
  );
  let error: unknown;
  try {
    await client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "fixture" }],
    });
  } catch (caught) {
    error = caught;
  }
  const payload = agentRunFailurePayload(error);
  expect(payload.error).toBe(
    "400 Function call is missing a thought_signature in functionCall parts.",
  );
  expect((error as { code?: unknown }).code).toBe("INVALID_ARGUMENT");
});
