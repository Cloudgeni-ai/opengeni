import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import { connectorTakesOnlyPersonalAccounts } from "@opengeni/contracts/personal-integration-setup";
import { searchCapabilityCatalogItems } from "@opengeni/core";
import {
  catalogRowToDbInput,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "../../../scripts/import-integrations-catalog";
import {
  pluginCapabilityItems,
  pluginsNotCoveredByConnectors,
} from "../src/integrations/marketplace-plugin-catalog";
import {
  OFFICIAL_DRIVE_MCP_URL,
  OFFICIAL_GMAIL_MCP_URL,
  OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
  OFFICIAL_SLACK_MCP_URL,
  builtInOAuthProfileFor,
} from "../src/integrations/oauth-profiles";

const SNAPSHOT = fileURLToPath(
  new URL("../../../data/catalog/integrations-snapshot.json", import.meta.url),
);

/** The Gmail connector as the committed snapshot and curated overlay import it. */
async function importedGmail(): Promise<CapabilityCatalogItem> {
  const normalized = normalizeCatalogSnapshot(await readSnapshotFile(SNAPSHOT));
  const row = normalized.rows.find((candidate) => candidate.mcpUrl === OFFICIAL_GMAIL_MCP_URL);
  if (!row) throw new Error("the committed catalog has no Gmail connector");
  const input = catalogRowToDbInput(row, { importBatchId: "test" });
  return CapabilityCatalogItem.parse({
    id: input.id,
    kind: "mcp",
    source: "registry",
    name: input.name,
    description: input.description,
    category: input.category,
    tags: input.tags,
    providerDomain: input.providerDomain,
    mcpUrl: input.mcpUrl,
    authKind: input.authKind,
    tier: input.tier,
    metadata: input.metadata,
  });
}

describe("an agent looking for the person's email", () => {
  test("finds their own Gmail connection first, and no workspace-wide Gmail plugin", async () => {
    const gmail = await importedGmail();
    const candidates = [
      gmail,
      ...pluginsNotCoveredByConnectors(pluginCapabilityItems(new Set()), [gmail]),
    ];
    for (const query of [
      "check my email",
      "check email",
      "read my email",
      "email",
      "inbox",
      "mail",
      "Gmail",
      "Gmail inbox",
    ]) {
      const ranked = searchCapabilityCatalogItems(candidates, query, 8);
      expect({ query, first: ranked[0]?.item.id }).toEqual({ query, first: gmail.id });
      expect(ranked.map(({ item }) => item.id)).not.toContain("plugin:marketplace/openai/gmail");
    }
  });

  test("a plugin stays when it adds Skills, is installed, or no connector covers its servers", () => {
    const gmail = CapabilityCatalogItem.parse({
      id: "mcp:gmail",
      kind: "mcp",
      source: "built_in",
      name: "Gmail",
      mcpUrl: OFFICIAL_GMAIL_MCP_URL,
    });
    const plugins = pluginCapabilityItems(new Set());
    const wrapper = plugins.find((item) => item.id === "plugin:marketplace/openai/gmail");
    expect(wrapper?.metadata).toMatchObject({
      skills: [],
      mcpServerUrls: [OFFICIAL_GMAIL_MCP_URL],
    });
    const withSkill = { ...wrapper!, metadata: { ...wrapper!.metadata, skills: ["triage"] } };
    const installed = { ...wrapper!, enabled: true };
    expect(pluginsNotCoveredByConnectors([wrapper!, withSkill, installed], [gmail])).toEqual([
      withSkill,
      installed,
    ]);
    // Without the connector in this workspace's catalog the plugin is still offered.
    expect(pluginsNotCoveredByConnectors([wrapper!], [])).toEqual([wrapper!]);
    // Every other indexed plugin is unaffected by the Gmail connector.
    expect(pluginsNotCoveredByConnectors(plugins, [gmail])).toHaveLength(plugins.length - 1);
  });
});

test("the connectors cards treat as personal-only are exactly those the API refuses to share", () => {
  for (const mcpUrl of [
    OFFICIAL_GMAIL_MCP_URL,
    OFFICIAL_DRIVE_MCP_URL,
    OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
    OFFICIAL_SLACK_MCP_URL,
  ]) {
    const required = builtInOAuthProfileFor({ mcpUrl })?.requiredOwnership?.ownership;
    expect({ mcpUrl, personalOnly: connectorTakesOnlyPersonalAccounts({ mcpUrl }) }).toEqual({
      mcpUrl,
      personalOnly: required === "personal",
    });
  }
});
