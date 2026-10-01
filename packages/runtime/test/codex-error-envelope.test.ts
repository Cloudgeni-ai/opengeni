import { expect, test } from "bun:test";
import OpenAI, { BadRequestError } from "openai";
import {
  codexRequestStorage,
  codexSubscriptionFetch,
  classifyCodexEntitlementRejection,
} from "@opengeni/codex";

test("unsupported-model detail survives the real OpenAI SDK and preserves the requested model", async () => {
  const detail =
    "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  let wireModel: unknown;
  const client = new OpenAI({
    apiKey: "fixture",
    baseURL: "https://chatgpt.com/backend-api",
    maxRetries: 0,
    fetch: codexSubscriptionFetch(async (_input, init) => {
      wireModel = JSON.parse(init!.body as string).model;
      return new Response(JSON.stringify({ detail }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }),
  });
  const token = { accessToken: "fixture", chatgptAccountId: null, isFedramp: false };
  const error = await codexRequestStorage.run(
    {
      clientVersion: "test",
      getToken: async () => token,
      refresh: async () => token,
      resolveModel: (model) => model,
    },
    () =>
      client.responses
        .create({ model: "gpt-6.1-sol", input: "Hello", stream: true })
        .catch((caught: unknown) => caught),
  );
  expect(error).toBeInstanceOf(BadRequestError);
  expect(error).toMatchObject({ status: 400, error: { message: detail } });
  expect((error as Error).message).toContain(detail);
  expect((error as Error).message).not.toContain("no body");
  expect(classifyCodexEntitlementRejection(error)).toBeNull();
  expect(wireModel).toBe("gpt-6.1-sol");
});
