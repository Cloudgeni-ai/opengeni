import { describe, expect, test } from "bun:test";
import { GROK_IMAGINE_VIDEO_1_5_MODEL_ID, SEEDANCE_2_5_MODEL_ID } from "@opengeni/contracts";
import {
  defaultVideoGenerationPolicy,
  videoGenerationCapabilitiesForPolicy,
  videoGenerationModelSupportsFundingSource,
} from "../src";

describe("video generation capability catalog", () => {
  test("is disabled by default", () => {
    expect(() =>
      videoGenerationCapabilitiesForPolicy({
        policy: defaultVideoGenerationPolicy(),
        credentialVersion: 1,
      }),
    ).toThrow("disabled");
  });

  test("projects the stable reviewed Seedance capability", () => {
    const capabilities = videoGenerationCapabilitiesForPolicy({
      policy: {
        schemaVersion: 1,
        revision: 2,
        fundingSource: "workspace_gateway",
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

  test("binds Grok video exclusively to connected SuperGrok", () => {
    expect(
      videoGenerationModelSupportsFundingSource(
        GROK_IMAGINE_VIDEO_1_5_MODEL_ID,
        "supergrok_subscription",
      ),
    ).toBe(true);
    expect(
      videoGenerationModelSupportsFundingSource(
        GROK_IMAGINE_VIDEO_1_5_MODEL_ID,
        "opengeni_credits",
      ),
    ).toBe(false);
    const capabilities = videoGenerationCapabilitiesForPolicy({
      policy: {
        schemaVersion: 1,
        revision: 3,
        fundingSource: "supergrok_subscription",
        enabledModelIds: [GROK_IMAGINE_VIDEO_1_5_MODEL_ID],
        defaultModelId: GROK_IMAGINE_VIDEO_1_5_MODEL_ID,
      },
      credentialVersion: 7,
    });
    expect(capabilities.models).toEqual([
      expect.objectContaining({
        modelId: GROK_IMAGINE_VIDEO_1_5_MODEL_ID,
        sourceModes: ["text", "first_frame", "image_reference"],
        supportsAudio: true,
      }),
    ]);
  });
});
