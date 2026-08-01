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
        expect.objectContaining({
          path: "0001_first.sql",
          deploymentMode: "historical",
        }),
        expect.objectContaining({
          path: "0002_second.sql",
          deploymentMode: "rolling",
        }),
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
        (migrations.has("0117_sandbox_recovery_generations.sql") ? 1 : 0) +
        (migrations.has("0118_new_session_drafts.sql") ? 1 : 0) +
        (migrations.has("0119_pending_tool_output_policy.sql") ? 1 : 0) +
        (migrations.has("0120_durable_goal_wake.sql") ? 1 : 0) +
        (migrations.has("0121_goal_update_idempotency.sql") ? 1 : 0) +
        (migrations.has("0122_codex_capacity_same_turn.sql") ? 1 : 0) +
        (migrations.has("0123_session_tool_policy_version.sql") ? 1 : 0) +
        (migrations.has("0124_session_event_duplicate_lookup.sql") ? 1 : 0) +
        (migrations.has("0125_document_drops_visibility.sql") ? 1 : 0) +
        (migrations.has("0126_document_access_constraints.sql") ? 1 : 0) +
        (migrations.has("0127_document_default_base_index.sql") ? 1 : 0) +
        (migrations.has("0128_github_installation_authority.sql") ? 1 : 0) +
        (migrations.has("0129_retained_process_reconciliation.sql") ? 1 : 0) +
        (migrations.has("0130_workspace_instruction_policies.sql") ? 1 : 0) +
        (migrations.has("0131_slack_bot_install_and_post_idempotency.sql") ? 1 : 0) +
        (migrations.has("0132_connection_subject_isolation.sql") ? 1 : 0) +
        (migrations.has("0133_session_skills.sql") ? 1 : 0) +
        (migrations.has("0134_session_first_party_mcp_tools.sql") ? 1 : 0) +
        (migrations.has("0135_durable_machine_input_batches.sql") ? 1 : 0) +
        (migrations.has("0136_unified_session_tool_policy.sql") ? 1 : 0) +
        (migrations.has("0137_preference_registry.sql") ? 1 : 0) +
        (migrations.has("0138_sandbox_checkpoint_artifacts_and_deadlines.sql") ? 1 : 0) +
        (migrations.has("0139_codex_provider_artifact_invalidations.sql") ? 1 : 0) +
        (migrations.has("0140_sandbox_restore_and_reaper_fences.sql") ? 1 : 0) +
        (migrations.has("0141_social_connection_credentials.sql") ? 1 : 0) +
        (migrations.has("0142_sandbox_archive_capture_gate.sql") ? 1 : 0) +
        (migrations.has("0143_session_codex_compaction_mode.sql") ? 1 : 0) +
        (migrations.has("0144_sandbox_viewer_force_drain_gate.sql") ? 1 : 0) +
        (migrations.has("0145_model_call_facts.sql") ? 1 : 0) +
        (migrations.has("0146_slack_bot_delete_idempotency.sql") ? 1 : 0) +
        (migrations.has("0147_draft_latency_mode.sql") ? 1 : 0) +
        (migrations.has("0148_session_turn_latency_mode.sql") ? 1 : 0) +
        (migrations.has("0149_workspace_artifacts.sql") ? 1 : 0) +
        (migrations.has("0150_slack_task_interactions.sql") ? 1 : 0) +
        (migrations.has("0151_slack_delivery_backoff.sql") ? 1 : 0) +
        (migrations.has("0152_hierarchical_memory_foundation.sql") ? 1 : 0),
    );
    expect(contract.sha256).toBe(
      "8a8cfe345f4d749ce10b102fa4326a4d6293fa8e71807daed59f6c856f5949d2",
    );
    expect(contract.latestMigration).toBe("0152_hierarchical_memory_foundation.sql");
    expect(migrations.get("0152_hierarchical_memory_foundation.sql")).toMatchObject({
      sha256: "bf3c4ee84a4d9bce7503607d3f34c7046890e5daddeaf0f8390cbd06fb468cdc",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0151_slack_delivery_backoff.sql")).toMatchObject({
      sha256: "787a92127bb43c1beee6506c087e4bd9e53d933d06db2609afcd97e7c6642679",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0128_github_installation_authority.sql")).toMatchObject({
      sha256: "365793b2a204a70e214adb90298b522acbb6dcfae22a46681a58f41a6938e6f0",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0131_slack_bot_install_and_post_idempotency.sql")).toMatchObject({
      sha256: "b9516f61a23ecd363536f159bd772426a0da52eedfb8195a7b22f7be6a131bf2",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0132_connection_subject_isolation.sql")).toMatchObject({
      sha256: "c52786e8732b49d223db2bb1c9789455304ad2b8750fdb46f261fd1da04dab44",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0133_session_skills.sql")).toMatchObject({
      sha256: "f0aac6c242a4dbad8d6d717d09f15b295855030cf0a8979151f6928ea7ea6ff6",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0135_durable_machine_input_batches.sql")).toMatchObject({
      sha256: "c2d642594077a74956fd2eaa64fee8fafcd748ad432d2c9c6f4450019970617c",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0122_codex_capacity_same_turn.sql")).toMatchObject({
      sha256: "84e97abff7394d9fcca110012d9ceaede9ae683280a8a4a7335bcf9ec5d52d4e",
      deploymentMode: "maintenance",
    });

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
        .filter((path) => /^(?:010[3-9]|011[0-9]|012[0-9]|013[0-9]|014[0-9]|015[0-2])_/.test(path)),
    ).toEqual([
      "0103_host_export_root_session.sql",
      "0104_host_export_root_session_backfill.sql",
      ...currentMainMigrations,
      ...nestedDepthMigrations,
      "0117_sandbox_recovery_generations.sql",
      "0118_new_session_drafts.sql",
      "0119_pending_tool_output_policy.sql",
      "0120_durable_goal_wake.sql",
      "0121_goal_update_idempotency.sql",
      "0122_codex_capacity_same_turn.sql",
      "0123_session_tool_policy_version.sql",
      "0124_session_event_duplicate_lookup.sql",
      "0125_document_drops_visibility.sql",
      "0126_document_access_constraints.sql",
      "0127_document_default_base_index.sql",
      "0128_github_installation_authority.sql",
      "0129_retained_process_reconciliation.sql",
      "0130_workspace_instruction_policies.sql",
      "0131_slack_bot_install_and_post_idempotency.sql",
      "0132_connection_subject_isolation.sql",
      "0133_session_skills.sql",
      "0134_session_first_party_mcp_tools.sql",
      "0135_durable_machine_input_batches.sql",
      "0136_unified_session_tool_policy.sql",
      "0137_preference_registry.sql",
      "0138_sandbox_checkpoint_artifacts_and_deadlines.sql",
      "0139_codex_provider_artifact_invalidations.sql",
      "0140_sandbox_restore_and_reaper_fences.sql",
      "0141_social_connection_credentials.sql",
      "0142_sandbox_archive_capture_gate.sql",
      "0143_session_codex_compaction_mode.sql",
      "0144_sandbox_viewer_force_drain_gate.sql",
      "0145_model_call_facts.sql",
      "0146_slack_bot_delete_idempotency.sql",
      "0147_draft_latency_mode.sql",
      "0148_session_turn_latency_mode.sql",
      "0149_workspace_artifacts.sql",
      "0150_slack_task_interactions.sql",
      "0151_slack_delivery_backoff.sql",
      "0152_hierarchical_memory_foundation.sql",
    ]);
    expect(migrations.get("0143_session_codex_compaction_mode.sql")).toMatchObject({
      sha256: "574cfe6fc5ab24135e84d3932fd936e134ebe28bce8ac3cb5db97a549683906f",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0150_slack_task_interactions.sql")).toMatchObject({
      sha256: "97f23742bedcc0131ae21ba08a02eb8b5a739dafe790d22477622bf01746eaf6",
      deploymentMode: "rolling",
    });
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
    expect(migrations.get("0117_sandbox_recovery_generations.sql")).toMatchObject({
      sha256: "365284a9ab495173780d54c4b1470824891b15a7290735bf09b72c2f5fdbc48b",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0118_new_session_drafts.sql")).toMatchObject({
      sha256: "69ae71b80392eea964c47cadff876cff58db699d6c2470482d35aaf0931de70c",
      deploymentMode: "rolling",
    });
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
    expect(migrations.get("0123_session_tool_policy_version.sql")).toMatchObject({
      sha256: "d23abd0ea9ac21c114a397eaa2a6a524652b9554683dd8e68937ee232e22711e",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0124_session_event_duplicate_lookup.sql")).toMatchObject({
      sha256: "115dbd71c528c78d340cf3be476f2973db273740e8bcbf47196da96c2d9f94c1",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0125_document_drops_visibility.sql")).toMatchObject({
      sha256: "d2d9f0c7f4b5cc239df3d764d04e0b9fecf2ab9a37ade02735607393c03cb18f",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0126_document_access_constraints.sql")).toMatchObject({
      sha256: "0519e1050c51af5b2f1a02def53f20e5e1e116277d85811d0bfef9c567302dba",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0127_document_default_base_index.sql")).toMatchObject({
      sha256: "7deb5fde59f2e0e336a18a72630a00348dc641041f7df60639b50df79b4c4480",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0129_retained_process_reconciliation.sql")).toMatchObject({
      sha256: "913758633b31bb3a4f56dca19e7113630f5d12300d075827ac36179e79305dbd",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0130_workspace_instruction_policies.sql")).toMatchObject({
      sha256: "12226a4560dc1150ffe2c3549f821d2483cc4d4a09ef74747ed13376404fc7c5",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0134_session_first_party_mcp_tools.sql")).toMatchObject({
      sha256: "7255a5dfea703b00e01aeab6d003728e60ad7ff78c87af2dc61bd8dda456391e",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0136_unified_session_tool_policy.sql")).toMatchObject({
      sha256: "8a12370895795b1e8e2ef193a65c97592bf793a410ef6fcae9cc21162561feee",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0137_preference_registry.sql")).toMatchObject({
      sha256: "8197520ec68e685e2658b2d33f8daf64e03d1d4922fa9c3ccd97c6f73849c5c5",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0138_sandbox_checkpoint_artifacts_and_deadlines.sql")).toMatchObject({
      sha256: "c32c70ff47930c77f45482dc5f66b26b13dd444d440397837cca134f97c48e14",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0139_codex_provider_artifact_invalidations.sql")).toMatchObject({
      sha256: "977c161505854ef352ade74d396e3c2205e8d3391789fb3535973bd0d20f953b",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0140_sandbox_restore_and_reaper_fences.sql")).toMatchObject({
      sha256: "fe8441b669fd99fa0463378c34dd75ceca3077af7529c85c552a534c530828d8",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0141_social_connection_credentials.sql")).toMatchObject({
      sha256: "d5a032bd8c6b61c45f48793963185bcab964de88981eba66d32b4f9de74e8edf",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0142_sandbox_archive_capture_gate.sql")).toMatchObject({
      sha256: "48546fe4f106da0b36edf8a47da56e35b123fd0a63dc9c2eaed887756d35144f",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0144_sandbox_viewer_force_drain_gate.sql")).toMatchObject({
      sha256: "0b03627860a310eb27caa94cf7f67d614f0198a7a01d36b383c7874edba41b38",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0145_model_call_facts.sql")).toMatchObject({
      sha256: "93bb3f262f465ca2128b6dadc5e166bfdc78ded610e57a803ce1d3e6a8599dde",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0146_slack_bot_delete_idempotency.sql")).toMatchObject({
      sha256: "9084b0cd13c1924dd23af09b80d65b58223721259a23b1240e75f5af91b8cfb5",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0147_draft_latency_mode.sql")).toMatchObject({
      sha256: "8269cfad28f1fc8d943f55b89ef5715bc18e9817283ac3a36502127f12935fca",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0148_session_turn_latency_mode.sql")).toMatchObject({
      sha256: "fe753b8b5866c4f619ae3b360442659db26f639db867b622b1f2a0520e9c80dd",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0149_workspace_artifacts.sql")).toMatchObject({
      sha256: "ae3bdf08e8a47e04dd0b025f143b40b0e31f31c9e7b3eb51c0d21233be265bd3",
      deploymentMode: "maintenance",
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
