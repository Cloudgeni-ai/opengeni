import { describe, expect, test } from "bun:test";
import {
  OAUTH_CLIENT_REQUIREMENTS,
  oauthClientRequirementsFingerprintInput,
  parseOAuthClientRequirements,
} from "./catalog-oauth-client-requirements";
import { curatedCatalogEntriesByMcpUrl } from "./catalog-curation";
import {
  catalogImportFingerprint,
  catalogRowToDbInput,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "./import-integrations-catalog";

const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
  .pathname;

const entry = {
  mcpUrl: "https://mcp.example.com/mcp",
  name: "Example",
  issuer: "https://auth.example.com",
  reason: "no_self_registration",
  evidence: "Metadata advertises neither DCR nor CIMD.",
  checkedAt: "2026-10-05",
};

describe("OAuth client requirements", () => {
  test("every committed entry matches an importable OAuth row and is stamped on it", async () => {
    const normalized = normalizeCatalogSnapshot(await readSnapshotFile(snapshotPath));
    expect(normalized.unmatchedOAuthClientRequirements).toEqual([]);
    const rows = new Map(normalized.rows.map((row) => [row.mcpUrl, row]));
    for (const requirement of OAUTH_CLIENT_REQUIREMENTS.entries) {
      const row = rows.get(requirement.mcpUrl);
      expect(row?.authKind).toBe("oauth2");
      expect(row?.oauthClientRequirement).toEqual({
        issuer: requirement.issuer,
        reason: requirement.reason,
      });
      expect(
        catalogRowToDbInput(row!, { importBatchId: crypto.randomUUID() }).metadata
          .oauthClientRequirement,
      ).toEqual({ issuer: requirement.issuer, reason: requirement.reason });
    }
    const unlisted = rows.get("https://mcp.linear.app/mcp");
    expect(unlisted?.oauthClientRequirement).toBeUndefined();
    expect(
      catalogRowToDbInput(unlisted!, { importBatchId: crypto.randomUUID() }).metadata,
    ).not.toHaveProperty("oauthClientRequirement");
  });

  test("featured connectors verified as unable to self-register are listed (OPE-580)", () => {
    const listed = new Set(OAUTH_CLIENT_REQUIREMENTS.entries.map((row) => row.mcpUrl));
    for (const mcpUrl of [
      "https://mcp.asana.com/v2/mcp",
      "https://mcp.hubspot.com/anthropic",
      "https://mcp.canva.com/mcp",
      "https://mcp.dropbox.com/chatgpt_app_mcp",
      "https://mcp.frontapp.com/mcp",
      "https://mcp.vercel.com/",
    ]) {
      expect(curatedCatalogEntriesByMcpUrl.get(mcpUrl)?.featured).toBe(true);
      expect(listed.has(mcpUrl)).toBe(true);
    }
    // Native Connect readiness owns these; listing them would double-gate.
    expect(listed.has("https://gmailmcp.googleapis.com/mcp/v1")).toBe(false);
    expect(listed.has("https://mcp.slack.com/mcp")).toBe(false);
  });

  test("the parser rejects malformed entries instead of dropping them", () => {
    const parse = (entries: unknown[]) => parseOAuthClientRequirements({ version: 1, entries });
    expect(parse([entry]).entries).toHaveLength(1);
    expect(() => parse([{ ...entry, mcpUrl: "https://MCP.example.com/mcp/" }])).toThrow(
      /canonical form/,
    );
    expect(() => parse([{ ...entry, issuer: "http://auth.example.com" }])).toThrow(/https/);
    expect(() => parse([{ ...entry, reason: "unknown" }])).toThrow(/unknown reason/);
    expect(() => parse([{ ...entry, featured: true }])).toThrow(/unknown key/);
    expect(() => parse([entry, entry])).toThrow(/duplicate/);
    expect(() => parseOAuthClientRequirements({ version: 2, entries: [] })).toThrow(/version/);
  });

  test("the import fingerprint tracks issuer and reason but not evidence wording", async () => {
    const base = parseOAuthClientRequirements({ version: 1, entries: [entry] });
    const reworded = parseOAuthClientRequirements({
      version: 1,
      entries: [{ ...entry, evidence: "Reworded.", checkedAt: "2026-11-01" }],
    });
    const reissued = parseOAuthClientRequirements({
      version: 1,
      entries: [{ ...entry, issuer: "https://other.example.com" }],
    });
    expect(oauthClientRequirementsFingerprintInput(reworded)).toBe(
      oauthClientRequirementsFingerprintInput(base),
    );
    const fingerprint = (oauthClientRequirements: typeof base) =>
      catalogImportFingerprint({ snapshotPath, oauthClientRequirements });
    expect(await fingerprint(reworded)).toBe(await fingerprint(base));
    expect(await fingerprint(reissued)).not.toBe(await fingerprint(base));
  });
});
