import { describe, expect, test } from "bun:test";
import {
  executeGatewayImageGeneration,
  GatewayImageApiError,
  generateGatewayImage,
  imageGenerationProviderFailedResult,
  isGatewayImageRequestRefused,
  reportImageGenerationProviderFailure,
} from "../src/activities/gateway-image-generation";
import type { ImageGenerationOperationPorts } from "../src/activities/image-generation-operation";

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
      new GatewayImageApiError(
        429,
        "AI Gateway image generation failed (429): quota exhausted",
        "quota exhausted",
      ),
    );
    expect(calls).toBe(1);
  });

  test("sends ordered validated image references through the v3 files contract", async () => {
    let requestBody: unknown;
    await generateGatewayImage({
      apiKey: "gateway-secret",
      modelId: "openai/gpt-image-2",
      prompt: "Use reference one for the subject and two for the visual style",
      references: [
        {
          mediaType: "image/png",
          bytes: Uint8Array.from([1, 2, 3]),
          sizeBytes: 3,
          sha256: "a".repeat(64),
        },
        {
          mediaType: "image/webp",
          bytes: Uint8Array.from([4, 5, 6]),
          sizeBytes: 3,
          sha256: "b".repeat(64),
        },
      ],
      toolCallId: "call-image-edit-1",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ images: ["aW1hZ2U="] });
      },
    });

    expect(requestBody).toEqual({
      prompt: "Use reference one for the subject and two for the visual style",
      n: 1,
      files: [
        { type: "file", mediaType: "image/png", data: "AQID" },
        { type: "file", mediaType: "image/webp", data: "BAUG" },
      ],
    });
  });
});

async function gatewayFailure(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<GatewayImageApiError> {
  try {
    await generateGatewayImage({
      apiKey: "gateway-secret",
      modelId: "openai/gpt-image-2",
      prompt: "A cat",
      toolCallId: "call-failure",
      fetch: async () => new Response(JSON.stringify(body), { status, headers }),
    });
  } catch (error) {
    if (error instanceof GatewayImageApiError) return error;
    throw error;
  }
  throw new Error("expected a provider failure");
}

describe("image provider failures the agent can relay", () => {
  const unavailable = "Image generation isn't available right now, so no image was made.";

  test("an image provider out of credit is unavailable, with no account text or links", async () => {
    const error = await gatewayFailure(402, {
      error: {
        message:
          "Insufficient funds. Please add credits to your account. Visit https://billing.example.com/top-up to top up.",
        type: "insufficient_funds",
      },
    });
    expect(isGatewayImageRequestRefused(error)).toBe(true);
    expect(imageGenerationProviderFailedResult(error)).toEqual({
      isError: true,
      status: "rejected",
      code: "image_provider_unavailable",
      message: unavailable,
      content: [{ type: "text", text: unavailable }],
    });
  });

  test("a short rate limit is busy for the provider's stated wait; an exhausted quota is unavailable", async () => {
    const busy = await gatewayFailure(
      429,
      { error: { message: "Too many requests" } },
      { "retry-after": "5" },
    );
    expect(imageGenerationProviderFailedResult(busy)).toMatchObject({
      status: "rejected",
      code: "image_provider_busy",
      message: "Image generation is busy right now, so no image was made. Try again in 5 seconds.",
    });
    const minutes = await gatewayFailure(
      429,
      { error: { message: "Too many requests" } },
      { "retry-after-ms": "150000" },
    );
    expect(imageGenerationProviderFailedResult(minutes).message).toBe(
      "Image generation is busy right now, so no image was made. Try again in 3 minutes.",
    );
    const inMessage = await gatewayFailure(429, {
      error: { message: "Rate limited. Please try again in 20s." },
    });
    expect(imageGenerationProviderFailedResult(inMessage).message).toBe(
      "Image generation is busy right now, so no image was made. Try again in 20 seconds.",
    );
    const unstated = await gatewayFailure(429, { error: { message: "Too many requests" } });
    expect(imageGenerationProviderFailedResult(unstated).message).toBe(
      "Image generation is busy right now, so no image was made. Try again in a minute.",
    );
    const exhausted = await gatewayFailure(429, {
      error: { message: "You exceeded your current quota", code: "insufficient_quota" },
    });
    expect(imageGenerationProviderFailedResult(exhausted)).toMatchObject({
      status: "rejected",
      code: "image_provider_unavailable",
      message: unavailable,
    });
    // A stated wait far beyond per-minute pacing is an exhausted quota too.
    const longWait = await gatewayFailure(
      429,
      { error: { message: "Too many requests" } },
      { "retry-after": "7200" },
    );
    expect(imageGenerationProviderFailedResult(longWait).code).toBe("image_provider_unavailable");
    // Per-minute wording keeps the classifier from calling it a quota, but a
    // stated wait beyond 15 minutes is still not "busy".
    const perMinuteLongWait = await gatewayFailure(
      429,
      { error: { message: "Rate limit exceeded: requests per minute quota exceeded" } },
      { "retry-after": "7200" },
    );
    expect(imageGenerationProviderFailedResult(perMinuteLongWait)).toMatchObject({
      status: "rejected",
      code: "image_provider_unavailable",
      message: unavailable,
    });
    const fifteenMinutes = await gatewayFailure(
      429,
      { error: { message: "Rate limit exceeded: requests per minute quota exceeded" } },
      { "retry-after": "900" },
    );
    expect(imageGenerationProviderFailedResult(fifteenMinutes).message).toBe(
      "Image generation is busy right now, so no image was made. Try again in 15 minutes.",
    );
  });

  test("a refused request carries the provider's reason without links", async () => {
    const error = await gatewayFailure(400, {
      error: {
        message:
          "Your request was rejected by the safety system. See https://help.example.com/policy",
      },
    });
    const text =
      "The image provider refused this request, so no image was made: Your request was rejected by the safety system.";
    expect(imageGenerationProviderFailedResult(error)).toEqual({
      isError: true,
      status: "rejected",
      code: "image_request_refused",
      message: text,
      content: [{ type: "text", text }],
    });
  });

  test("a refusal whose only reason is a link, or a bare web address, falls back to the plain refusal", async () => {
    const refused = "The image provider refused this request, so no image was made.";
    for (const message of [
      "Blocked by policy, see https://docs.example.com/policy",
      "Content was blocked. Review the rules at example.com/usage-policies",
      "Request rejected; contact support at example.com",
    ]) {
      const error = await gatewayFailure(422, { error: { message } });
      const result = imageGenerationProviderFailedResult(error);
      const kept = message.startsWith("Content was blocked.") ? " Content was blocked." : "";
      expect(result.message).toBe(kept ? `${refused.slice(0, -1)}:${kept}` : refused);
      expect(result.message).not.toContain("example.com");
    }
  });

  test("a provider outage is an unavailable tool failure that may have made the image", async () => {
    for (const status of [408, 500, 503]) {
      const error = await gatewayFailure(status, { error: { message: "upstream failed" } });
      expect(isGatewayImageRequestRefused(error)).toBe(false);
      expect(imageGenerationProviderFailedResult(error)).toMatchObject({
        status: "failed",
        code: "image_provider_unavailable",
        message:
          "Image generation isn't available right now, and the image may not have been made.",
      });
    }
  });

  test("the operator gets a metric and a log line with the provider's own detail", async () => {
    const error = await gatewayFailure(402, {
      error: { message: "Insufficient funds.", type: "insufficient_funds" },
    });
    const counters: unknown[] = [];
    const warnings: Array<[string, unknown]> = [];
    reportImageGenerationProviderFailure(
      {
        incrementCounter: (metric) => void counters.push(metric),
        warn: (message, attributes) => void warnings.push([message, attributes]),
      },
      {
        error,
        result: imageGenerationProviderFailedResult(error),
        modelId: "openai/gpt-image-2",
        funding: "opengeni_credits",
      },
    );
    expect(counters).toEqual([
      expect.objectContaining({
        name: "opengeni_image_generation_provider_failures_total",
        labels: {
          provider: "vercel-ai-gateway",
          funding: "opengeni_credits",
          code: "image_provider_unavailable",
        },
      }),
    ]);
    expect(warnings).toEqual([
      [
        "image generation provider failed",
        {
          provider: "vercel-ai-gateway",
          funding: "opengeni_credits",
          modelId: "openai/gpt-image-2",
          status: 402,
          code: "image_provider_unavailable",
          quotaScope: "credits",
          detail: "AI Gateway image generation failed (402): Insufficient funds.",
        },
      ],
    ]);
  });
});

// The operation store as the state it moves through, so the test proves where
// a real provider response leaves the durable operation.
function statefulOperationPorts() {
  const transitions: string[] = [];
  let status = "prepared";
  const move = (next: string) => {
    transitions.push(next);
    status = next;
    return { status } as never;
  };
  const ports: ImageGenerationOperationPorts = {
    prepare: async () => ({ operation: { status } as never, created: true }),
    begin: async () => ({ operation: move("provider_started"), started: true }),
    resetBeforeProviderDispatch: async () => move("prepared"),
    retain: async () => {
      throw new Error("no image expected");
    },
    complete: async () => move("completed"),
    markOutcomeUnknown: async () => move("outcome_unknown"),
    markRetentionFailed: async () => move("retention_failed"),
    recover: async () => null,
  };
  return { ports, transitions, status: () => status };
}

describe("a real provider response through the image operation", () => {
  const input = (status: number) => ({
    db: {} as Parameters<typeof executeGatewayImageGeneration>[0]["db"],
    objectStorage: null,
    accountId: "66666666-6666-4666-8666-666666666666",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    turnId: "33333333-3333-4333-8333-333333333333",
    attemptId: "44444444-4444-4444-8444-444444444444",
    apiKey: "gateway-secret",
    modelId: "openai/gpt-image-2",
    prompt: "A cat",
    toolCallId: `call-${status}`,
    pricedCostMicros: 250_000,
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "Insufficient funds." } }), { status }),
  });

  test("a 4xx refusal returns the operation to prepared, holding and charging nothing", async () => {
    const store = statefulOperationPorts();
    await expect(executeGatewayImageGeneration(input(402), store.ports)).rejects.toBeInstanceOf(
      GatewayImageApiError,
    );
    expect(store.transitions).toEqual(["provider_started", "prepared"]);
    expect(store.status()).toBe("prepared");
  });

  test("a 5xx leaves the operation outcome-unknown, never completed", async () => {
    const store = statefulOperationPorts();
    await expect(executeGatewayImageGeneration(input(503), store.ports)).rejects.toBeInstanceOf(
      GatewayImageApiError,
    );
    expect(store.transitions).toEqual(["provider_started", "outcome_unknown"]);
  });
});
