import { describe, expect, test } from "bun:test";
import {
  ArchiveSiteRequest,
  CreateSiteRuntimeSessionRequest,
  PublishSiteRequest,
  SiteCapabilityManifest,
} from "../src/sites";

const manifest = {
  schemaVersion: 1 as const,
  ai: {
    enabled: true,
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    reasoningEffort: "medium" as const,
    instructions: "Answer from the approved workspace data.",
    monthlyBudgetMicros: 1_000_000,
  },
  integrations: {
    firstPartyPermissions: ["workspace:read", "documents:search"],
    firstPartyTools: ["memory_search"],
    mcpServers: [{ kind: "mcp" as const, id: "sinpat-docs", optional: false }],
    allowedPersonalConnectionServerIds: ["sinpat-docs"],
  },
  approvals: { writeActions: "platform_prompt" as const },
  access: { audience: "workspace" as const },
};

describe("Site contracts", () => {
  test("accepts one secret-free immutable release manifest", () => {
    expect(SiteCapabilityManifest.parse(manifest)).toEqual(manifest);
    expect(
      PublishSiteRequest.parse({
        operationId: crypto.randomUUID(),
        expectedCurrentReleaseId: null,
        artifactVersionId: crypto.randomUUID(),
        manifest,
        reason: "Initial local-data release",
      }).manifest.integrations.mcpServers[0]?.id,
    ).toBe("sinpat-docs");
  });

  test("rejects a default model outside the immutable allowlist", () => {
    expect(() =>
      SiteCapabilityManifest.parse({
        ...manifest,
        ai: { ...manifest.ai, defaultModel: "different" },
      }),
    ).toThrow();
  });

  test("carries only opaque personal authority and never a boolean ambient delegation", () => {
    const base = {
      operationId: crypto.randomUUID(),
      initialMessage: "Summarize the selected data.",
    };
    expect(() =>
      CreateSiteRuntimeSessionRequest.parse({
        ...base,
        connectionAuthorities: [
          { serverId: "sinpat-docs", connectionId: crypto.randomUUID(), userDelegation: true },
        ],
      }),
    ).toThrow();
    expect(CreateSiteRuntimeSessionRequest.parse(base)).toEqual(base);
  });

  test("requires CAS and a reason when archiving a stable Site identity", () => {
    expect(
      ArchiveSiteRequest.parse({
        operationId: crypto.randomUUID(),
        expectedCurrentReleaseId: crypto.randomUUID(),
        reason: "Reference run complete",
      }).reason,
    ).toBe("Reference run complete");
  });
});
