import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSchemaContract } from "./release-schema-contract";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("release schema contract", () => {
  test("installs the workspace activity initializer before its conflict-safe backfill", async () => {
    const migration = await readFile(
      join(import.meta.dir, "../packages/db/drizzle/0214_session_activity_commit_gate.sql"),
      "utf8",
    );
    const scopedInitializer = migration.indexOf(
      "CREATE OR REPLACE FUNCTION opengeni_private.ensure_workspace_session_activity_revision(",
    );
    const initializer = migration.indexOf(
      "CREATE OR REPLACE FUNCTION opengeni_private.initialize_workspace_session_activity_revision()",
    );
    const trigger = migration.indexOf(
      "CREATE TRIGGER workspaces_initialize_session_activity_revision",
    );
    const backfill = migration.indexOf(
      "SELECT opengeni_private.ensure_workspace_session_activity_revision(",
      trigger,
    );

    expect(scopedInitializer).toBeGreaterThanOrEqual(0);
    expect(initializer).toBeGreaterThan(scopedInitializer);
    expect(trigger).toBeGreaterThan(initializer);
    expect(backfill).toBeGreaterThan(trigger);
    expect(migration.slice(scopedInitializer, initializer)).toContain(
      "set_config('opengeni.account_id', target_account_id::text, true)",
    );
    expect(migration.slice(scopedInitializer, initializer)).toContain(
      "set_config('opengeni.workspace_id', target_workspace_id::text, true)",
    );
    expect(migration.slice(scopedInitializer, initializer)).toContain(
      "ON CONFLICT (workspace_id) DO NOTHING",
    );
    expect(migration.slice(initializer, trigger)).toContain(
      "opengeni_private.ensure_workspace_session_activity_revision(",
    );
    expect(migration.slice(backfill)).toContain('FROM "workspaces"');
  });

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
    const completeSourceContract = await buildSchemaContract();
    const companyBrainMigrationPaths = [
      "0238_goal_persistence_policy.sql",
      "0239_task_tree_notes.sql",
    ].filter((path) =>
      completeSourceContract.migrations.some((migration) => migration.path === path),
    );
    const companyBrainMigrations = new Map(
      completeSourceContract.migrations.map((migration) => [migration.path, migration]),
    );
    const goalPersistence = companyBrainMigrations.get("0238_goal_persistence_policy.sql");
    if (goalPersistence) {
      expect(goalPersistence).toMatchObject({ deploymentMode: "rolling" });
    }
    const taskTreeNotes = companyBrainMigrations.get("0239_task_tree_notes.sql");
    if (taskTreeNotes) {
      expect(taskTreeNotes).toMatchObject({ deploymentMode: "rolling" });
    }
    const appendedMigrationPaths = [
      "0237_interaction_transition_reaper.sql",
      "0238_supergrok_realtime_model.sql",
      "0239_supergrok_video_funding.sql",
    ].filter((path) =>
      completeSourceContract.migrations.some((migration) => migration.path === path),
    );
    const forwardMigrationPaths = [...companyBrainMigrationPaths, ...appendedMigrationPaths];
    const sourceContract =
      forwardMigrationPaths.length > 0
        ? await contractWithoutMigrations(forwardMigrationPaths)
        : completeSourceContract;
    const transitionReaper = completeSourceContract.migrations.find(
      (migration) => migration.path === "0237_interaction_transition_reaper.sql",
    );
    if (transitionReaper) {
      expect(transitionReaper).toMatchObject({ deploymentMode: "maintenance" });
    }
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0238_supergrok_realtime_model.sql",
      ),
    ).toMatchObject({
      sha256: "1992505e5994cbef2d650b0eebae2a6c033b567ecbb9cf27301846c500dea66a",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0239_supergrok_video_funding.sql",
      ),
    ).toMatchObject({
      sha256: "fbe4c79cb20c809767dad12e697ab6ad1becfc8b03eb314cbda38d6069a258f1",
      deploymentMode: "rolling",
    });
    const migrations = new Map(
      sourceContract.migrations.map((migration) => [migration.path, migration]),
    );
    const sessionVisibilityContractHash = (includesActivation: boolean): string | null => {
      if (!migrations.has("0236_session_visibility_slack_policy.sql")) return null;
      if (migrations.has("0238_recover_unclaimed_session_turns.sql")) {
        if (migrations.has("0242_google_drive_account_admin_authority.sql")) {
          return includesActivation
            ? "b5d39816a02b26fe22959a4f38a1493aa8a8a33df3107835a09f211cf81e5c7e"
            : "da3ec4154e52954b78e1712b75b9b58211a4731aa82fad9e6615afd3ea9f325f";
        }
        return includesActivation
          ? "67209db60dbc5556cd8ec6bd89fdc037ecf12f27a16ceb2739d179b623126b0b"
          : "da3ec4154e52954b78e1712b75b9b58211a4731aa82fad9e6615afd3ea9f325f";
      }
      if (migrations.has("0228_interaction_controller_data_plane.sql")) {
        return includesActivation
          ? "2f0bfa7a465e47bbca27a79cc594f953e59a94e42ff704ab11e258523d19ad42"
          : "712d1680b4aa6e22346fc2f2ef33458543e8fcd0025b5d793d996ef5ec586452";
      }
      if (migrations.has("0229_slack_inbox_file_fact.sql")) {
        return includesActivation
          ? "b681853738c32371ca30328ccc1c3ceb9d8e767f84855f82d6abba334a62f38d"
          : "d734d6198dfc91728f3e05ec5c3bc4e69cedb02b656697b6ecbf35f607ed4571";
      }
      return includesActivation
        ? "0a3c326f21e67422bdc84e9409d72b489aac967e18b08fbc7a410aab51cb17af"
        : "d54a4ac5b800e0c0578e7fce7d1a09cea1dbed87d3b13bf722549fea0bdc031e";
    };
    const currentMainContractHash = migrations.has("0235_canonical_human_login_bindings.sql")
      ? migrations.has("0234_xai_subscription_authority.sql")
        ? migrations.has("0223_pending_tool_event_output.sql")
          ? "94db34c0bd7ee7a3fe9c7a44f7e2705de9bdbe39d1503fa79ec52b024d71ad42"
          : "5450adec25b4684b082ce97c0ab5ce76f33b15de2e943945b5e73534ff67be82"
        : migrations.has("0223_pending_tool_event_output.sql")
          ? "bdf9243aad43605eb2cc380992f564a706aa06ffea885854f6be5911abe2f5c3"
          : "e0f7b19f681fee92ea7813660fee0227fef4ed885032a134f36b399591888d8c"
      : migrations.has("0234_xai_subscription_authority.sql")
        ? migrations.has("0223_pending_tool_event_output.sql")
          ? "f6370d47ee43da07781d21a67fe07ffb353c9c8ea4e22ec3bf75ba3793f7634a"
          : "035c70dfee83fe5b0962697bf7167bfd09b77d69ea3d3b0e25907998f58d7005"
        : migrations.has("0233_skill_and_integration_authority_cutover.sql")
          ? migrations.has("0223_pending_tool_event_output.sql")
            ? "2ec6043704c9f0b8c635ff989d5155e2f047a2377b6a8784139c98b006bcc487"
            : "03b2633febc6805e697fb5aa2002136a80c8699181f9b4c65b3b559ef6726d18"
          : migrations.has("0232_integration_facet_authority_cutover.sql")
            ? "329a693f62feec5c85716be710791c98c24933796f542a33fae8af82ccfba927"
            : migrations.has("0231_integration_definition_identity_cutover.sql")
              ? "4fe8a5b026a6e87309d8881e0fef4f06de895b3e9960d63a82f1bb0ad5200a10"
              : migrations.has("0229_slack_inbox_file_fact.sql")
                ? "f2210d9386b75dd644419fec0e69cf7157529fad0c4a81237dad7798bd4959b6"
                : migrations.has("0228_slack_task_policy.sql")
                  ? migrations.has("0226_personal_codex_authority_foundation.sql")
                    ? "7b7fd3a19e1e2a9b5cf98b8ad8e5720f1e3c329ad42f9f012172b028c26e8363"
                    : "bbedea10fef52aeaf32d6e16c27d1042a9f68483ba54c241f5184659e86b3c89"
                  : migrations.has("0227_slack_native_actions.sql")
                    ? migrations.has("0226_personal_codex_authority_foundation.sql")
                      ? "fb41447bb063da5239197ceb5dc0c179427cc08f6593b77e5c18b98f85804dab"
                      : "32e38ffe1fce657245e30bf413e594f84d967ef68ff9bc4cbd8e08e2bb5ebffc"
                    : migrations.has("0226_personal_codex_authority_foundation.sql")
                      ? migrations.has("0224_slack_post_outcome_reconciliation.sql")
                        ? "b2daba323004014d21b87f53eb20993fda4216c249cd2c07e15a9fdab294742c"
                        : "ad366c52845dde14bc42d9c42e93e02c72ba916b6e7ab7ec15d7e2d5f2f5f14f"
                      : migrations.has("0224_slack_post_outcome_reconciliation.sql")
                        ? "8c742400ca1e21ddc4fe1db810d58af7dca037df360406fc71dbd85205eb5a64"
                        : migrations.has("0223_sessions_channel_fk_validate.sql")
                          ? "6bc5dfdf4468f6be4adc5ea7c6ed98397ee865c21a0175106320159b15588a6c"
                          : migrations.has("0221_sessions_channel_index.sql")
                            ? "e7beb14a48c19cdc2d185fd27b77052a66e9d2e52fe321bc3e2fc14bba8d8712"
                            : migrations.has("0220_memory_slack_append_only_cascade.sql")
                              ? migrations.has(
                                  "0219_organization_tenancy_managed_human_provisioning.sql",
                                )
                                ? "c9821a930c52d8c40604b9d2f39408227b377f3b2d70b4bb74c14ef93f605756"
                                : migrations.has("0218_organization_tenancy_foundation.sql")
                                  ? "d78d099f9393a3dcf7d8b54fd75d155448f1a3846712c0aee41d58e7b92b6e9b"
                                  : "85c02e09061ba359a0fa747b1ccffa87a5dd115cbfd8f36ad90c62292ef27bba"
                              : migrations.has("0219_site_auth_maintenance_sessions.sql")
                                ? migrations.has("0218_organization_tenancy_foundation.sql")
                                  ? "a002c6b3da822dfff2aca5fd88e76371ecadf87e1fc0c9f5a603b674f67676d1"
                                  : "67238deb9f46f6459e46c882a4dd5231b0ba739f715dfc9e51d8539f54ff3039"
                                : migrations.has("0218_organization_tenancy_foundation.sql")
                                  ? "eb6d0099f5362add0eb799641deace18326831ac61c8922c3f4f91c6a489f6a9"
                                  : migrations.has(
                                        "0217_capability_definition_delete_authority.sql",
                                      )
                                    ? "2d8e3211f1526419a8421c4388f7cf2297839318d7a7dbd194362d81c503c70a"
                                    : migrations.has("0216_pack_component_ownership.sql")
                                      ? "85a5f5320fd7c673bfe16240d4615b93ce635e9724d8f1bc467ce336e5c93022"
                                      : migrations.has("0214_session_activity_commit_gate.sql")
                                        ? "00b9989ef287e75bceceabc94ddfa1c118a97553ccdbc523485300046058075f"
                                        : "e3048091a81b7e122b3c6d17cf52e5ffccff4c082780f6d2d330031742aef792";
    const activationMigration = migrations.get("0225_session_visibility_fork_activation.sql");
    if (activationMigration) {
      expect(sourceContract.sha256).toBe(sessionVisibilityContractHash(true));
      expect(activationMigration).toMatchObject({
        sha256: "43945bc115ddf5e7b4b6e73a757c6bb63dde6929e1b3a89714c9cf330de87a12",
        deploymentMode: "rolling",
      });
      expect(migrations.get("0236_session_visibility_slack_policy.sql")).toMatchObject({
        sha256: "64f9beb146d973cc0a6ab9f8cdef29955ef9edb68ecc9b07756eda5414709299",
        deploymentMode: "rolling",
      });

      migrations.delete("0225_session_visibility_fork_activation.sql");
      sourceContract.migrations = sourceContract.migrations.filter(
        (migration) => migration.path !== "0225_session_visibility_fork_activation.sql",
      );
      sourceContract.fileCount -= 1;
      sourceContract.latestMigration = sourceContract.migrations.at(-1)?.path ?? null;
      sourceContract.sha256 = sessionVisibilityContractHash(false)!;
    }
    expect(sourceContract.sha256).toBe(
      sessionVisibilityContractHash(false) ?? currentMainContractHash,
    );
    const contract = {
      ...sourceContract,
      sha256: sessionVisibilityContractHash(false) ?? currentMainContractHash,
    };
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
        (migrations.has("0065_enrollment_credential_generation.sql") ? 1 : 0) +
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
        (migrations.has("0140_retained_screenshot_artifacts.sql") ? 1 : 0) +
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
        (migrations.has("0152_hierarchical_memory_foundation.sql") ? 1 : 0) +
        (migrations.has("0153_mcp_personal_connection_delegations.sql") ? 1 : 0) +
        (migrations.has("0154_scoped_knowledge_foundation.sql") ? 1 : 0) +
        (migrations.has("0155_connector_action_policies.sql") ? 1 : 0) +
        (migrations.has("0156_slack_reaction_trigger.sql") ? 1 : 0) +
        (migrations.has("0157_session_policy_role_snapshots.sql") ? 1 : 0) +
        (migrations.has("0158_session_realtime_mode.sql") ? 1 : 0) +
        (migrations.has("0159_session_realtime_ledger.sql") ? 1 : 0) +
        (migrations.has("0160_session_realtime_delegation_terminal.sql") ? 1 : 0) +
        (migrations.has("0161_session_realtime_context_projection.sql") ? 1 : 0) +
        (migrations.has("0162_session_realtime_connection_promotion.sql") ? 1 : 0) +
        (migrations.has("0163_session_realtime_delegation_progress.sql") ? 1 : 0) +
        (migrations.has("0164_session_realtime_models.sql") ? 1 : 0) +
        (migrations.has("0165_document_authority_foundation.sql") ? 1 : 0) +
        (migrations.has("0166_connection_disconnect_idempotency.sql") ? 1 : 0) +
        (migrations.has("0167_document_index_replay_authority.sql") ? 1 : 0) +
        (migrations.has("0168_workspace_instruction_policy_operation_receipts.sql") ? 1 : 0) +
        (migrations.has("0169_workspace_instruction_policy_onboarding_proposals.sql") ? 1 : 0) +
        (migrations.has("0170_resumable_transcription_recordings.sql") ? 1 : 0) +
        (migrations.has("0170_session_control_wake_revision.sql") ? 1 : 0) +
        (migrations.has("0171_social_connection_subject_ownership.sql") ? 1 : 0) +
        (migrations.has("0172_retire_model_visible_github_token.sql") ? 1 : 0) +
        (migrations.has("0173_codex_auth_boundaries.sql") ? 1 : 0) +
        (migrations.has("0174_session_wake_live_interruption.sql") ? 1 : 0) +
        (migrations.has("0175_resumable_transcription_provider_deadline.sql") ? 1 : 0) +
        (migrations.has("0176_lossless_canonical_json.sql") ? 1 : 0) +
        (migrations.has("0177_session_events_workspace_turn_type_index.sql") ? 1 : 0) +
        (migrations.has("0178_permissioned_secret_reads.sql") ? 1 : 0) +
        (migrations.has("0179_slack_private_shortcut_delivery_gate.sql") ? 1 : 0) +
        (migrations.has("0180_retained_screenshot_lifecycle_fences.sql") ? 1 : 0) +
        (migrations.has("0181_connected_machine_removal.sql") ? 1 : 0) +
        (migrations.has("0182_connected_machine_remove_session_default.sql") ? 1 : 0) +
        (migrations.has("0183_model_call_provider_cost_estimates.sql") ? 1 : 0) +
        (migrations.has("0184_sandbox_drain_teardown_fence.sql") ? 1 : 0) +
        (migrations.has("0185_temporal_schedule_cleanup_outbox.sql") ? 1 : 0) +
        (migrations.has("0186_sandbox_capture_provider_contract.sql") ? 1 : 0) +
        (migrations.has("0187_generated_image_artifacts.sql") ? 1 : 0) +
        (migrations.has("0188_image_generation_retention_failure.sql") ? 1 : 0) +
        (migrations.has("0189_retained_session_image_formats.sql") ? 1 : 0) +
        (migrations.has("0190_timeline_annotations.sql") ? 1 : 0) +
        (migrations.has("0191_editable_artifact_engine.sql") ? 1 : 0) +
        (migrations.has("0192_editable_artifact_live_tickets.sql") ? 1 : 0) +
        (migrations.has("0193_editable_artifact_authorization.sql") ? 1 : 0) +
        (migrations.has("0194_editable_artifact_durable_exports.sql") ? 1 : 0) +
        (migrations.has("0195_editable_artifact_import_authorization.sql") ? 1 : 0) +
        (migrations.has("0196_rig_provider_images.sql") ? 1 : 0) +
        (migrations.has("0197_knowledge_source_sync_schedules.sql") ? 1 : 0) +
        (migrations.has("0198_memory_slack_publication_delivery.sql") ? 1 : 0) +
        (migrations.has("0199_workspace_learning_policy.sql") ? 1 : 0) +
        (migrations.has("0201_company_profile_authority.sql") ? 1 : 0) +
        (migrations.has("0202_document_index_checkpoints.sql") ? 1 : 0) +
        (migrations.has("0203_durable_video_generation.sql") ? 1 : 0) +
        (migrations.has("0204_video_generation_funding.sql") ? 1 : 0) +
        (migrations.has("0205_attempt_tool_catalogs.sql") ? 1 : 0) +
        (migrations.has("0206_browser_sessions.sql") ? 1 : 0) +
        (migrations.has("0207_browser_identities.sql") ? 1 : 0) +
        (migrations.has("0208_attached_browser_devices.sql") ? 1 : 0) +
        (migrations.has("0209_computer_sessions.sql") ? 1 : 0) +
        (migrations.has("0210_browser_auth_network_interventions.sql") ? 1 : 0) +
        (migrations.has("0211_editable_artifact_session_links.sql") ? 1 : 0) +
        (migrations.has("0212_browser_state_transfer_hardening.sql") ? 1 : 0) +
        (migrations.has("0212_slack_installation_bindings.sql") ? 1 : 0) +
        (migrations.has("0213_browser_interaction_authority.sql") ? 1 : 0) +
        (migrations.has("0213_slack_user_link_access_requests.sql") ? 1 : 0) +
        (migrations.has("0214_browser_download_saves.sql") ? 1 : 0) +
        (migrations.has("0214_session_activity_commit_gate.sql") ? 1 : 0) +
        (migrations.has("0215_browser_controller_host.sql") ? 1 : 0) +
        (migrations.has("0215_capabilities_platform.sql") ? 1 : 0) +
        (migrations.has("0216_browser_auth_health_evidence.sql") ? 1 : 0) +
        (migrations.has("0216_pack_component_ownership.sql") ? 1 : 0) +
        (migrations.has("0217_external_browser_auth_operations.sql") ? 1 : 0) +
        (migrations.has("0217_capability_definition_delete_authority.sql") ? 1 : 0) +
        (migrations.has("0218_organization_tenancy_foundation.sql") ? 1 : 0) +
        (migrations.has("0219_site_auth_maintenance_sessions.sql") ? 1 : 0) +
        (migrations.has("0220_memory_slack_append_only_cascade.sql") ? 1 : 0) +
        (migrations.has("0219_organization_tenancy_managed_human_provisioning.sql") ? 1 : 0) +
        (migrations.has("0220_session_channels.sql") ? 1 : 0) +
        (migrations.has("0221_sessions_channel_index.sql") ? 1 : 0) +
        (migrations.has("0222_session_visibility_authority_epochs.sql") ? 1 : 0) +
        (migrations.has("0223_pending_tool_event_output.sql") ? 1 : 0) +
        (migrations.has("0222_sessions_channel_fk.sql") ? 1 : 0) +
        (migrations.has("0223_sessions_channel_fk_validate.sql") ? 1 : 0) +
        (migrations.has("0224_slack_post_outcome_reconciliation.sql") ? 1 : 0) +
        (migrations.has("0226_personal_codex_authority_foundation.sql") ? 1 : 0) +
        (migrations.has("0227_slack_native_actions.sql") ? 1 : 0) +
        (migrations.has("0228_slack_task_policy.sql") ? 1 : 0) +
        (migrations.has("0228_interaction_controller_data_plane.sql") ? 1 : 0) +
        (migrations.has("0229_slack_inbox_file_fact.sql") ? 1 : 0) +
        (migrations.has("0230_user_scoped_variable_sets_rigs.sql") ? 1 : 0) +
        (migrations.has("0231_integration_definition_identity_cutover.sql") ? 1 : 0) +
        (migrations.has("0232_integration_facet_authority_cutover.sql") ? 1 : 0) +
        (migrations.has("0233_skill_and_integration_authority_cutover.sql") ? 1 : 0) +
        (migrations.has("0234_xai_subscription_authority.sql") ? 1 : 0) +
        (migrations.has("0235_canonical_human_login_bindings.sql") ? 1 : 0) +
        (migrations.has("0236_browser_identity_lifecycle.sql") ? 1 : 0) +
        (migrations.has("0225_session_visibility_fork_activation.sql") ? 1 : 0) +
        (migrations.has("0236_session_visibility_slack_policy.sql") ? 1 : 0) +
        (migrations.has("0238_recover_unclaimed_session_turns.sql") ? 1 : 0) +
        (migrations.has("0242_google_drive_account_admin_authority.sql") ? 1 : 0),
    );
    expect(contract.sha256).toBe(sessionVisibilityContractHash(false) ?? currentMainContractHash);
    const previousLatestMigration = migrations.has("0238_recover_unclaimed_session_turns.sql")
      ? "0238_recover_unclaimed_session_turns.sql"
      : migrations.has("0236_session_visibility_slack_policy.sql")
        ? "0236_session_visibility_slack_policy.sql"
        : migrations.has("0235_canonical_human_login_bindings.sql")
          ? "0235_canonical_human_login_bindings.sql"
          : migrations.has("0234_xai_subscription_authority.sql")
            ? "0234_xai_subscription_authority.sql"
            : migrations.has("0233_skill_and_integration_authority_cutover.sql")
              ? "0233_skill_and_integration_authority_cutover.sql"
              : migrations.has("0232_integration_facet_authority_cutover.sql")
                ? "0232_integration_facet_authority_cutover.sql"
                : migrations.has("0231_integration_definition_identity_cutover.sql")
                  ? "0231_integration_definition_identity_cutover.sql"
                  : migrations.has("0230_user_scoped_variable_sets_rigs.sql")
                    ? "0230_user_scoped_variable_sets_rigs.sql"
                    : migrations.has("0228_slack_task_policy.sql")
                      ? "0228_slack_task_policy.sql"
                      : migrations.has("0229_slack_inbox_file_fact.sql")
                        ? "0229_slack_inbox_file_fact.sql"
                        : migrations.has("0227_slack_native_actions.sql")
                          ? "0227_slack_native_actions.sql"
                          : migrations.has("0224_slack_post_outcome_reconciliation.sql")
                            ? "0224_slack_post_outcome_reconciliation.sql"
                            : migrations.has("0223_sessions_channel_fk_validate.sql")
                              ? "0223_sessions_channel_fk_validate.sql"
                              : migrations.has("0221_sessions_channel_index.sql")
                                ? "0221_sessions_channel_index.sql"
                                : migrations.has("0220_memory_slack_append_only_cascade.sql")
                                  ? "0220_memory_slack_append_only_cascade.sql"
                                  : migrations.has("0219_site_auth_maintenance_sessions.sql")
                                    ? "0219_site_auth_maintenance_sessions.sql"
                                    : migrations.has("0218_organization_tenancy_foundation.sql")
                                      ? "0218_organization_tenancy_foundation.sql"
                                      : "0217_capability_definition_delete_authority.sql";
    expect(contract.latestMigration).toBe(
      migrations.has("0242_google_drive_account_admin_authority.sql")
        ? "0242_google_drive_account_admin_authority.sql"
        : previousLatestMigration,
    );
    expect(migrations.get("0214_session_activity_commit_gate.sql")).toMatchObject({
      sha256: "26c84bc34bc51d19f9532cf3f2c64a649f100a724cb73d968e17e7c4ecf8de36",
      deploymentMode: "maintenance",
    });
    if (migrations.has("0218_organization_tenancy_foundation.sql")) {
      expect(migrations.get("0218_organization_tenancy_foundation.sql")).toMatchObject({
        sha256: "6377522b4a7295150828bee39fffc90643adc46fec1907f1acc9671909ad6e75",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0219_organization_tenancy_managed_human_provisioning.sql")) {
      expect(
        migrations.get("0219_organization_tenancy_managed_human_provisioning.sql"),
      ).toMatchObject({
        sha256: "dcbc4dcf9c09255af4140ef1117938ec21148a1245dad85926aeb52c58e6e88f",
        deploymentMode: "rolling",
      });
    }
    expect(migrations.get("0197_knowledge_source_sync_schedules.sql")).toMatchObject({
      sha256: "edd425be4e4db07f4fcab1e520ece71dc1a692072ce28256ec2b86248442f3c8",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0065_enrollment_credential_generation.sql")).toMatchObject({
      sha256: "2e25fa2dfb8a95a7a9ba1ef5aa9bd219755af998b3317bcdf4d7acc4f67264fe",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0181_connected_machine_removal.sql")).toMatchObject({
      sha256: "c933a0781ac3c78272c5049637e3718299382e93272ea04095077f8ce7148f0a",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0182_connected_machine_remove_session_default.sql")).toMatchObject({
      sha256: "c15bd3b6d71f15be9e163481c3cb698d8f46620d655a72a5e56d193bc16310cd",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0198_memory_slack_publication_delivery.sql")).toMatchObject({
      sha256: "6cdc5d8cc22ff7c2e8abd0982223f75c414641857587bb7c0a736a88c20f0c1e",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0199_workspace_learning_policy.sql")).toMatchObject({
      sha256: "92286a9bbe8982fde66780bbe03fd92c0e5dbf1c9ff1fbf08a1d17fd2f8d595f",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0202_document_index_checkpoints.sql")).toMatchObject({
      sha256: "93b24b48e587fca5288af6042947f4592a3767bc6882fc8d5f52c973214e94ea",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0212_slack_installation_bindings.sql")).toMatchObject({
      sha256: "aba5b603fc88237a2446fc66803f3c940f2f50e111fbe882abf4420307374b34",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0203_durable_video_generation.sql")).toMatchObject({
      sha256: "a48d600cd51a4ed6ed2a68d443959b8754364ab7d60709b1d5cd23f2a5013d3a",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0204_video_generation_funding.sql")).toMatchObject({
      sha256: "bdb70908f6e61ecc1d69228e2c05183c70527bf1bebac74bdab3294243ed9c3b",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0205_attempt_tool_catalogs.sql")).toMatchObject({
      sha256: "65e121d067dc3df2cd23a4e78e9ad094a0450a0be648720af0ff50f2002418d5",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0206_browser_sessions.sql")).toMatchObject({
      sha256: "bb21e1ec77eb9a92435abfd6bbaa969355ec61179b5ea4837ca363fc1f667c2f",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0207_browser_identities.sql")).toMatchObject({
      sha256: "03790bd77a2b6e237c22d3dabc6f5a579feaf18931d5ce71da084d0958729e5e",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0208_attached_browser_devices.sql")).toMatchObject({
      sha256: "5389ae763a5f8fa0b55f93f626dd4370154702695ab2c80da0a627c435b5792d",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0209_computer_sessions.sql")).toMatchObject({
      sha256: "b6be91fdc83b54677e7a326245f0ac2fee93b032c26bc26b011eb3879745fcb0",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0210_browser_auth_network_interventions.sql")).toMatchObject({
      sha256: "44fd93e8cf8b08ab7d5088a3b075a557a770474a5ac5c7d14ef1ebffe1c0e771",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0211_editable_artifact_session_links.sql")).toMatchObject({
      sha256: "0d24c5387951f232e72d3af5fe116fd268c0d30d59e0ac55959ba87a2309c966",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0212_browser_state_transfer_hardening.sql")).toMatchObject({
      sha256: "28aa25ba8262d54343dd092d21ec8853e8d050c91768a6350054724dae141f76",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0213_browser_interaction_authority.sql")).toMatchObject({
      sha256: "ffb7ed93832e830d379cca04efb017193f29da6e07ccd1f4cb3f469c343a2fa2",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0214_browser_download_saves.sql")).toMatchObject({
      sha256: "9c7b7ba708e77dd75870c1826d3ad8fdc1a5ce5d25c8a58b60edd13a27059059",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0215_browser_controller_host.sql")).toMatchObject({
      sha256: "048418cf8c8c6445d18977ba93c3ca87debde85fee038be6a90edfae6e4b93f6",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0216_browser_auth_health_evidence.sql")).toMatchObject({
      sha256: "9e42263bce8f501b01beff1983474deb232367d1fdbdf268fa42ac2e19f6a879",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0217_external_browser_auth_operations.sql")).toMatchObject({
      sha256: "eeecfc514f894589446d350e8af7097387312536ad6e32d39ced3f13485a02cd",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0219_site_auth_maintenance_sessions.sql")).toMatchObject({
      sha256: "e8e786a510ae169013c5eebab17b3cbe6fc3fd239c88e544c081f4767a0e13bd",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0220_memory_slack_append_only_cascade.sql")).toMatchObject({
      sha256: "17a34e7b943b1c4456bfb64cd8fe6fbb410b4ca7238b6ad02e24343483d54db1",
      deploymentMode: "rolling",
    });
    if (migrations.has("0222_session_visibility_authority_epochs.sql")) {
      expect(migrations.get("0222_session_visibility_authority_epochs.sql")).toMatchObject({
        sha256: "c28ab83cf3e79e11bd643dc485aeee44f4ba37eeefc7176af894eace9eeabeb3",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0224_slack_post_outcome_reconciliation.sql")) {
      expect(migrations.get("0224_slack_post_outcome_reconciliation.sql")).toMatchObject({
        sha256: "fc88cdb5664c74480e1437d5e061e9e32f109afd17eb946985af38791f267c49",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0229_slack_inbox_file_fact.sql")) {
      expect(migrations.get("0229_slack_inbox_file_fact.sql")).toMatchObject({
        sha256: "390361e1dba5830fabeaf7712e4108841a2ba267e8396599a632854da9b32ca9",
        deploymentMode: "rolling",
      });
    }
    expect(migrations.get("0230_user_scoped_variable_sets_rigs.sql")).toMatchObject({
      sha256: "560adbe658efa212ec44ad18f6af22ac874568d60a331beddae4102d00a09e5f",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0226_personal_codex_authority_foundation.sql")).toMatchObject({
      sha256: "34b72f6ab031596c90f2f35957c707aaf013c2f52aee8ca92a70fdb8ab9cb9ce",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0231_integration_definition_identity_cutover.sql")).toMatchObject({
      sha256: "535a806746d99d9b338df230c133477ca0e3d554ae6950077a3409b077f4b1cb",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0232_integration_facet_authority_cutover.sql")).toMatchObject({
      sha256: "acf779d1bd931ea208be8a97b9f930a2387f53151722198704f0aecbe76f1fb6",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0233_skill_and_integration_authority_cutover.sql")).toMatchObject({
      sha256: "26ed3d2ffcaf572623ad263aaa0103625b4ed1e9d28bcb7b5d35eb972d9762d1",
      deploymentMode: "maintenance",
    });
    if (migrations.has("0223_pending_tool_event_output.sql")) {
      expect(migrations.get("0223_pending_tool_event_output.sql")).toMatchObject({
        sha256: "851cdb5dfe14f1cf6323e6cf59e55269b87d2db4406ea2ad10147553635eb707",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0234_xai_subscription_authority.sql")) {
      expect(migrations.get("0234_xai_subscription_authority.sql")).toMatchObject({
        sha256: "be0c23d624d545226068ce7627a2b458fe9aad996ea7ee750753c81eeb8988a8",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0235_canonical_human_login_bindings.sql")) {
      expect(migrations.get("0235_canonical_human_login_bindings.sql")).toMatchObject({
        sha256: "c62984fc3016e0433e5dbc2049e14e11b343d9221b92b2e5dcc5238339579200",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0236_session_visibility_slack_policy.sql")) {
      expect(migrations.get("0236_session_visibility_slack_policy.sql")).toMatchObject({
        sha256: "64f9beb146d973cc0a6ab9f8cdef29955ef9edb68ecc9b07756eda5414709299",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0238_recover_unclaimed_session_turns.sql")) {
      expect(migrations.get("0238_recover_unclaimed_session_turns.sql")).toMatchObject({
        sha256: "7d63ad62f2dc91f8c5de87b95a35a366d4b23d4fc76f320b5376ef2412a2002d",
        deploymentMode: "rolling",
      });
    }
    expect(migrations.get("0183_model_call_provider_cost_estimates.sql")).toMatchObject({
      sha256: "2cb087b69996c62e8836f2d65c9e2af3fb580fe1822d327600bf40e3a6977d64",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0184_sandbox_drain_teardown_fence.sql")).toMatchObject({
      sha256: "fa757f718fe7239df60514768f8b50abb1905bba5f928adda5001bad4927634e",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0185_temporal_schedule_cleanup_outbox.sql")).toMatchObject({
      sha256: "801c2848adbc4c58a701bd1e7039b4c9b4fb4beb0a49b950585a5c79b536fd9d",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0186_sandbox_capture_provider_contract.sql")).toMatchObject({
      sha256: "fc7d8d0eeba1800727f4f0f72020fac50290c629d9819f5b608d33f8b6af6bce",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0187_generated_image_artifacts.sql")).toMatchObject({
      sha256: "d29994ffbe9bb0bd4f048341c11ccd3c12ffd559ba8052535ea4b60df4f7543b",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0188_image_generation_retention_failure.sql")).toMatchObject({
      sha256: "e4fa1cc2700d67befb0d517ad0dd4255481f71aefe400dd5717461b76f12ccd3",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0189_retained_session_image_formats.sql")).toMatchObject({
      sha256: "79daa0cb3f7649faafc30fba8976bfbea2881fe84d82a407cb071576c37bfd0c",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0190_timeline_annotations.sql")).toMatchObject({
      sha256: "ebc8c3c9998d0a292b548bfa98889309e8802e0619f0aeef31b5a0959ef42825",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0191_editable_artifact_engine.sql")).toMatchObject({
      sha256: "5d51991c1ba63c298d7d59032956cac752c5b29645f594cf87f1aaa1919c7d1e",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0192_editable_artifact_live_tickets.sql")).toMatchObject({
      sha256: "e96f7a9537cc074516d9f08758f03880fdb0cfdab8559c8a7c814bf8229ba9ef",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0193_editable_artifact_authorization.sql")).toMatchObject({
      sha256: "b4312978eba8f9211c4bcaada45fd0930052a567b969092cb603b4607228e5b8",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0194_editable_artifact_durable_exports.sql")).toMatchObject({
      sha256: "6d69b72b6257a4e9372214b216ba10ffb81ddb23f47b3e21ec0077c49aef518e",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0195_editable_artifact_import_authorization.sql")).toMatchObject({
      sha256: "c34cef47b396a9bdc518180d2012c2d6c1fc96313449a76ff2c50403acc32c7f",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0196_rig_provider_images.sql")).toMatchObject({
      sha256: "0d47354968aeec0ba9d329351593fd8f3b5469a3157e74f837dbdb16b64bc07f",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0201_company_profile_authority.sql")).toMatchObject({
      sha256: "780eb3550bbe5a6811cde7f8cfd69cf8f98e3181e03d1700f325961e71b1b272",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0180_retained_screenshot_lifecycle_fences.sql")).toMatchObject({
      sha256: "184bd3bb0360d63abc72e09ad5461646679320c61c0a24a5e67cc3af5a7d008a",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0179_slack_private_shortcut_delivery_gate.sql")).toMatchObject({
      sha256: "eabb9498659f0fe7a9aa080568f4a6963bc4e51bb9b7df897c0a9f7060671824",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0178_permissioned_secret_reads.sql")).toMatchObject({
      sha256: "a671934c8c969fe14edc322fd64c1423605620977d98660efc942b955673357b",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0177_session_events_workspace_turn_type_index.sql")).toMatchObject({
      sha256: "24eaf3a8c0eb5cfabfbfaf96544b77ea8021be9ce92730a0ec663493d2651650",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0176_lossless_canonical_json.sql")).toMatchObject({
      sha256: "796f2758f2d6ed46ed9d4fd44e191e64fc6fd65eaefcafef5597158426006538",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0175_resumable_transcription_provider_deadline.sql")).toMatchObject({
      sha256: "8e91b37db947c1430b5d12ed17a19038d14788ff581e9e36f68461d807db28cb",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0174_session_wake_live_interruption.sql")).toMatchObject({
      sha256: "492f93a4ba0f715f3d37cdc539d5e09dd277b8a882d24b1730d01e245e2f85cf",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0173_codex_auth_boundaries.sql")).toMatchObject({
      sha256: "450075954cb9c8bfc346ccf09991edd362cc5ffdcf4e94d1c404d3fc6795e2ca",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0171_social_connection_subject_ownership.sql")).toMatchObject({
      sha256: "939893142dc109c77b2a665e76e58533002cebbf3320dba28277e2caea825deb",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0170_session_control_wake_revision.sql")).toMatchObject({
      sha256: "cec3593e377f1cdc6aac3441b89d57e7c19d7377ff31991f340e14af1e64453d",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0170_resumable_transcription_recordings.sql")).toMatchObject({
      sha256: "b75688206e0f2d7c431fdfc7a465d4680fde59a129a090b2e532dd5b1c896bbd",
      deploymentMode: "rolling",
    });
    expect(
      migrations.get("0169_workspace_instruction_policy_onboarding_proposals.sql"),
    ).toMatchObject({
      sha256: "71d36ab95a1711c78ab36a09af9a14ddbf6ee84a3bac5ec5fdb460c768c54ef8",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0172_retire_model_visible_github_token.sql")).toMatchObject({
      sha256: "6e2123085f5574a046eaea7db7b5168540625d554771ee9e5639787bbde4c713",
      deploymentMode: "maintenance",
    });
    expect(
      migrations.get("0168_workspace_instruction_policy_operation_receipts.sql"),
    ).toMatchObject({
      sha256: "d778468a5f7dd77046ddb26a29ea819a081ba07cbe1bb82c82e84d609a8dc4b7",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0167_document_index_replay_authority.sql")).toMatchObject({
      sha256: "a6709b8c4c4bdd8bef82770aad11d2fb7424e858a657137315b36bb71496bb96",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0166_connection_disconnect_idempotency.sql")).toMatchObject({
      sha256: "47e93eac839e160995f732f18986753d45221b1aedf98852c19b0b271236dc1b",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0165_document_authority_foundation.sql")).toMatchObject({
      sha256: "bde7f3088069f54e71aeb46375c3bda050e6af3a1d8d5464c38dca3d742baa28",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0164_session_realtime_models.sql")).toMatchObject({
      sha256: "6140bfa6efaca5d4fe34892529db2ada756b49f47d9fbe783137dc32d3b6afdc",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0163_session_realtime_delegation_progress.sql")).toMatchObject({
      sha256: "b843fb79d150242591f160d2e841ec3053e2b5a61af86fe09cff400d0adcdb1d",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0162_session_realtime_connection_promotion.sql")).toMatchObject({
      sha256: "118312d240b3cb0f67241466447d8c726ffcd0d050429c3e5a4fdf89bd9fafe2",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0161_session_realtime_context_projection.sql")).toMatchObject({
      sha256: "f2ece368fdbb9c07b0d5e305bc92f0aecefc929e9399d51b81c9c7ced28c3889",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0160_session_realtime_delegation_terminal.sql")).toMatchObject({
      sha256: "678147cf0298d01bf20acae291a33a275d3e8a66b82b289d7d876f3f9e8e0ecd",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0159_session_realtime_ledger.sql")).toMatchObject({
      sha256: "471a4be63a30ab7315115a49e43deb5bf993e494df81be9c25274c2cce89b7e1",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0158_session_realtime_mode.sql")).toMatchObject({
      sha256: "a005e2b0d0e41dc7350643facce2b080b2ede379d88c7d3725c0757e2ca65f15",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0157_session_policy_role_snapshots.sql")).toMatchObject({
      sha256: "84ad34345fe587ac8d952a4ddb7c55b1fec6a381b9ba5a73af6bcf253860f737",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0156_slack_reaction_trigger.sql")).toMatchObject({
      sha256: "080cd2840c3fd4c6c81b838cf7b0a4f1fa7e48ab4ced18c05e76da895934a945",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0155_connector_action_policies.sql")).toMatchObject({
      sha256: "eec332244acd1e38f6964cd455960e82b1c62cf63652acf946fe0e78b3faa785",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0154_scoped_knowledge_foundation.sql")).toMatchObject({
      sha256: "9e52f88b51b81d405de8f7c3c70a083a1a091d49b98042f96127565f352e9874",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0153_mcp_personal_connection_delegations.sql")).toMatchObject({
      sha256: "e27385280b8342ddd2bad9fea000d823e0e96c46b1c340403afaca81613610cf",
      deploymentMode: "rolling",
    });
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
        .filter((path) =>
          /^(?:010[3-9]|011[0-9]|012[0-9]|013[0-9]|014[0-9]|015[0-9]|016[0-4])_/.test(path),
        ),
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
      "0140_retained_screenshot_artifacts.sql",
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
      "0153_mcp_personal_connection_delegations.sql",
      "0154_scoped_knowledge_foundation.sql",
      "0155_connector_action_policies.sql",
      "0156_slack_reaction_trigger.sql",
      "0157_session_policy_role_snapshots.sql",
      "0158_session_realtime_mode.sql",
      "0159_session_realtime_ledger.sql",
      "0160_session_realtime_delegation_terminal.sql",
      "0161_session_realtime_context_projection.sql",
      "0162_session_realtime_connection_promotion.sql",
      "0163_session_realtime_delegation_progress.sql",
      "0164_session_realtime_models.sql",
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

async function contractWithoutMigrations(excludedPaths: readonly string[]) {
  const source = join(import.meta.dir, "../packages/db/drizzle");
  const directory = await mkdtemp(join(tmpdir(), "opengeni-schema-contract-filtered-"));
  directories.push(directory);
  const excluded = new Set(excludedPaths);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql") || excluded.has(entry.name)) continue;
    await copyFile(join(source, entry.name), join(directory, entry.name));
  }
  return await buildSchemaContract(directory);
}

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
