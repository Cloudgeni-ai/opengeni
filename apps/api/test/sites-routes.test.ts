import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  assertSitesEnabled,
  siteRuntimeFirstPartyPermissions,
  validateSiteManifestRuntimeAuthority,
} from "../src/routes/sites";

const aiOnlyManifest = {
  schemaVersion: 1 as const,
  ai: {
    enabled: true,
    defaultModel: "scripted-model",
    allowedModels: ["scripted-model"],
    reasoningEffort: "medium" as const,
    instructions: "Answer from approved context.",
    monthlyBudgetMicros: 1_000_000,
  },
  integrations: {
    firstPartyPermissions: [],
    firstPartyTools: [],
    mcpServers: [],
    allowedPersonalConnectionServerIds: [],
  },
  approvals: { writeActions: "deny" as const },
  access: { audience: "workspace" as const },
};

describe("Site route boundary", () => {
  test("is invisible unless its independent deployment flag is enabled", () => {
    expect(() => assertSitesEnabled({})).toThrow();
    expect(() => assertSitesEnabled({ sitesEnabled: false })).toThrow();
    expect(() => assertSitesEnabled({ sitesEnabled: true })).not.toThrow();
  });

  test("freezes approval policy before admitting the first durable AI turn", async () => {
    const source = await readFile(new URL("../src/routes/sites.ts", import.meta.url), "utf8");
    const shell = source.indexOf('startMode: "realtime"');
    const approval = source.indexOf("updateSessionMcpApprovalPolicy", shell);
    const initialTurn = source.indexOf("acceptSessionUserMessage", approval);
    expect(shell).toBeGreaterThan(0);
    expect(approval).toBeGreaterThan(shell);
    expect(initialTurn).toBeGreaterThan(approval);
    expect(source).toContain("Site monthly AI budget is exhausted");
    expect(source).toContain("allowedPersonalConnectionServerIds");
  });

  test("admits AI-only Sites without manufacturing a visible first-party tool", () => {
    expect(siteRuntimeFirstPartyPermissions([], [])).toBeUndefined();
    expect(siteRuntimeFirstPartyPermissions(["workspace:read"], ["memory_search"])).toEqual([
      "workspace:read",
    ]);
    expect(() => siteRuntimeFirstPartyPermissions([], ["memory_search"])).toThrow(
      "must declare first-party permissions",
    );
    expect(validateSiteManifestRuntimeAuthority(aiOnlyManifest).firstPartyMcpPermissions).toBe(
      undefined,
    );
  });

  test("rejects unsupported and incoherent capabilities before publication", () => {
    expect(() =>
      validateSiteManifestRuntimeAuthority({
        ...aiOnlyManifest,
        integrations: { ...aiOnlyManifest.integrations, firstPartyTools: ["not_a_tool"] },
      }),
    ).toThrow("unsupported capability");
    expect(() =>
      validateSiteManifestRuntimeAuthority({
        ...aiOnlyManifest,
        integrations: {
          ...aiOnlyManifest.integrations,
          mcpServers: [{ kind: "mcp", id: "crm" }],
          allowedPersonalConnectionServerIds: ["other"],
        },
        approvals: { writeActions: "platform_prompt" },
      }),
    ).toThrow("must be a subset");
    expect(() =>
      validateSiteManifestRuntimeAuthority({
        ...aiOnlyManifest,
        integrations: {
          ...aiOnlyManifest.integrations,
          mcpServers: [{ kind: "mcp", id: "crm" }],
        },
      }),
    ).toThrow("denies write-capable");
  });
});
