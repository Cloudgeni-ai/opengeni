import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { SEEDANCE_2_5_MODEL_ID } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
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
    expect(disabled.index.map((entry) => entry.name)).not.toContain("video-generation");
    expect(enabled.index.map((entry) => entry.name)).toContain("video-generation");
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
      "video-generation",
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

  test("returns an unavailable answer from both tools as normal tool output", async () => {
    const off = {
      schemaVersion: 1 as const,
      status: "unavailable" as const,
      code: "video_generation_off" as const,
      message: "Video generation is off in this workspace.",
      operationCreated: false as const,
    };
    const agent = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "none", webSearchEnabled: false }),
      [],
      {
        humanInputEnabled: false,
        videoGeneration: { capabilities: async () => off, execute: async () => off },
      },
    );
    const tools = (
      agent as unknown as {
        tools: Array<{
          name: string;
          invoke: (context: unknown, input: string, details: unknown) => Promise<unknown>;
        }>;
      }
    ).tools;
    const invoke = async (name: string, input: unknown) =>
      await tools
        .find((candidate) => candidate.name === name)!
        .invoke(undefined, JSON.stringify(input), { toolCall: { callId: `call-${name}` } });
    await expect(invoke("get_video_generation_capabilities", {})).resolves.toEqual(off);
    await expect(invoke("generate_video", { prompt: "animate" })).resolves.toEqual(off);
  });

  test("attaching the video tools leaves the system prompt byte-identical", async () => {
    const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
    const prompt = async (withVideo: boolean) =>
      await buildOpenGeniAgent(settings, [], {
        humanInputEnabled: false,
        skillCatalog: [],
        ...(withVideo
          ? {
              videoGeneration: {
                capabilities: async () => capabilities,
                execute: async (_input, context) => ({
                  schemaVersion: 1 as const,
                  status: "accepted" as const,
                  operationId: context.toolCallId,
                }),
              },
            }
          : {}),
      }).getSystemPrompt(new RunContext({}));
    const without = await prompt(false);
    expect(without).toBeTruthy();
    expect(await prompt(true)).toBe(without);
  });
});
