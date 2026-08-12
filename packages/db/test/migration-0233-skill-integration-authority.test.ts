import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { stableJson } from "@opengeni/contracts";

const migration = await Bun.file(
  new URL("../drizzle/0233_skill_and_integration_authority_cutover.sql", import.meta.url),
).text();

describe("Skill and Integration authority maintenance cutover", () => {
  test("is a drained one-way authority activation", () => {
    expect(migration.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(migration).toContain("all opengeni_app sessions to be stopped");
    expect(migration).toContain(
      "Plugin, Integration, Skill, Pack, and Facet operations to be settled",
    );
    expect(migration).toContain("LOCK TABLE %I IN ACCESS EXCLUSIVE MODE");
  });

  test("embeds eight exact immutable curated Skill artifacts", () => {
    const match = migration.match(
      /\$skill_authority_seed\$\n([\s\S]+?)\n  \$skill_authority_seed\$::jsonb/u,
    );
    expect(match?.[1]).toBeTruthy();
    const seeds = JSON.parse(match![1]!) as Array<{
      library_id: string;
      capability_id: string;
      plugin_key: string;
      file_count: number;
      total_bytes: number;
      manifest: Record<string, unknown>;
      manifest_digest: string;
      files: Array<{
        path: string;
        content: string;
        byte_size: number;
        content_sha256: string;
      }>;
    }>;
    expect(seeds).toHaveLength(8);
    expect(new Set(seeds.map((seed) => seed.library_id)).size).toBe(seeds.length);
    for (const seed of seeds) {
      expect(seed.capability_id).toBe(`skill:${seed.library_id}`);
      expect(seed.plugin_key).toBe(`skill/library/${seed.library_id}`);
      expect(seed.files).toHaveLength(seed.file_count);
      expect(seed.files.reduce((total, file) => total + file.byte_size, 0)).toBe(seed.total_bytes);
      expect(sha256(stableJson(seed.manifest))).toBe(seed.manifest_digest);
      for (const file of seed.files) {
        expect(Buffer.byteLength(file.content, "utf8")).toBe(file.byte_size);
        expect(sha256(file.content)).toBe(file.content_sha256);
      }
    }
  });

  test("fails closed on ambiguous active Skill authority", () => {
    expect(migration).toContain("skill_authority_curated_selections");
    expect(migration).toContain("installation.metadata ->> 'libraryId' = seed.library_id");
    expect(migration).toContain("installation.metadata ->> 'contentSha256' = seed.content_sha256");
    expect(migration).toContain(
      "an active legacy Skill installation is neither an exact curated selection nor a valid normalized Skill projection",
    );
    expect(migration).toContain("curated Skill authority migration did not converge");
  });

  test("keeps PL/pgSQL identity variables out of SQL column lists", () => {
    expect(migration).toContain("INSERT INTO capability_plugin_versions (\n        plugin_id,");
    expect(migration).toContain("INSERT INTO capability_facets (\n        plugin_version_id,");
    expect(migration).toContain("INSERT INTO capability_skill_files (\n        skill_facet_id,");
    expect(migration).toContain(
      "INSERT INTO capability_plugin_installations (\n        account_id,\n        workspace_id,\n        plugin_id,\n        plugin_version_id,",
    );
    expect(migration).toContain(
      "INSERT INTO capability_component_owners (\n      account_id,\n      workspace_id,\n      facet_installation_id,",
    );
    expect(migration).not.toContain(
      "INSERT INTO capability_plugin_versions (\n        v_plugin_id,",
    );
    expect(migration).not.toContain(
      "INSERT INTO capability_facets (\n        v_plugin_version_id,",
    );
    expect(migration).not.toContain(
      "INSERT INTO capability_skill_files (\n        v_skill_facet_id,",
    );
    expect(migration).not.toContain(
      "INSERT INTO capability_component_owners (\n      account_id,\n      workspace_id,\n      v_facet_installation_id,",
    );
  });

  test("retires every non-MCP generic projection and fences future writes", () => {
    expect(migration).toContain("DELETE FROM capability_installations\nWHERE kind <> 'mcp';");
    expect(migration).toContain("DELETE FROM capability_catalog_items\nWHERE kind <> 'mcp';");
    expect(migration).toContain("capability_installations_kind_authority_chk");
    expect(migration).toContain("capability_catalog_items_kind_authority_chk");
    expect(migration).toContain("CHECK (kind = 'mcp') NOT VALID");
    expect(migration).toContain("generic Capability authority cutover did not converge");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
