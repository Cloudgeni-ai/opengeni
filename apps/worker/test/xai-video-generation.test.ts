import { describe, expect, test } from "bun:test";
import { GROK_IMAGINE_VIDEO_1_5_MODEL_ID } from "@opengeni/contracts";
import type { CanonicalVideoGenerationRequest } from "@opengeni/core";
import { buildXaiVideoStartBody } from "../src/activities/xai-video-generation";

function request(
  patch: Partial<CanonicalVideoGenerationRequest> = {},
): CanonicalVideoGenerationRequest {
  return {
    schemaVersion: 1,
    modelId: GROK_IMAGINE_VIDEO_1_5_MODEL_ID,
    prompt: "A quiet fjord at dawn",
    sourceMode: "text",
    references: [],
    durationSeconds: 6,
    aspectRatio: "16:9",
    resolution: "480p",
    generateAudio: true,
    ...patch,
  };
}

describe("SuperGrok durable video adapter", () => {
  test("maps the provider-neutral text request to xAI's public video API", () => {
    expect(buildXaiVideoStartBody(request(), [])).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "A quiet fjord at dawn",
      duration: 6,
      aspect_ratio: "16:9",
      resolution: "480p",
    });
  });

  test("maps one first frame and rejects unsupported source modes", () => {
    expect(
      buildXaiVideoStartBody(
        request({
          sourceMode: "first_frame",
          references: [
            {
              role: "first_frame",
              contentSha256: "a".repeat(64),
              contentType: "image/jpeg",
              byteSize: 12,
            },
          ],
        }),
        [
          {
            role: "first_frame",
            url: "https://media.example/frame.jpg",
            mediaType: "image/jpeg",
          },
        ],
      ),
    ).toMatchObject({ image: { url: "https://media.example/frame.jpg" } });
    expect(buildXaiVideoStartBody(request({ generateAudio: false }), [])).toEqual(
      buildXaiVideoStartBody(request({ generateAudio: true }), []),
    );
    expect(() => buildXaiVideoStartBody(request({ sourceMode: "video_reference" }), [])).toThrow(
      "does not support video_reference",
    );
  });
});
