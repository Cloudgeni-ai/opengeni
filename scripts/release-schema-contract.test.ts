import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSchemaContract } from "./release-schema-contract";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("release schema contract", () => {
  test("is deterministic across creation order and classifies only executable SQL migrations", async () => {
    const first = await fixture([
      ["0002_second.sql", "-- deployment-mode: rolling\nselect 2;"],
      ["meta/_journal.json", '{"entries":[]}'],
      ["0001_first.sql", "select 1;"],
    ]);
    const second = await fixture([
      ["0001_first.sql", "select 1;"],
      ["meta/_journal.json", '{"entries":[]}'],
      ["0002_second.sql", "-- deployment-mode: rolling\nselect 2;"],
    ]);

    expect(await buildSchemaContract(first)).toEqual(await buildSchemaContract(second));
    expect(await buildSchemaContract(first)).toMatchObject({
      schemaVersion: 2,
      fileCount: 2,
      latestMigration: "0002_second.sql",
      migrations: [
        expect.objectContaining({ path: "0001_first.sql", deploymentMode: "historical" }),
        expect.objectContaining({ path: "0002_second.sql", deploymentMode: "rolling" }),
      ],
    });
  });

  test("changes when either a path or file content changes", async () => {
    const baseline = await fixture([["0001_a.sql", "ab"]]);
    const changedContent = await fixture([["0001_a.sql", "ac"]]);
    const changedPath = await fixture([["0001_b.sql", "ab"]]);

    const baselineHash = (await buildSchemaContract(baseline)).sha256;
    expect((await buildSchemaContract(changedContent)).sha256).not.toBe(baselineHash);
    expect((await buildSchemaContract(changedPath)).sha256).not.toBe(baselineHash);
  });

  test("rejects an unclassified migration in the governed deployment-mode era", async () => {
    const directory = await fixture([
      ["0062_historical.sql", "select 1;"],
      ["0063_classified.sql", "select 2;"],
    ]);

    await expect(buildSchemaContract(directory)).rejects.toThrow(
      "0063_classified.sql: classified migrations require -- deployment-mode: rolling or -- deployment-mode: maintenance on the first line",
    );
  });

  test("preserves published host-export history and appends the forward repair", async () => {
    const contract = await buildSchemaContract();
    const migrations = new Map(contract.migrations.map((migration) => [migration.path, migration]));
    const currentMainMigrations = [
      "0105_session_turn_instructions.sql",
      "0106_session_attempt_mcp_approval_policies.sql",
    ].filter((file) => migrations.has(file));

    expect(currentMainMigrations).toEqual(
      currentMainMigrations.length === 0
        ? []
        : ["0105_session_turn_instructions.sql", "0106_session_attempt_mcp_approval_policies.sql"],
    );
    expect(contract.fileCount).toBe(102 + currentMainMigrations.length);
    expect(contract.latestMigration).toBe("0113_nested_agent_depth_index.sql");
    expect(
      contract.migrations
        .map((migration) => migration.path)
        .filter((path) => /^(?:010[3-9]|011[0-3])_/.test(path)),
    ).toEqual([
      "0103_host_export_root_session.sql",
      "0104_host_export_root_session_backfill.sql",
      ...currentMainMigrations,
      "0107_host_export_lineage_contract.sql",
      "0108_nested_agent_depth_expand.sql",
      "0109_nested_agent_depth_backfill.sql",
      "0110_nested_agent_depth_boundary.sql",
      "0111_nested_agent_depth_contract.sql",
      "0112_nested_agent_depth_validate.sql",
      "0113_nested_agent_depth_index.sql",
    ]);
    expect(new Set(contract.migrations.map((migration) => migration.path)).size).toBe(
      contract.fileCount,
    );
    expect(migrations.get("0097_host_export_outbox.sql")).toMatchObject({
      sha256: "918763f2438efd06232f221305db6acac76e2bee5fa436e9665a860794c43d03",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0103_host_export_root_session.sql")).toMatchObject({
      sha256: "7a1a5c22bd7f0f5e38c5641257f709c99d7cfa0b4816fcdab2f8cbe0ba9db743",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0104_host_export_root_session_backfill.sql")).toMatchObject({
      sha256: "42d29994ac12b7118f0a1e3c252615509e887ee84bb1854056c9bf90e578760d",
      deploymentMode: "maintenance",
    });

    expect(migrations.get("0107_host_export_lineage_contract.sql")).toMatchObject({
      sha256: "82dfa0f18f59d6a6c65c02bdfca72d4e728cc67d12fb075a85b2233d7affe091",
      deploymentMode: "rolling",
    });
  });
});

async function fixture(files: Array<[string, string]>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-schema-contract-"));
  directories.push(directory);
  for (const [path, content] of files) {
    const absolutePath = join(directory, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return directory;
}
