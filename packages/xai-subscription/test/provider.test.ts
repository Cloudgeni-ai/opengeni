import { describe, expect, test } from "bun:test";

import {
  fetchXaiSubscriptionModels,
  fetchXaiSubscriptionQuota,
  generateXaiSubscriptionImage,
  generateXaiSubscriptionVideo,
} from "../src";

const context = {
  getToken: async () => ({ accessToken: "access", userId: "user-1" }),
  refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
};

describe("xAI quota and model metadata", () => {
  test("parses the current credits contract", async () => {
    const quota = await fetchXaiSubscriptionQuota({
      context,
      fetch: async () =>
        Response.json({
          config: {
            creditUsagePercent: 42.5,
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-08-10T00:00:00Z",
              end: "2026-08-17T00:00:00Z",
            },
            prepaidBalance: { val: 1234 },
            isUnifiedBillingUser: true,
          },
          onDemandEnabled: false,
          subscriptionTier: "SuperGrok Heavy",
        }),
    });
    expect(quota.usedPercent).toBe(42.5);
    expect(quota.period?.type).toBe("USAGE_PERIOD_TYPE_WEEKLY");
    expect(quota.period?.end?.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(quota.prepaidBalanceCents).toBe(1234);
    expect(quota.unifiedBilling).toBe(true);
    expect(quota.subscriptionTier).toBe("SuperGrok Heavy");
  });

  test("parses live models-v2 limits and skips malformed entries", async () => {
    const models = await fetchXaiSubscriptionModels({
      context,
      fetch: async () =>
        Response.json({
          data: [
            {
              model: "grok-4.5",
              name: "Grok 4.5",
              contextWindow: 300000,
              maxCompletionTokens: 16384,
              autoCompactThresholdPercent: 80,
              apiBackend: "responses",
            },
            { name: "missing slug" },
          ],
        }),
    });
    expect(models).toEqual([
      {
        slug: "grok-4.5",
        name: "Grok 4.5",
        contextWindowTokens: 300000,
        effectiveContextWindowTokens: 285000,
        autoCompactTokenLimit: 240000,
        maxCompletionTokens: 16384,
        apiBackend: "responses",
      },
    ]);
  });
});

describe("xAI media", () => {
  test("generates an image with the exact Imagine request and one 401 refresh", async () => {
    const authorizations: string[] = [];
    let body: unknown;
    const result = await generateXaiSubscriptionImage({
      prompt: "a blue sphere",
      getToken: context.getToken,
      refresh: context.refresh,
      fetch: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        body = JSON.parse(String(init?.body));
        return authorizations.length === 1
          ? Response.json({ error: "expired" }, { status: 401 })
          : Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
      },
    });
    expect(authorizations).toEqual(["Bearer access", "Bearer fresh"]);
    expect(body).toEqual({
      model: "grok-imagine-image-quality",
      prompt: "a blue sphere",
      n: 1,
      aspect_ratio: "auto",
      resolution: "1k",
      response_format: "b64_json",
    });
    expect(new TextDecoder().decode(result.bytes)).toBe("image");
  });

  test("starts, polls, and downloads an asynchronous video without replaying start", async () => {
    const urls: string[] = [];
    const result = await generateXaiSubscriptionVideo({
      prompt: "ocean waves",
      getToken: context.getToken,
      refresh: context.refresh,
      sleep: async () => undefined,
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/videos/generations")) return Response.json({ request_id: "video-1" });
        if (url.endsWith("/videos/video-1")) {
          return Response.json({
            status: "done",
            video: { url: "https://media.example/video.mp4" },
          });
        }
        return new Response("video-bytes", { headers: { "content-type": "video/mp4" } });
      },
    });
    expect(urls.filter((url) => url.endsWith("/videos/generations"))).toHaveLength(1);
    expect(urls).toEqual([
      "https://api.x.ai/v1/videos/generations",
      "https://api.x.ai/v1/videos/video-1",
      "https://media.example/video.mp4",
    ]);
    expect(new TextDecoder().decode(result.bytes)).toBe("video-bytes");
    expect(result.requestId).toBe("video-1");
  });
});
