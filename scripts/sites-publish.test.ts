import { describe, expect, test } from "bun:test";
import { parseSitePublisherConfig } from "./sites-publish";

const id = "11111111-1111-4111-8111-111111111111";
const manifest = {
  schemaVersion: 1,
  ai: {
    enabled: true,
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    reasoningEffort: "medium",
    instructions: "Use only approved local data.",
    monthlyBudgetMicros: null,
  },
  integrations: {
    firstPartyPermissions: ["workspace:read", "documents:search"],
    firstPartyTools: ["memory_search"],
    mcpServers: [],
    allowedPersonalConnectionServerIds: [],
  },
  approvals: { writeActions: "platform_prompt" },
  access: { audience: "workspace" },
};

describe("Sites publisher", () => {
  test("accepts a credential-free static Site config", () => {
    const parsed = parseSitePublisherConfig({
      schemaVersion: 1,
      apiUrl: "https://opengeni.local",
      workspaceId: id,
      operationId: id,
      sourceHtml: "deploy/examples/sites/sintef-local-data/index.html",
      title: "SINTEF Materials Explorer",
      manifest,
      apiKeyEnvironment: "OPENGENI_SITES_PUBLISH_API_KEY",
    });
    expect(parsed.manifest.ai.instructions).toContain("approved local data");
    expect(JSON.stringify(parsed)).not.toMatch(/apiKey\s*:/iu);
  });

  test("rejects credential-shaped or unknown configuration", () => {
    expect(() =>
      parseSitePublisherConfig({
        schemaVersion: 1,
        apiUrl: "https://opengeni.local",
        workspaceId: id,
        operationId: id,
        sourceHtml: "index.html",
        title: "Site",
        manifest,
        apiKeyEnvironment: "OPENGENI_SITES_PUBLISH_API_KEY",
        apiKey: "do-not-store-this",
      }),
    ).toThrow("unknown Site publisher config field");
  });
});
