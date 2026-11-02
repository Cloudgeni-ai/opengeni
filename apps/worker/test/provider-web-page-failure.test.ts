import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildOpenAIClientFromSettings } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import { agentRunFailurePayload } from "../src/activities/agent-turn";

// A provider base URL that points at an ordinary website: it answers the API
// request with an HTML page, replayed over real HTTP through the worker's client.
const PAGE =
  '<!doctype html><html lang="en"><head><title>Example Domain</title><style>body{margin:0}</style></head><body><h1>Example Domain</h1></body></html>';

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text();
      return new Response(PAGE, { status: 405, headers: { "content-type": "text/html" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

describe("a provider address that serves a web page", () => {
  test("fails the turn with an explanation instead of the page's markup", async () => {
    const client = buildOpenAIClientFromSettings(
      testSettings({
        openaiApiKey: "sk-fixture",
        openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
        openaiMaxRetries: 0,
      }),
    );
    let thrown: unknown = null;
    try {
      await client.chat.completions.create({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    const payload = agentRunFailurePayload(thrown);
    expect(payload.error).toBe(
      "The model provider's address answered with a web page (HTTP 405) instead of an API response. Check the provider's base URL in its settings.",
    );
    expect(payload.error).not.toContain("<");
    expect(payload.detail).toBe("Page title: Example Domain");
  });

  test("leaves other provider errors as they were", () => {
    const payload = agentRunFailurePayload(new Error("405 Method Not Allowed"));
    expect(payload.error).toContain("405 Method Not Allowed");
  });
});
