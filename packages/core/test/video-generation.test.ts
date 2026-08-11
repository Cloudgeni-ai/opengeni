import { describe, expect, test } from "bun:test";
import { SEEDANCE_2_5_MODEL_ID, type VideoGenerationModelCapability } from "@opengeni/contracts";
import {
  assertVideoGenerationTransition,
  canonicalVideoGenerationRequestJson,
  normalizeVideoGenerationRequest,
  videoGenerationAdmissionKey,
  videoGenerationProviderIdempotencyKey,
  videoGenerationRequestDigest,
} from "../src/domain/video-generation";

const model: VideoGenerationModelCapability = {
  modelId: SEEDANCE_2_5_MODEL_ID,
  label: "Seedance 2.5",
  providerLabel: "Vercel AI Gateway",
  sourceModes: [
    "text",
    "first_frame",
    "first_and_last_frames",
    "image_reference",
    "video_reference",
  ],
  resolutions: ["480p", "720p"],
  aspectRatios: ["16:9", "9:16"],
  duration: { minSeconds: 4, maxSeconds: 30, stepSeconds: 1 },
  supportsAudio: true,
};

describe("video-generation domain", () => {
  test("normalizes a request without introducing provider wire details", () => {
    const request = normalizeVideoGenerationRequest({
      toolInput: { prompt: "A red kite", modelId: SEEDANCE_2_5_MODEL_ID },
      model,
      sealedReferences: [],
    });
    expect(request).toEqual({
      schemaVersion: 1,
      modelId: SEEDANCE_2_5_MODEL_ID,
      prompt: "A red kite",
      sourceMode: "text",
      references: [],
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "480p",
      generateAudio: true,
    });
    expect(canonicalVideoGenerationRequestJson(request)).not.toContain("gateway");
  });

  test("keeps ordered semantic references in the request digest", () => {
    const first = normalizeVideoGenerationRequest({
      toolInput: {
        prompt: "Transition",
        source: {
          mode: "first_and_last_frames",
          firstFramePath: "/workspace/first.png",
          lastFramePath: "/workspace/last.png",
        },
      },
      model,
      sealedReferences: [
        {
          role: "first_frame",
          contentSha256: "a".repeat(64),
          contentType: "image/png",
          byteSize: 10,
        },
        {
          role: "last_frame",
          contentSha256: "b".repeat(64),
          contentType: "image/png",
          byteSize: 20,
        },
      ],
    });
    const reversed = { ...first, references: [...first.references].reverse() };
    expect(videoGenerationRequestDigest(first)).not.toBe(videoGenerationRequestDigest(reversed));
  });

  test("separates logical admission identity from request content", () => {
    const identity = {
      workspaceId: "workspace",
      sessionId: "session",
      turnId: "turn",
      toolCallId: "call-1",
    };
    expect(videoGenerationAdmissionKey(identity)).toBe(videoGenerationAdmissionKey(identity));
    expect(videoGenerationAdmissionKey(identity)).not.toBe(
      videoGenerationAdmissionKey({ ...identity, toolCallId: "call-2" }),
    );
    expect(
      videoGenerationProviderIdempotencyKey({
        operationId: "operation",
        requestDigest: "a".repeat(64),
      }),
    ).toMatch(/^ogvid_[0-9a-f]{48}$/u);
  });

  test("allows only explicit operation transitions", () => {
    expect(() => assertVideoGenerationTransition("prepared", "accepted")).not.toThrow();
    expect(() => assertVideoGenerationTransition("provider_started", "completed")).toThrow();
    expect(() => assertVideoGenerationTransition("completed", "provider_started")).toThrow();
  });
});
