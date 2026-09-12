import { describe, expect, test } from "bun:test";
import { SEEDANCE_2_5_MODEL_ID } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, composeRuntimeSkills, runtimeSkillIndexForAgent } from "../src";

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
    // Default document-parsing guidance remains readable without video tools.
    expect(names(disabled)).toEqual(["skill_read"]);
    expect(names(enabled)).toEqual([
      "get_video_generation_capabilities",
      "generate_video",
      "skill_read",
    ]);
  });

  test("keeps its Skill absent unless the same executable boundary is enabled", () => {
    const disabled = composeRuntimeSkills([]);
    const enabled = composeRuntimeSkills([], {
      editableArtifacts: false,
      sites: false,
      videoGeneration: true,
    });
    expect(disabled.index.map((entry) => entry.name)).not.toContain("opengeni-video-generation");
    expect(enabled.index.map((entry) => entry.name)).toContain("opengeni-video-generation");
  });

  test("keeps video tools and server-readable guidance on connected machines", () => {
    const agent = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "selfhosted", webSearchEnabled: false }),
      [],
      {
        humanInputEnabled: false,
        activeSandboxBackend: "selfhosted",
        sandboxWorkspaceRoot: "/srv/project",
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
    const toolNames = (agent as unknown as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );

    expect(toolNames).toEqual([
      "get_video_generation_capabilities",
      "generate_video",
      "skill_read",
    ]);
    expect(runtimeSkillIndexForAgent(agent).map((entry) => entry.name)).toContain(
      "opengeni-video-generation",
    );
  });

  test("returns pre-admission reference rejection as normal tool output", async () => {
    const agent = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "none", webSearchEnabled: false }),
      [],
      {
        humanInputEnabled: false,
        videoGeneration: {
          capabilities: async () => capabilities,
          execute: async () => ({
            schemaVersion: 1,
            status: "rejected",
            code: "reference_not_stable",
            message: "Use the exact current /workspace path and try again.",
            operationCreated: false,
          }),
        },
      },
    );
    const tool = (
      agent as unknown as {
        tools: Array<{
          name: string;
          invoke: (context: unknown, input: string, details: unknown) => Promise<unknown>;
        }>;
      }
    ).tools.find((candidate) => candidate.name === "generate_video");
    if (!tool) throw new Error("generate_video tool missing");

    await expect(
      tool.invoke(undefined, JSON.stringify({ prompt: "animate" }), {
        toolCall: { callId: "call-rejected-reference" },
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      status: "rejected",
      code: "reference_not_stable",
      message: "Use the exact current /workspace path and try again.",
      operationCreated: false,
    });
  });
});
