import { describe, expect, test } from "bun:test";
import { allAgentCapabilities, type ResolvedAgentConfig } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

import { inspectPersistentAgentInstructions, type AgentPromptResources } from "../../src/index";
import { ALL_RESOURCES } from "./prompt-sentences";

const RESOURCES: AgentPromptResources = {
  ...ALL_RESOURCES,
  repositoryIdentities: [
    { path: "repos/github.com/acme/private", identity: "personal", login: "octocat" },
    { path: "repos/github.com/acme/web", identity: "app" },
  ],
};

function config(identity: string | null): ResolvedAgentConfig {
  return {
    version: 1,
    from: "all",
    capabilities: allAgentCapabilities(),
    unavailable: [],
    identity,
    renderer: "opengeni",
    source: "request",
  };
}

describe("the operational contract names no product", () => {
  test("a host's identity is the only name the agent reads", () => {
    const inspection = inspectPersistentAgentInstructions(testSettings(), {
      agentConfig: config("You are Acme Assistant."),
      agentPromptResources: RESOURCES,
      codemodeAvailable: true,
      codeSearchAvailable: true,
    });
    // Prose only: tool names such as opengeni__goal_complete are identifiers.
    expect(inspection.composed.match(/Opengeni/gu)).toBeNull();
    expect(inspection.composed).toContain(
      "`repos/github.com/acme/web`: as the workspace's GitHub app. Work appears as its bot.",
    );
    expect(inspection.composed).toContain(
      "On GitHub app repositories, use the github_app__* tools.",
    );
    expect(inspection.composed).toContain(
      "Built-in workspace tools that store or send text (messages to other sessions",
    );
  });

  test("the default identity still introduces the agent", () => {
    const inspection = inspectPersistentAgentInstructions(testSettings(), {
      agentConfig: config(null),
      agentPromptResources: RESOURCES,
    });
    expect(inspection.layers[0]?.content).toContain("You are an Opengeni workspace agent");
    expect(inspection.layers.slice(1).some((layer) => layer.content.includes("Opengeni"))).toBe(
      false,
    );
  });
});
