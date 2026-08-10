import { describe, expect, test } from "bun:test";
import { SEEDANCE_2_5_MODEL_ID } from "@opengeni/contracts";
import { defaultVideoGenerationPolicy, videoGenerationCapabilitiesForPolicy } from "../src";

describe("video generation capability catalog", () => {
  test("is disabled by default", () => {
    expect(() =>
      videoGenerationCapabilitiesForPolicy({
        policy: defaultVideoGenerationPolicy(),
        credentialVersion: 1,
      }),
    ).toThrow("disabled");
  });

  test("projects one stable reviewed Seedance capability", () => {
    const capabilities = videoGenerationCapabilitiesForPolicy({
      policy: {
        schemaVersion: 1,
        revision: 2,
        enabledModelIds: [SEEDANCE_2_5_MODEL_ID],
        defaultModelId: SEEDANCE_2_5_MODEL_ID,
      },
      credentialVersion: 4,
    });
    expect(capabilities.defaultModelId).toBe(SEEDANCE_2_5_MODEL_ID);
    expect(capabilities.models).toHaveLength(1);
    expect(capabilities.models[0]?.sourceModes).toEqual([
      "text",
      "first_frame",
      "first_and_last_frames",
      "image_reference",
      "video_reference",
    ]);
    expect(capabilities.capabilityRevision).toMatch(/^[0-9a-f]{64}$/);
  });
});
