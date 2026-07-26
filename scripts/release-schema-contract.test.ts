import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSchemaContract } from "./release-schema-contract";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("release schema contract", () => {
  test("classifies the Codex quota owning-human cutover as maintenance-only", async () => {
    const contract = await buildSchemaContract();
    expect(
      contract.migrations.find(
        (migration) => migration.path === "0065_codex_subscription_overview.sql",
      ),
    ).toMatchObject({ deploymentMode: "maintenance" });
  });

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
    expect(migrations.get("0065_codex_subscription_overview.sql")).toMatchObject({
      deploymentMode: "maintenance",
    });
    // Current main carries this independently published migration, while the
    // nested-depth branch was cut before it landed. Account for it explicitly
    // instead of renumbering the nested-depth chain or freezing main.
    const currentMainToolPolicyMigration = "0065_session_tool_policy.sql";
    expect(migrations.has(currentMainToolPolicyMigration)).toBe(true);
    expect(migrations.get(currentMainToolPolicyMigration)).toMatchObject({
      deploymentMode: "rolling",
    });
    const currentMainMigrations = [
      "0105_session_turn_instructions.sql",
      "0106_session_attempt_mcp_approval_policies.sql",
      "0107_host_export_lineage_contract.sql",
      "0108_fence_invalidated_warming_epochs.sql",
    ].filter((file) => migrations.has(file));

    expect(currentMainMigrations).toEqual(
      currentMainMigrations.length === 0
        ? []
        : [
            "0105_session_turn_instructions.sql",
            "0106_session_attempt_mcp_approval_policies.sql",
            ...(currentMainMigrations.includes("0107_host_export_lineage_contract.sql")
              ? ["0107_host_export_lineage_contract.sql"]
              : []),
            ...(currentMainMigrations.includes("0108_fence_invalidated_warming_epochs.sql")
              ? ["0108_fence_invalidated_warming_epochs.sql"]
              : []),
          ],
    );
    const nestedDepthMigrations = [
      "0109_nested_agent_depth_expand.sql",
      "0110_nested_agent_depth_boundary.sql",
      "0111_nested_agent_depth_backfill.sql",
      "0112_nested_agent_depth_contract.sql",
      "0113_nested_agent_depth_validate.sql",
      "0114_nested_agent_depth_contract.sql",
      "0115_nested_agent_depth_validate.sql",
      "0116_nested_agent_depth_index.sql",
    ].filter((file) => migrations.has(file));
    expect(nestedDepthMigrations).toEqual(
      [
        "0109_nested_agent_depth_expand.sql",
        "0110_nested_agent_depth_boundary.sql",
        "0111_nested_agent_depth_backfill.sql",
        "0112_nested_agent_depth_contract.sql",
        "0113_nested_agent_depth_validate.sql",
        "0114_nested_agent_depth_contract.sql",
        "0115_nested_agent_depth_validate.sql",
        "0116_nested_agent_depth_index.sql",
      ].filter((file) => migrations.has(file)),
    );
    expect(contract.fileCount).toBe(
      108 +
        (migrations.has(currentMainToolPolicyMigration) ? 1 : 0) +
        (migrations.has("0119_pending_tool_output_policy.sql") ? 1 : 0) +
        2,
    );
    expect(contract.sha256).toBe(
      "bafe3d985ebdda3617f9d2d6136222fa5a0178864325df18297ba90c97fb2e4f",
    );
    expect(contract.latestMigration).toBe("0121_goal_update_idempotency.sql");

    const boundarySql = await readFile(
      join(import.meta.dir, "../packages/db/drizzle/0110_nested_agent_depth_boundary.sql"),
      "utf8",
    );
    const sourceTableLock = boundarySql.indexOf(
      'LOCK TABLE "workspaces", "sessions", "session_spawn_denials" IN SHARE MODE;',
    );
    const guardInstall = boundarySql.indexOf(
      "CREATE TRIGGER session_idempotency_guard BEFORE INSERT",
    );
    const firstLedgerReconciliation = boundarySql.indexOf(
      'INSERT INTO "session_create_idempotency_guard"',
    );
    expect(sourceTableLock).toBeGreaterThanOrEqual(0);
    expect(guardInstall).toBeGreaterThan(sourceTableLock);
    expect(firstLedgerReconciliation).toBeGreaterThan(sourceTableLock);
    expect(boundarySql.indexOf("DO $reconcile$", sourceTableLock)).toBeGreaterThan(sourceTableLock);
    expect(
      contract.migrations
        .map((migration) => migration.path)
        .filter((path) => /^(?:010[3-9]|011[0-6]|0119|012[01])_/.test(path)),
    ).toEqual([
      "0103_host_export_root_session.sql",
      "0104_host_export_root_session_backfill.sql",
      ...currentMainMigrations,
      ...nestedDepthMigrations,
      "0119_pending_tool_output_policy.sql",
      "0120_durable_goal_wake.sql",
      "0121_goal_update_idempotency.sql",
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
    if (migrations.has("0107_host_export_lineage_contract.sql")) {
      expect(migrations.get("0107_host_export_lineage_contract.sql")).toMatchObject({
        sha256: "82dfa0f18f59d6a6c65c02bdfca72d4e728cc67d12fb075a85b2233d7affe091",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0108_fence_invalidated_warming_epochs.sql")) {
      expect(migrations.get("0108_fence_invalidated_warming_epochs.sql")).toMatchObject({
        sha256: "5039f21076d55cdf7acc45c613ca5c422ed21eecb84ee9725bfa8d9eeb78810f",
        deploymentMode: "rolling",
      });
    }
    expect(migrations.get("0119_pending_tool_output_policy.sql")).toMatchObject({
      sha256: "a70e7f605cf4f2c5677e30ccf80f29674107fc88d346c9fdc0882e0b9f314c25",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0120_durable_goal_wake.sql")).toMatchObject({
      sha256: "5c24fb49679513e2a7cc387e738b2bbdc9b5b3f465c023ea97921882f035d983",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0121_goal_update_idempotency.sql")).toMatchObject({
      sha256: "e90f030e9dfb3c2dc040b2192cdd874fad264020f06b9c82f1c3dcd30a9769ca",
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
