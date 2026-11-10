import { expect, test } from "bun:test";
import { allAgentCapabilities, type ResolvedAgentConfig } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniAgent, inspectPersistentAgentInstructions } from "../src";

const HEADING = "# Images and video";

function agentConfig(media: boolean): ResolvedAgentConfig {
  return {
    version: 1,
    from: "all",
    capabilities: { ...allAgentCapabilities(), media },
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };
}

function prompt(options: Parameters<typeof buildOpenGeniAgent>[2]): string {
  const instructions = buildOpenGeniAgent(
    testSettings({ sandboxBackend: "none" }),
    [],
    options,
  ).instructions;
  if (typeof instructions !== "string") throw new Error("instructions are not a string");
  return instructions;
}

// The media guidance describes the image and video tools, so a build that
// attaches none of them leaves it out; any one of them keeps it.
test("the media guidance follows the attached media tools", () => {
  expect(prompt({ agentConfig: agentConfig(true) })).not.toContain(HEADING);
  expect(
    prompt({
      agentConfig: agentConfig(true),
      imageGeneration: {
        kind: "provider_adapter",
        execute: async () => ({ type: "generated_image", artifact: { artifactId: "a" } }),
      },
    }),
  ).toContain(HEADING);
  expect(
    prompt({
      agentConfig: agentConfig(true),
      videoGeneration: {
        getCapabilities: async () => ({}),
        generate: async () => ({}),
      } as unknown as NonNullable<Parameters<typeof buildOpenGeniAgent>[2]>["videoGeneration"],
    }),
  ).toContain(HEADING);
  // Media off has no guidance either way.
  expect(prompt({ agentConfig: agentConfig(false) })).not.toContain(HEADING);
});

test("inspection without a tool surface keeps the guidance", () => {
  const inspected = inspectPersistentAgentInstructions(testSettings({ sandboxBackend: "none" }), {
    agentConfig: agentConfig(true),
  }).composed;
  expect(inspected).toContain(HEADING);
});
