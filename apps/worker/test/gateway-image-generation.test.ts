import { describe, expect, test } from "bun:test";
import {
  GatewayImageApiError,
  generateGatewayImage,
} from "../src/activities/gateway-image-generation";

describe("Vercel AI Gateway image adapter", () => {
  test("uses the pinned image protocol and decodes its first image as a stream", async () => {
    const expected = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const body = new TextEncoder().encode(
      JSON.stringify({ images: [Buffer.from(expected).toString("base64")], usage: {} }),
    );
    let captured: { url: string; init: RequestInit } | null = null;
    const output = await generateGatewayImage({
      apiKey: "gateway-secret",
      modelId: "openai/gpt-image-2",
      prompt: "A small blue sphere",
      toolCallId: "call-image-1",
      fetch: async (url, init = {}) => {
        captured = { url: String(url), init };
        let offset = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= body.byteLength) {
                controller.close();
                return;
              }
              controller.enqueue(body.slice(offset, offset + 2));
              offset += 2;
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(output).toEqual({
      toolCallId: "call-image-1",
      providerItemId: null,
      bytes: expected,
    });
    expect(captured?.url).toBe("https://ai-gateway.vercel.sh/v3/ai/image-model");
    expect(captured?.init.redirect).toBe("error");
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer gateway-secret");
    expect(headers.get("ai-gateway-auth-method")).toBe("api-key");
    expect(headers.get("ai-gateway-protocol-version")).toBe("0.0.1");
    expect(headers.get("ai-image-model-specification-version")).toBe("3");
    expect(headers.get("ai-model-id")).toBe("openai/gpt-image-2");
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      prompt: "A small blue sphere",
      n: 1,
    });
  });

  test("surfaces one bounded provider failure without retrying", async () => {
    let calls = 0;
    await expect(
      generateGatewayImage({
        apiKey: "gateway-secret",
        modelId: "openai/gpt-image-2",
        prompt: "A sphere",
        toolCallId: "call-image-2",
        fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
            status: 429,
          });
        },
      }),
    ).rejects.toEqual(
      new GatewayImageApiError(429, "AI Gateway image generation failed (429): quota exhausted"),
    );
    expect(calls).toBe(1);
  });
});
