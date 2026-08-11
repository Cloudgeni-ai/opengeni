import { describe, expect, test } from "bun:test";
import { SEEDANCE_2_5_MODEL_ID } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { Manifest } from "@openai/agents/sandbox";
import { buildOpenGeniAgent, lazySkillSourceWithPackSkills } from "../src";

const capabilities = {
  schemaVersion: 1 as const,
  capabilityRevision: "a".repeat(64),
  defaultModelId: SEEDANCE_2_5_MODEL_ID,
  models: [
    {
      modelId: SEEDANCE_2_5_MODEL_ID,
      label: "Seedance 2.5",
      providerLabel: "Vercel AI Gateway",
      sourceModes: ["text" as const],
      resolutions: ["480p" as const],
      aspectRatios: ["16:9" as const],
      duration: { minSeconds: 4, maxSeconds: 30, stepSeconds: 1 },
      supportsAudio: true,
    },
  ],
};

describe("video generation runtime surface", () => {
  test("adds two stable adjacent tools only when executable", () => {
    const disabled = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "none", webSearchEnabled: false }),
      [],
      { humanInputEnabled: false },
    );
    const enabled = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "none", webSearchEnabled: false }),
      [],
      {
        humanInputEnabled: false,
        videoGeneration: {
          capabilities: async () => capabilities,
          execute: async (_input, context) => ({
            schemaVersion: 1,
            status: "accepted",
            operationId: context.toolCallId,
          }),
        },
      },
    );
    const names = (agent: typeof enabled) =>
      ((agent as unknown as { tools: Array<{ name: string }> }).tools ?? []).map(
        (tool) => tool.name,
      );
    expect(names(disabled)).toEqual([]);
    expect(names(enabled)).toEqual(["get_video_generation_capabilities", "generate_video"]);
  });

  test("keeps its lazy skill absent unless the same executable boundary is enabled", () => {
    const manifest = new Manifest({ root: "/workspace", entries: {}, environment: {} });
    const disabled = lazySkillSourceWithPackSkills([], [], false, false);
    const enabled = lazySkillSourceWithPackSkills([], [], false, true);
    expect(disabled.getIndex?.(manifest, ".agents")?.map((entry) => entry.name)).not.toContain(
      "opengeni-video-generation",
    );
    expect(enabled.getIndex?.(manifest, ".agents")?.map((entry) => entry.name)).toContain(
      "opengeni-video-generation",
    );
  });
});
