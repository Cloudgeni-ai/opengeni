import { afterEach, describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { resolveTurnModel } from "../src/index";
import { requestBodyText } from "../src/replayable-json-body";

const PRODUCT = "gpt-5.6-luna";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function switchedSettings(apiKey: string) {
  return testSettings({
    vercelAiGatewayApiKey: apiKey,
    resolvedModelFallbackRoutesJson: JSON.stringify([
      {
        productId: PRODUCT,
        via: "opengeni-gateway",
        upstreamModelId: "openai/gpt-5.6-luna",
        providers: ["openai"],
      },
    ]),
    activeModelFallbackRoutesJson: JSON.stringify([PRODUCT]),
  });
}

describe("credits fallback route transport", () => {
  test("sends the product to the Gateway Responses API pinned to its single provider", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    let capturedAuthorization: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedBody = JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>;
      capturedAuthorization = new Headers(init?.headers).get("authorization");
      return new Response(
        'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":null}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const apiKey = `gateway-fallback-${crypto.randomUUID()}`;
    const resolved = resolveTurnModel(switchedSettings(apiKey), PRODUCT);
    expect(resolved?.provider).toMatchObject({ id: "opengeni-gateway", api: "responses" });
    expect(resolved?.configured.id).toBe(PRODUCT);
    for await (const _event of resolved!.model.getStreamedResponse({
      input: "hello",
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    } as never)) {
      // consume
    }
    expect(capturedUrl).toBe("https://ai-gateway.vercel.sh/v1/responses");
    expect(capturedAuthorization).toBe(`Bearer ${apiKey}`);
    expect(capturedBody).toMatchObject({ model: "openai/gpt-5.6-luna", stream: true });
    expect(capturedBody?.providerOptions).toEqual({
      gateway: { only: ["openai"], order: ["openai"], caching: "auto" },
    });
  });
});
