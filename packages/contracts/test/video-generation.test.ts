import { describe, expect, test } from "bun:test";
import {
  GenerateVideoToolInput,
  GeneratedVideoReceipt,
  MediaGenerationResult,
  SEEDANCE_2_5_MODEL_ID,
  VideoGenerationCapabilities,
  VideoGenerationPolicy,
  retainedGeneratedVideoReferenceFromFile,
} from "../src";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "55555555-5555-4555-8555-555555555555";
const operationId = "66666666-6666-4666-8666-666666666666";

function artifact() {
  return {
    available: true as const,
    artifactId,
    kind: "generated_video" as const,
    contentType: "video/mp4" as const,
    originalBytes: 2_048,
    sha256: "a".repeat(64),
    retainedAt: "2026-08-10T00:00:00.000Z",
    dimensions: { width: 854, height: 480 },
    retention: { policy: "workspace_file" as const, expiresAt: null },
    retrieval: {
      method: "GET" as const,
      path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
      acceptRanges: "bytes" as const,
      maxRangeBytes: 1_024 * 1_024,
    },
  };
}

function receipt() {
  return {
    type: "generated_video" as const,
    schemaVersion: 1 as const,
    operationId,
    artifact: artifact(),
    video: {
      durationSeconds: 4,
      width: 854,
      height: 480,
      fps: 24,
      hasAudio: true,
      videoCodec: "h264" as const,
      audioCodec: "aac" as const,
    },
    sandboxPath: `/workspace/generated-videos/generated-video-${artifactId}.mp4`,
  };
}

describe("video generation contracts", () => {
  test("keeps the provider-neutral tool input closed", () => {
    expect(
      GenerateVideoToolInput.parse({
        prompt: "A quiet lake at dawn",
        source: {
          mode: "first_and_last_frames",
          firstFramePath: "/workspace/a.png",
          lastFramePath: "/workspace/b.png",
        },
        durationSeconds: 4,
        aspectRatio: "16:9",
        resolution: "480p",
        generateAudio: true,
      }),
    ).toBeTruthy();
    expect(GenerateVideoToolInput.safeParse({ prompt: "x", provider: "gateway" }).success).toBe(
      false,
    );
    expect(
      GenerateVideoToolInput.safeParse({
        prompt: "x",
        source: { mode: "image_reference", imagePath: "https://example.com/image.png" },
      }).success,
    ).toBe(false);
  });

  test("validates capability and policy defaults against enabled models", () => {
    expect(
      VideoGenerationCapabilities.parse({
        schemaVersion: 1,
        capabilityRevision: "revision-1",
        defaultModelId: SEEDANCE_2_5_MODEL_ID,
        models: [
          {
            modelId: SEEDANCE_2_5_MODEL_ID,
            label: "Seedance 2.5",
            providerLabel: "Vercel AI Gateway",
            sourceModes: ["text"],
            resolutions: ["480p", "720p"],
            aspectRatios: ["16:9", "9:16"],
            duration: { minSeconds: 4, maxSeconds: 30, stepSeconds: 1 },
            supportsAudio: true,
          },
        ],
      }).defaultModelId,
    ).toBe(SEEDANCE_2_5_MODEL_ID);
    expect(
      VideoGenerationPolicy.safeParse({
        schemaVersion: 1,
        revision: 1,
        enabledModelIds: [],
        defaultModelId: SEEDANCE_2_5_MODEL_ID,
      }).success,
    ).toBe(false);
  });

  test("builds and validates the compact permanent receipt", () => {
    expect(GeneratedVideoReceipt.parse(receipt())).toEqual(receipt());
    expect(
      retainedGeneratedVideoReferenceFromFile({
        id: artifactId,
        workspaceId,
        status: "ready",
        contentType: "video/mp4",
        sizeBytes: 2_048,
        sha256: "a".repeat(64),
        updatedAt: "2026-08-10T00:00:00.000Z",
        width: 854,
        height: 480,
      }),
    ).toEqual(artifact());
  });

  test("ties terminal success to the same operation", () => {
    expect(
      MediaGenerationResult.parse({
        type: "media_generation_result",
        schemaVersion: 1,
        status: "ready",
        operationId,
        receipt: receipt(),
      }).status,
    ).toBe("ready");
    expect(
      MediaGenerationResult.safeParse({
        type: "media_generation_result",
        schemaVersion: 1,
        status: "ready",
        operationId: "77777777-7777-4777-8777-777777777777",
        receipt: receipt(),
      }).success,
    ).toBe(false);
  });
});
