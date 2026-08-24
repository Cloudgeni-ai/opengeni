import { describe, expect, test } from "bun:test";
import { SEEDANCE_2_5_MODEL_ID } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { Manifest } from "@openai/agents/sandbox";
import { buildOpenGeniAgent, composeRuntimeSkills } from "../src";

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
    const manifest = new Manifest({
      root: "/workspace",
      entries: {},
      environment: {},
    });
    const disabled = composeRuntimeSkills([]).lazySource;
    const enabled = composeRuntimeSkills([], {
      editableArtifacts: false,
      videoGeneration: true,
    }).lazySource;
    expect(disabled.getIndex?.(manifest, ".agents")?.map((entry) => entry.name)).not.toContain(
      "opengeni-video-generation",
    );
    expect(enabled.getIndex?.(manifest, ".agents")?.map((entry) => entry.name)).toContain(
      "opengeni-video-generation",
    );
  });

  test("keeps video tools but does not advertise an undeliverable skill on connected machines", () => {
    const manifest = new Manifest({
      root: "/workspace",
      entries: {},
      environment: {},
    });
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
    const skillsCapability = (
      agent as unknown as {
        capabilities: Array<{
          type: string;
          lazyFrom?: {
            getIndex?: (manifest: Manifest, skillsPath: string) => Array<{ name: string }>;
          };
        }>;
      }
    ).capabilities.find((capability) => capability.type === "skills");
    const skillNames =
      skillsCapability?.lazyFrom?.getIndex?.(manifest, ".agents").map((entry) => entry.name) ?? [];
    const toolNames = (agent as unknown as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );

    expect(toolNames).toEqual(["get_video_generation_capabilities", "generate_video"]);
    expect(skillNames).not.toContain("opengeni-video-generation");
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
