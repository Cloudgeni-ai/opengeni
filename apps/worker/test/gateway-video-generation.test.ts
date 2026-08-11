import { describe, expect, test } from "bun:test";
import type { CanonicalVideoGenerationRequest } from "@opengeni/core";
import {
  buildGatewayVideoStartBody,
  getGatewayVideoGenerationStatus,
  startGatewayVideoGeneration,
} from "../src/activities/gateway-video-generation";

const baseRequest: CanonicalVideoGenerationRequest = {
  schemaVersion: 1,
  modelId: "bytedance/seedance-2.5",
  prompt: "A quiet fjord at sunrise",
  sourceMode: "text",
  references: [],
  durationSeconds: 4,
  aspectRatio: "16:9",
  resolution: "480p",
  generateAudio: true,
};

describe("Vercel AI Gateway video adapter", () => {
  test("uses the V4 async wire and stable caller idempotency", async () => {
    let request: Request | null = null;
    const result = await startGatewayVideoGeneration({
      apiKey: "test-key",
      request: baseRequest,
      idempotencyKey: `ogvid_${"a".repeat(48)}`,
      referenceGrants: [],
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ operation: { gatewayJobId: "job_1" } });
      },
    });
    expect(result).toEqual({ providerJobId: "job_1" });
    expect(request!.url).toEndWith("/v4/ai/video-model/start");
    expect(request!.headers.get("ai-video-model-specification-version")).toBe("4");
    expect(request!.headers.get("idempotency-key")).toBe(`ogvid_${"a".repeat(48)}`);
    expect(await request!.json()).toEqual({
      prompt: baseRequest.prompt,
      n: 1,
      aspectRatio: "16:9",
      resolution: "480p",
      duration: 4,
      fps: 24,
      generateAudio: true,
      providerOptions: {},
    });
  });

  test("maps ordered frame and semantic-reference grants without bytes", () => {
    const firstLast = buildGatewayVideoStartBody(
      {
        ...baseRequest,
        sourceMode: "first_and_last_frames",
        references: [
          {
            role: "first_frame",
            contentSha256: "a".repeat(64),
            contentType: "image/png",
            byteSize: 8,
          },
          {
            role: "last_frame",
            contentSha256: "b".repeat(64),
            contentType: "image/png",
            byteSize: 8,
          },
        ],
      },
      [
        {
          role: "first_frame",
          url: "https://objects.test/first",
          mediaType: "image/png",
        },
        {
          role: "last_frame",
          url: "https://objects.test/last",
          mediaType: "image/png",
        },
      ],
    );
    expect(firstLast.frameImages).toEqual([
      {
        frameType: "first_frame",
        image: {
          type: "url",
          url: "https://objects.test/first",
          mediaType: "image/png",
        },
      },
      {
        frameType: "last_frame",
        image: {
          type: "url",
          url: "https://objects.test/last",
          mediaType: "image/png",
        },
      },
    ]);
    expect(JSON.stringify(firstLast)).not.toContain("base64");
  });

  test("returns pending, completed URL, and terminal provider error", async () => {
    const statuses = [
      { status: "pending" },
      {
        status: "completed",
        videos: [
          {
            type: "url",
            url: "https://output.test/video.mp4",
            mediaType: "video/mp4",
          },
        ],
      },
      { status: "error", error: { message: "Rejected safely" } },
    ];
    for (const expected of ["pending", "completed", "error"] as const) {
      const status = await getGatewayVideoGenerationStatus({
        apiKey: "test-key",
        modelId: baseRequest.modelId,
        providerJobId: "job_1",
        fetch: async () => Response.json(statuses.shift()),
      });
      expect(status.status).toBe(expected);
    }
  });

  test("retries status visibility lag without making start 404 retryable", async () => {
    await expect(
      getGatewayVideoGenerationStatus({
        apiKey: "test-key",
        modelId: baseRequest.modelId,
        providerJobId: "job_1",
        fetch: async () => new Response("Async job not found", { status: 404 }),
      }),
    ).rejects.toMatchObject({ status: 404, retryable: true });
    await expect(
      startGatewayVideoGeneration({
        apiKey: "test-key",
        request: baseRequest,
        idempotencyKey: `ogvid_${"b".repeat(48)}`,
        referenceGrants: [],
        fetch: async () => new Response("Not found", { status: 404 }),
      }),
    ).rejects.toMatchObject({ status: 404, retryable: false });
  });
});
