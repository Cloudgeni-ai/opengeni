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
      "0240_model_context_user_messages.sql",
      "0249_personal_resource_delegation_authority_correction.sql",
      "0250_direct_retained_process_owner_liveness.sql",
      "0251_connected_machine_operation_policy.sql",
      "0252_scheduled_personal_resource_delegation.sql",
      "0253_common_user_resource_authority_lifecycle.sql",
      "0254_scoped_variable_set_authority.sql",
      "0256_connection_authority_delegation.sql",
      "0262_scoped_connected_machines_and_rigs.sql",
      "0264_connection_authority_runtime_activation.sql",
      "0273_scheduled_variable_set_materialization.sql",
      "0304_personal_workspace_private_session_reads.sql",
      "0305_personal_resource_grant_management.sql",
      "0306_atomic_personal_resource_attachments.sql",
      "0311_company_scope_and_private_session_create.sql",
      "0312_quiescent_session_tree_deletion.sql",
      "0315_personal_github_repository_selection.sql",
      "0313_private_child_session_authority.sql",
      "0314_unregistered_organization_invitations.sql",
      "0315_human_confirmed_activation_resumed_generation.sql",
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
        (migration) => migration.path === "0314_unregistered_organization_invitations.sql",
      ),
    ).toMatchObject({ deploymentMode: "maintenance" });
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
    const modelContextCutover = completeSourceContract.migrations.find(
      (migration) => migration.path === "0240_model_context_user_messages.sql",
    );
    if (modelContextCutover) {
      expect(modelContextCutover).toMatchObject({
        deploymentMode: "maintenance",
      });
    }
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0251_connected_machine_operation_policy.sql",
      ),
    ).toMatchObject({
      sha256: "a37e307de730bc47ccf4ed6bf517427ebb0d20199640f54e8e525ae1ce046663",
      deploymentMode: "maintenance",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0304_personal_workspace_private_session_reads.sql",
      ),
    ).toMatchObject({
      sha256: "cdce8c6b6644b07c672918a94c3e0e01f09d771dc33a61e38ec91eec763bf0c1",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0305_personal_resource_grant_management.sql",
      ),
    ).toMatchObject({
      sha256: "b6c20178b35b279314872c7cc79048f028d2b1ed070a49f5ad9e0490cb8e5b0c",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0306_atomic_personal_resource_attachments.sql",
      ),
    ).toMatchObject({
      sha256: "4aa927065e39ecda0cbf118e9f861d728f8b213e4b72238e2cdbccea002e2af4",
      deploymentMode: "maintenance",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0311_company_scope_and_private_session_create.sql",
      ),
    ).toMatchObject({
      sha256: "c7ab1856c718dbb9c6097b9e04585d34fa5de557cc27b09466e5c0f3e6c20e19",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0240_enrollment_connection_authority.sql",
      ),
    ).toMatchObject({
      sha256: "5dd85b5f7bf5940a397cb67938b82e2b902a0529872a3d7158b7cfcfc04e885c",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0241_enrollment_agent_runtime.sql",
      ),
    ).toMatchObject({
      sha256: "a13ddf193d04fbc5beac33f33641358f2486eef88744e06f3bfeb02366761da7",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0244_slack_app_home_refresh_queue.sql",
      ),
    ).toMatchObject({
      sha256: "f098df63a6ed21e88362faf0d6c5e36321604bb300ac155529adb9b17da30858",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0245_model_context_contribution_facts.sql",
      ),
    ).toMatchObject({
      sha256: "437bb07ffe12f9c714bd2a40d0ecd8ed9df1fd9003f4d057fe11101999841f40",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0246_integration_personal_instance_authority.sql",
      ),
    ).toMatchObject({
      sha256: "1717d5cdaa298501f20463eef43822a2b1421984f30cab7cb381c2773c505388",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) =>
          migration.path === "0249_personal_resource_delegation_authority_correction.sql",
      ),
    ).toMatchObject({
      sha256: "98b1e6059e955b7a8022ff45f977b44075a7f854828422e06d9879a8487d62f7",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0250_direct_retained_process_owner_liveness.sql",
      ),
    ).toMatchObject({
      sha256: "8ae147f5de31c4173758e8e64bbb2597e8a3fc49d983a7a518f229fb95ef90f5",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0252_scheduled_personal_resource_delegation.sql",
      ),
    ).toMatchObject({
      sha256: "ddc1c34835e4f5ac7ae5039e5c0dae5971d6e6284167eb9199151175f8766169",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0253_common_user_resource_authority_lifecycle.sql",
      ),
    ).toMatchObject({
      sha256: "cfcffb54e01c41927aeed024a1ba610bac45ac3d5271a7c1b147f4beb28c2428",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0254_scoped_variable_set_authority.sql",
      ),
    ).toMatchObject({
      sha256: "e99064ac5acd73e79c3a75872d71a5c8710bcedbbd12fbe3eee989d7f167c8cf",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0255_company_brain_governed_write_proposals.sql",
      ),
    ).toMatchObject({
      sha256: "5d6527267b8de9cb9539e97a0cd30051dc9b2059fd5935261aa8c762d5d6a0d3",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0257_goal_revision_decisions_and_root_constraints.sql",
      ),
    ).toMatchObject({
      sha256: "457f7ae4bdaaf6f65bc5245f5f3c0ee7b28de94aafce284bb80bfbb4fb690da4",
      deploymentMode: "maintenance",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0256_connection_authority_delegation.sql",
      ),
    ).toMatchObject({
      sha256: "669f96626b41fc0cf8c82914d1e39183925af1717510032fc70950ee7040ff84",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0258_three_scope_document_knowledge_authority.sql",
      ),
    ).toMatchObject({
      sha256: "e9349cb0f88673fcf602aba495e8ad90970c7d46ed1490acffc530baf2d6c484",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0259_company_brain_context_selection_receipts.sql",
      ),
    ).toMatchObject({
      sha256: "e4b03de61786cd7f22fe203cb498142bdf55e3cda15b0065536967e54341d2b0",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0260_task_note_knowledge_promotion.sql",
      ),
    ).toMatchObject({
      sha256: "1f067ac286f94effc2a98bf5d016fab6e2d563054bbb3eafa358ce4b653191fe",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0261_preference_knowledge_proposal_actor_binding.sql",
      ),
    ).toMatchObject({
      sha256: "c00d29214a9181301fa3076322992a2958ed4d017028a7956a52b97c930af8e6",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0266_company_brain_context_receipt_inspection.sql",
      ),
    ).toMatchObject({
      sha256: "4830b11f4a856ab1992924f68a6567649d93026b7a3093d9a2c66ee6a7b485bb",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0268_governed_learning_decision_receipts.sql",
      ),
    ).toMatchObject({
      sha256: "c76df472ad5bc0af0a17918b5b594b2013fb9a2ce6e7e35d429c1dd807bd3054",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0269_governed_learning_activation_controller.sql",
      ),
    ).toMatchObject({
      sha256: "6fa48ea195c33edae1a5cf8a857b832e34fb16b3fb73ac9d0fe1629f03a9892c",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0262_scoped_connected_machines_and_rigs.sql",
      ),
    ).toMatchObject({
      sha256: "87901ff0b301b010a18e04ddd2137f291554071c8c9f73bec9b52b69cadd1cb8",
      deploymentMode: "rolling",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0264_connection_authority_runtime_activation.sql",
      ),
    ).toMatchObject({
      sha256: "1f72cf8be5a791fb42a4bf7b19f81cef4cce9c7f92dfb1dc8626127a1a8b420c",
      deploymentMode: "maintenance",
    });
    expect(
      completeSourceContract.migrations.find(
        (migration) => migration.path === "0273_scheduled_variable_set_materialization.sql",
      ),
    ).toMatchObject({
      sha256: "c1065c50461e8f273931766158b8a0011818e3fc72fecb221407c6e689152694",
      deploymentMode: "rolling",
    });
    const migrations = new Map(
      sourceContract.migrations.map((migration) => [migration.path, migration]),
    );
    const sessionVisibilityContractHash = (includesActivation: boolean): string | null => {
      if (migrations.has("0259_company_brain_context_selection_receipts.sql")) {
        return includesActivation
          ? "59cda520a2634003dd1ee3144d5c9eabf449825efcdf574dc43b00e65d2a05de"
          : "9dc07149adb2813d81c60fbb3f410009e29a9c79223d4ab16fa8694a0cf8c165";
      }
      if (
        migrations.has("0258_three_scope_document_knowledge_authority.sql") &&
        migrations.has("0257_goal_revision_decisions_and_root_constraints.sql")
      ) {
        return includesActivation
          ? "1997fbda36325fff330f3a34870148f1acf77d27fc1c541c67dd26f61e1d9ca5"
          : "bb3497f077a68c8ecb9b1b385067456ea3aa894d282ad0b820d97b55d2d25cc6";
      }
      if (migrations.has("0258_three_scope_document_knowledge_authority.sql")) {
        return includesActivation
          ? "119d394b27853a7c9edfa65be82793cd6e1bac684a32fc2e6524bdd8a8fa225a"
          : "9d0bc49c13b78936d8d8248efe388f15449f87033792a97ec78148dfd047979e";
      }
      if (migrations.has("0257_goal_revision_decisions_and_root_constraints.sql")) {
        return includesActivation
          ? "895bfe1b39d54afff3d8e52cc9beb50ae32d3d7d1e9be6e0a7bc30e39161d427"
          : "72379299ecfe8e35b1f25eed4ec2a37582cbe9efaf93b0c0d26ba28246f3c2aa";
      }
      if (migrations.has("0255_company_brain_governed_write_proposals.sql")) {
        return includesActivation
          ? "7297e2ad81f65cfebfea608a8e541e1f8229e6b0e70f3a8d651319fefa72760d"
          : "6bb2a825b85f0372d6fae7ca45aa43491d47e9283e19456554f8402166a203c9";
      }
      if (
        migrations.has("0236_session_visibility_slack_policy.sql") &&
        migrations.has("0246_integration_personal_instance_authority.sql") &&
        migrations.has("0241_atomic_personal_resource_delegation.sql")
      ) {
        return includesActivation
          ? "08c08f359b6c34c51ed190747789f43e10c1f3d32a69e1f0da54a776f83dda66"
          : "9c3c1b1e6ae87ffcff3025c4a8328007bec6cbcab856ffb967eeffe4ce719da1";
      }
      if (
        migrations.has("0236_session_visibility_slack_policy.sql") &&
        migrations.has("0245_model_context_contribution_facts.sql") &&
        migrations.has("0244_slack_app_home_refresh_queue.sql") &&
        migrations.has("0241_atomic_personal_resource_delegation.sql")
      ) {
        return includesActivation
          ? "64f53a4ec4517fa2525aba293869d9048c9932bed58f0ef17445a2723aa579fe"
          : "01840387a701cb5585308d2cf47070298c6580e6d037abfa3f4358563220868d";
      }
      if (
        migrations.has("0236_session_visibility_slack_policy.sql") &&
        migrations.has("0244_slack_app_home_refresh_queue.sql") &&
        migrations.has("0241_atomic_personal_resource_delegation.sql")
      ) {
        return includesActivation
          ? "ed2d5cdf78858b08efdbf0bd46474c1bd45ec1798595a104da1e4c9b123a34c2"
          : "720613ad79a8956f6cc5372c5441dcfbbec1b4c9dd7a9c7e3d08dae4f736ffab";
      }
      if (!migrations.has("0236_session_visibility_slack_policy.sql")) return null;
      if (migrations.has("0246_integration_personal_instance_authority.sql")) {
        return includesActivation
          ? "b70c095097581527ba8f694f17b1ef8b4607d57dd5535e1c57193fda28970b8f"
          : "7a59d00e485087d34bde8473a94d49a895d51a049103244f6a320a750ad49f1b";
      }
      if (
        migrations.has("0245_model_context_contribution_facts.sql") &&
        migrations.has("0244_slack_app_home_refresh_queue.sql")
      ) {
        return includesActivation
          ? "5c12e104be0199831cd12777ea509e9ca3a0448768d211cb52056d55300a1044"
          : "151a3871e8b935ce10c1d1b5a8182d110636248ed0d34d2281bc890e2c3737b5";
      }
      if (migrations.has("0244_slack_app_home_refresh_queue.sql")) {
        return includesActivation
          ? "6dfd8724938ea9e087593afcc8ea0cbb963b8600e898b76f7c6eb9b0fadbc05f"
          : "864ab2e236a6847bc80d00870de1312e7dd9853c1eb655f3bfd66d0f4812cae3";
      }
      if (
        migrations.has("0243_google_drive_object_acl_authority.sql") &&
        migrations.has("0241_enrollment_agent_runtime.sql") &&
        migrations.has("0241_atomic_personal_resource_delegation.sql")
      ) {
        return includesActivation
          ? "9052b2c6bdec863e26504274ccd527bd8d53b8375ac9465edbe8378183bbdd0d"
          : "7b553426ed71c3a6a1677b9be182f0a7674ff23dddaee017272dd47a6897d0fd";
      }
      if (
        migrations.has("0243_google_drive_object_acl_authority.sql") &&
        migrations.has("0241_enrollment_agent_runtime.sql")
      ) {
        return includesActivation
          ? "619dd36aeccd97091f053c691d1ae57dcf1bae3ec6f274d0789401a7e57529ea"
          : "9afefe94fdadc2f1f85f3fafe6811242b922376c4c01eeb607f3414c0bcce9e4";
      }
      if (
        migrations.has("0243_google_drive_object_acl_authority.sql") &&
        migrations.has("0241_atomic_personal_resource_delegation.sql")
      ) {
        return includesActivation
          ? "015b520626fe065f8497d7bd065da60e1168f902c31af22a1b51e81ac3878a19"
          : "82e13cbc75672a8fffe3014b606b833c65bd1e476e67d755043a024c49984521";
      }
      if (migrations.has("0243_google_drive_object_acl_authority.sql")) {
        return includesActivation
          ? "8d30a981d2a744a263e660ab21eeaa0a1071e7afe71b771bbc81151a79330fa4"
          : "2a39ec3cb579dad4f4fc17040cac665b88b39f24871a2462b17286d3925a4378";
      }
      if (
        migrations.has("0241_enrollment_agent_runtime.sql") &&
        migrations.has("0241_atomic_personal_resource_delegation.sql")
      ) {
        return includesActivation
          ? "9c004e0805db7f59f8086c9823f5f9d25bb6849b36b1bae1c1603a91a687f98e"
          : "0f32095219b9894a903f442fc4cd8feb5dd8ef6d6404104aa6f50131d0c6be90";
      }
      if (migrations.has("0241_enrollment_agent_runtime.sql")) {
        return includesActivation
          ? "903aaca7cdc6880795488542605f2e007ae184b36209c24fbe06b5b190f96067"
          : "677d05fd674a19f95b329b6381a8a2d79884df8c71c22614e22622d55f4a193a";
      }
      if (migrations.has("0241_atomic_personal_resource_delegation.sql")) {
        return includesActivation
          ? "22ca0d47d0c0adc8aa6b6f6c32b062110397e312843930c8d2f718d979845f57"
          : "1ae31a2d57ec668e2a6313b94902304df837ab66d66f3a3968e57e09332c18bd";
      }
      if (migrations.has("0238_recover_unclaimed_session_turns.sql")) {
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
    const releaseSchemaContractHash = (includesActivation: boolean): string | null => {
      if (migrations.has("0310_channel_project_order.sql")) {
        return includesActivation
          ? "0f1aa9ad9747be5968dfa9374a0c623fcb10a0e4095350f13df81b0bc40679ca"
          : "5ae226fe9a702d73866c041e7aba8b640d84186a5cb87ccd7e0e8c37fbb7444c";
      }
      if (migrations.has("0303_session_tenancy_product_activation.sql")) {
        return includesActivation
          ? "4ac6ee56a21a9973b9ea49608c10789b207ae4b07005948fe3e8c918836c4d93"
          : "a0ae8bf3fc91aff20895e22fda9f3987d77a397fe280dc043d5597917c8f2f13";
      }
      if (migrations.has("0302_personal_workspace_session_ownership.sql")) {
        return includesActivation
          ? "e704c389b9efad1015b48643a39bcbe18c349a65d387f596f819c3d3bc8d5d62"
          : "4f78df29afaea5771889d310287393e14f6f0c56b0a15eb6d1f6bfb03dde4ebc";
      }
      if (migrations.has("0301_session_snapshot_and_pin_visibility.sql")) {
        return includesActivation
          ? "e6a185b9c4c085046fbf335bdc4cc298d637fd95d840dd88f72ed888ce524fd9"
          : "e80c970dfa38fcbf32cab6b9d2a4b668513203e2860af664f282a8136916fb04";
      }
      if (migrations.has("0300_tenancy_backfill_ledger.sql")) {
        return includesActivation
          ? "7aafb19556e9dd82062f326983417011c3ee4d2c84e21bc798110a9042e7d05f"
          : "da92edd7a301d7f885398d96164fb080bec8de21e94a2a6c52d552e38b5e0dd8";
      }
      if (migrations.has("0298_organization_tenancy_parity.sql")) {
        return includesActivation
          ? "52e75460701c988f8421bcf89115918f477499c4bce89be5fb6e5184e363557e"
          : "ba24948d8ba915741f79b61ca05bf0b2ebb319e5c0b6f63505250521f34e6cb3";
      }
      if (migrations.has("0297_session_ownership_classification_and_backfill.sql")) {
        return includesActivation
          ? "f39e0463f4b9998e3d4f4c4cff520b351a9a7d6306c426a6d0869df7997bacdb"
          : "07df0f730ab85c40901217a218d2e69be4b4d55d53b8c2302268d0ae36e2cd6d";
      }
      if (migrations.has("0290_organization_membership_backfill.sql")) {
        return includesActivation
          ? "7378438b51b04a8ddd2080bfa8ca8a07d05a3bcfd2030e36da1991cd62ca337f"
          : "85e8b7323cae1fbda10b992350ac87653f0a62a611ee9e64c3dc05a158531e94";
      }
      if (
        migrations.has("0296_force_rls_backfill_noop_repair.sql") &&
        migrations.has("0299_organization_membership_lock_order.sql")
      ) {
        return includesActivation
          ? "24fb6b4938a573dc516315b6e1d893fa44647f56cdc277157fb0bc07b21dbd30"
          : "7d5b83e7a150b8c3fae51129c0fd0d727f48428bc207b2ac0202dce6b3203a71";
      }
      if (migrations.has("0299_organization_membership_lock_order.sql")) {
        return includesActivation
          ? "c2b79a82f91fcae25012f4cea86a4fda5953290173974161a8b9fcb74219f25d"
          : "6ef9798a9820add11c3c378fa3c3519f14debd0df67ffa10e10d7b64c21791f7";
      }
      if (migrations.has("0295_retire_legacy_standing_memory_mode.sql")) {
        return includesActivation
          ? "d298b2bf66636757b6c61dd1352b7b96e2844739fcdc796258bc9b46124ce58b"
          : "41304996faed30be3456b42fd902d98dfb405f093341dfc0e34023cf58fc5a16";
      }
      if (
        migrations.has("0289_session_composer_policy_authority.sql") &&
        migrations.has("0291_resource_authority_classification_assertion.sql") &&
        migrations.has("0292_truthful_tenancy_inventory_counters.sql") &&
        migrations.has("0293_confirm_time_rule_rebaseline.sql") &&
        migrations.has("0294_preference_activation_authority.sql")
      ) {
        return includesActivation
          ? "705619256cf0b816ec93b58ed60e2712ad504a330b0d8db9a15b19f0483cb7fc"
          : "43ecc625c1b0817a3e50916c90cdd90e7d167e51904af333eff64ed402a8608d";
      }
      if (migrations.has("0294_preference_activation_authority.sql")) {
        return includesActivation
          ? "58c45453138334cfc41526850177381fa446e6f73f5576e32cc97ccb570903d6"
          : "d60ef212e05de44b89f4bcac106d703a0e1e4ec45b6fb1103e12fb31622e82b3";
      }
      if (
        migrations.has("0289_session_composer_policy_authority.sql") &&
        migrations.has("0291_resource_authority_classification_assertion.sql") &&
        migrations.has("0292_truthful_tenancy_inventory_counters.sql") &&
        migrations.has("0293_confirm_time_rule_rebaseline.sql")
      ) {
        return includesActivation
          ? "14634266ff6ffd06e0084ac8984629e1a75149f8f8aad384f1561678463571ae"
          : "f576c091f4289abd4a0ad0248c5f847dd79f7591d5190ddc77a781c9704a474c";
      }
      if (migrations.has("0293_confirm_time_rule_rebaseline.sql")) {
        return includesActivation
          ? "bfdf235418c655e81831e05604a811a7661e8a42c76e604d17a8f6f48ca0d1b4"
          : "d9e9ecfc95b1157f917e04b17b84c16334afb21bca4e40ed29b911c75df3758b";
      }
      if (
        migrations.has("0289_session_composer_policy_authority.sql") &&
        migrations.has("0291_resource_authority_classification_assertion.sql") &&
        migrations.has("0292_truthful_tenancy_inventory_counters.sql")
      ) {
        return includesActivation
          ? "121d236f3a25a9e50c79f5582a4419ee30600fcd3d6b00e7b9616419d373f7e9"
          : "d43ff8dd934a92e2f7cfc597103a7aa42c5e1581b2989c28870d3365c5b0b082";
      }
      if (migrations.has("0291_resource_authority_classification_assertion.sql")) {
        return includesActivation
          ? "21e06730d96136c97853e3a20ae03ee6a402adea3cf925bdaeea8969ef75f6c0"
          : "9089be79691f652ff4f842372b495f6a638410ace1582f1dd8d3008f15ce3b89";
      }
      if (
        migrations.has("0289_session_composer_policy_authority.sql") &&
        migrations.has("0292_truthful_tenancy_inventory_counters.sql")
      ) {
        return includesActivation
          ? "a5c89d52164373c5c5f853ec4f9de42aa918a191f01169148e49987938806be8"
          : "445368764624c922e43e0a68c9455f0a0906dfcd6517e331088ac9c221218716";
      }
      if (migrations.has("0292_truthful_tenancy_inventory_counters.sql")) {
        return includesActivation
          ? "532bdb23ad599feffcb3ea5ff2a1faf8d24950f9bbb20082ddc9fdb7f5633797"
          : "8f44db797ef5d7ce73f35abac25a6988442b0bb9976dab682a760e98449313f2";
      }
      if (migrations.has("0289_session_composer_policy_authority.sql")) {
        return includesActivation
          ? "4e4ae84b354543aa148f465b6cd0c5fb998809c99d8d154a7a07d9f91599730a"
          : "4b6c07cd2c0efaf5c2648a5b4a1f90417cdfef2f9f97806777dd144a7fc37a3e";
      }
      if (migrations.has("0288_attached_browser_reenrollment.sql")) {
        return includesActivation
          ? "7bf8653b2dd42c53ac011274a9df81d60d0545020252c2492c8dbc55f7c62cfb"
          : "dc3a44166456c5a19a42b9d6d98a83730ff08c4322e9d830a1dbcdf517788ce6";
      }
      if (migrations.has("0287_open_suffix_pending_tool_calls.sql")) {
        return includesActivation
          ? "af2db2108cf92384fbb58a843f6171c78afb47f20c8197f43e080451dfc4218b"
          : "2e30cb89c2746773cfee07c5042001f4616936cd29ff0632b6bbe18b4791de33";
      }
      if (migrations.has("0286_widen_task_note_expiry_ceiling.sql")) {
        return includesActivation
          ? "89e0cab6b961f265045c28cd26ee1d3e33425d2be0c87ff4cfc67a54ea717c15"
          : "f62d97773beb9833d226e99fa9751e61720ac125c5999bf923b03f398444527f";
      }
      if (migrations.has("0285_organization_tenancy_inventory.sql")) {
        return includesActivation
          ? "59f0d00889833944082939a0cbeb609a26b05af7fb2fcfb5f52673f7c1044e3f"
          : "89e2adde661079636aa511db006dfa77d732f86c291203826dfe43318db53140";
      }
      if (migrations.has("0284_truthful_human_confirmed_review_reason.sql")) {
        return includesActivation
          ? "1e752e5d61ead8b60309ea52f47125b8b9af586fc85e452a5ab488b24f157a27"
          : "3020e929f041038334ce80d0cdafb6449ab89cfd83242d14726a340015bfc6b5";
      }
      if (migrations.has("0283_editable_spreadsheet_authored_state.sql")) {
        return includesActivation
          ? "91d77f74362b9327ef25ba20b27c156ee1284e8b29fd00e6483f159a8864aa6d"
          : "1947a669e7f6965ce2906a2c7ddec3e7078cfcf3aebbbe24a438287f7614addd";
      }
      if (migrations.has("0282_variable_set_session_attach_attribution.sql")) {
        return includesActivation
          ? "a5e8ed9034e5a9ff7dcd2aa93ec94dcef535fbbb06f84ea54d0fa26db519a1ad"
          : "37331cb616cdb135701df535414d6eeac212760e4b1ca9c53a2da5252c1610f4";
      }
      if (migrations.has("0281_viewer_holder_authority_claims.sql")) {
        return includesActivation
          ? "c95d0449cae50232c5d27656f040d55cca25499bf06cff4c190df82270e4ae97"
          : "53e214a4d710e8e8126860a04765cc263fdb32abcd0145e6e0aa46b8dcb3e269";
      }
      if (migrations.has("0280_connection_and_variable_set_audit_attribution.sql")) {
        return includesActivation
          ? "55f64e92a35ddd19dedcc7704fa809f0d6436f8c4377c6122956093a6a542592"
          : "36400bc39b43e365b8621b7744e85328fa80b508a6625ffee92f0ddef333c004";
      }
      if (migrations.has("0279_workspace_connection_use_lane.sql")) {
        return includesActivation
          ? "bf0934c13eef8545f3644df2f6a229d4f5b5df0353a9d4422826d7775fa14618"
          : "07d4215ae0fffef40415224d575759e9b7d9cbd19a94d19c063d21a6c312312f";
      }
      if (migrations.has("0278_workspace_membership_removal_fencing.sql")) {
        return includesActivation
          ? "4c6764abf9ef587d79e9c9666bd7e11a329927cb74d794ab8ff0717fd35778a7"
          : "29df8eda7a6b888e03c665ec13227c0c4900b140eade63042d93032f39319b57";
      }
      if (migrations.has("0277_workspace_writer_authority_attribution.sql")) {
        return includesActivation
          ? "b2a805760b1f09c2618b49b952a5cb323812a742dd748c11e48b14699e6deb69"
          : "aa0d9a39c491d2eae385b052ca059f3e4a168b5ccf97ab3cd062ce3e3c2ebc04";
      }
      if (migrations.has("0276_onboarding_proposal_initiating_human_guc.sql")) {
        return includesActivation
          ? "cfd46060ee901c35fa53774626f677f107bd2342823c335089b250f77eab55a6"
          : "a9abad7b40bd8a11b39480a08d5bd7def06e90c720736a284c99ee12ea36c000";
      }
      if (migrations.has("0275_scheduled_connection_authority.sql")) {
        return includesActivation
          ? "a96c53aab72ae5c409bf3a3cfdb5eee8b4aae573495920bbc7053ea556ddcc5e"
          : "8ad26c7145e7fa3e701fa4f6b42cdabf726f6ca494218ba6be3aa68927dcc5a7";
      }
      if (migrations.has("0274_human_confirmed_knowledge_review.sql")) {
        return includesActivation
          ? "f82d0b53ee48801a15d6a76cdd5ecf08a830bf1687037068b30d58f191778e51"
          : "2d98effee255ae4a24c790920c5aabeea91e64714b6a9a2bfa03664bca51bf43";
      }
      if (migrations.has("0272_human_confirmed_learning_activation.sql")) {
        return includesActivation
          ? "a823eeb89e4abd6af928b9f28c20cefaef91a0e8f8b87735c2e5990c7c95fd5c"
          : "afe337b4de24107dcdbc63288d5fc28a43ef6219be804967f9a3170d7c6aeb38";
      }
      if (migrations.has("0271_company_brain_retrieval_only_default.sql")) {
        return includesActivation
          ? "c5879d8afddf36df18a9b8df9ad531c1f479fd139b9678a3fdb5c77e1a44c720"
          : "dcda105aeb348115398008994be9d9f7ef6929d2fce1ec5682a245347eccb58e";
      }
      if (migrations.has("0270_governed_learning_history_inspection.sql")) {
        return includesActivation
          ? "8eac9475295c2efdeee8665d115c8b9c74c1ca8afb12fad1ab81d92694bd2327"
          : "9467f5390de8b2d02a23a1fe3d7f510393cd0d3d2dbf4b4f355ad2e7e2ea7901";
      }
      if (migrations.has("0269_governed_learning_activation_controller.sql")) {
        return includesActivation
          ? "e7d8af71e4a67fda32cdb29cba5a908016b92cde6c8bcf487ba8f1044a0526fa"
          : "2b06423423974899632c1401db71ae01bd42e7a1b17f1fb113488810abc44c19";
      }
      if (migrations.has("0268_governed_learning_decision_receipts.sql")) {
        return includesActivation
          ? "d8f44cf53a2c1db85a2e24609544e14a454c3affb6e8d20e5a41e3f73e1831a7"
          : "129d974d2af0f61dbd4c1d0b6cd020305445ec43bc85f34be27264b10280f16c";
      }
      if (migrations.has("0266_company_brain_context_receipt_inspection.sql")) {
        return includesActivation
          ? "e46b31aeb1e25cc315481ce9523f06dc2cd39a7f9d1a160a75632058c8f8554f"
          : "d31d70e7386ddbc9d15c4b4574c4d2f9823adbbcdebcfe84f605b466b1388dc1";
      }
      if (migrations.has("0261_preference_knowledge_proposal_actor_binding.sql")) {
        return includesActivation
          ? "3d4eb52fca664546de7a6fea355d5289c0044a457400daafd72d7e253ecca624"
          : "1c224ffa4cd47dbbc09880425e879fe56f3606307516bcb6ae4f2dca3d5e8312";
      }
      if (migrations.has("0260_task_note_knowledge_promotion.sql")) {
        return includesActivation
          ? "285908f04e88cb1f2ea38db1d57f6ba40b69000fbeb20a2f34d5de011cb2b58d"
          : "fe69b939f58e49bcc99e28ba57cba430b88122f75030b458c4dde3c8452c214d";
      }
      if (migrations.has("0259_company_brain_context_selection_receipts.sql")) {
        return includesActivation
          ? "59cda520a2634003dd1ee3144d5c9eabf449825efcdf574dc43b00e65d2a05de"
          : "9dc07149adb2813d81c60fbb3f410009e29a9c79223d4ab16fa8694a0cf8c165";
      }
      if (
        migrations.has("0258_three_scope_document_knowledge_authority.sql") &&
        migrations.has("0257_goal_revision_decisions_and_root_constraints.sql")
      ) {
        return includesActivation
          ? "1997fbda36325fff330f3a34870148f1acf77d27fc1c541c67dd26f61e1d9ca5"
          : "bb3497f077a68c8ecb9b1b385067456ea3aa894d282ad0b820d97b55d2d25cc6";
      }
      if (migrations.has("0263_organization_membership_lifecycle.sql")) {
        return includesActivation
          ? "b6129a5f17ca1a93616951acefdcc64ac212f0305a535b86d66124215b8afca0"
          : "21b202c054455b4db494e1ebe72f69ca4da3a0c0e9abdc6398b22f7bb59e2951";
      }
      if (migrations.has("0258_three_scope_document_knowledge_authority.sql")) {
        return includesActivation
          ? "119d394b27853a7c9edfa65be82793cd6e1bac684a32fc2e6524bdd8a8fa225a"
          : "9d0bc49c13b78936d8d8248efe388f15449f87033792a97ec78148dfd047979e";
      }
      if (migrations.has("0257_goal_revision_decisions_and_root_constraints.sql")) {
        return includesActivation
          ? "895bfe1b39d54afff3d8e52cc9beb50ae32d3d7d1e9be6e0a7bc30e39161d427"
          : "72379299ecfe8e35b1f25eed4ec2a37582cbe9efaf93b0c0d26ba28246f3c2aa";
      }
      if (migrations.has("0255_company_brain_governed_write_proposals.sql")) {
        return includesActivation
          ? "7297e2ad81f65cfebfea608a8e541e1f8229e6b0e70f3a8d651319fefa72760d"
          : "6bb2a825b85f0372d6fae7ca45aa43491d47e9283e19456554f8402166a203c9";
      }
      if (migrations.has("0248_terraform_stacks_component_resolution_fence.sql")) {
        if (
          migrations.has("0246_integration_personal_instance_authority.sql") &&
          migrations.has("0241_atomic_personal_resource_delegation.sql")
        ) {
          return includesActivation
            ? "80d175fb7eb7c37c6965f6df657bcefeacf1a454f894f412831c6564060fb23f"
            : "21f47bdcee153ce1552bb6c55c25e62b475cb050c6bc4c7ff627ecc24c7c7c8c";
        }
        if (migrations.has("0246_integration_personal_instance_authority.sql")) {
          return includesActivation
            ? "fd62e02cda3bfcafc0a9e7530713636a52d99cb0185c9c01e56de929af5c7d3a"
            : "6a4c6aa993c9dc1cd3db1b24e2d1e9e527dc3c20113368d9eef88a38da2a9d2a";
        }
        return includesActivation
          ? "c9ee6c1d08989d738c0db3d4372eb0b19b15294a92f21216e08eec3de4260c30"
          : "ece89076dd885e577e756f47ca9c299e25b1df3194a0221286739519ba58b580";
      }
      if (migrations.has("0247_terraform_stacks_provenance_repair.sql")) {
        if (
          migrations.has("0246_integration_personal_instance_authority.sql") &&
          migrations.has("0241_atomic_personal_resource_delegation.sql")
        ) {
          return includesActivation
            ? "ea50aa2d9a6b19febfee39a3b2ee8a077c978c7f1e7c215ece9b8add289a062f"
            : "c0dbc7a03a111d7e5807bcb6c3ef371a95ad2d0b97528c89a0ef3e06ad48317a";
        }
        if (migrations.has("0246_integration_personal_instance_authority.sql")) {
          return includesActivation
            ? "0e98eb9af4b05809821914f2b6cd9ca1dc719b8c7c088f72cfbcbb955c7ec9a8"
            : "e94a784536935dab356f8288a0460bcae1946df5b2e1ffa20ac541244c2139d2";
        }
        return includesActivation
          ? "115a58c544c77745ee9b8af93b6cc58f89d05c618367c0dd706856c789ffd69e"
          : "7aaa4256393e8ef72ee5862ca0c49675252d03f86dfa748436ca9c357f8290d2";
      }
      return sessionVisibilityContractHash(includesActivation);
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
      expect(sourceContract.sha256).toBe(releaseSchemaContractHash(true));
      expect(activationMigration).toMatchObject({
        sha256: "43945bc115ddf5e7b4b6e73a757c6bb63dde6929e1b3a89714c9cf330de87a12",
        deploymentMode: "rolling",
      });
      expect(migrations.get("0236_session_visibility_slack_policy.sql")).toMatchObject({
        sha256: "64f9beb146d973cc0a6ab9f8cdef29955ef9edb68ecc9b07756eda5414709299",
        deploymentMode: "rolling",
      });

      const contractWithoutActivation = await contractWithoutMigrations([
        ...forwardMigrationPaths,
        "0225_session_visibility_fork_activation.sql",
      ]);
      expect(contractWithoutActivation.sha256).toBe(releaseSchemaContractHash(false));
      migrations.delete("0225_session_visibility_fork_activation.sql");
      sourceContract.migrations = contractWithoutActivation.migrations;
      sourceContract.fileCount = contractWithoutActivation.fileCount;
      sourceContract.latestMigration = contractWithoutActivation.latestMigration;
      sourceContract.sha256 = contractWithoutActivation.sha256;
    }
    expect(sourceContract.sha256).toBe(releaseSchemaContractHash(false) ?? currentMainContractHash);
    const contract = {
      ...sourceContract,
      sha256: releaseSchemaContractHash(false) ?? currentMainContractHash,
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
        (migrations.has("0247_terraform_stacks_provenance_repair.sql") ? 1 : 0) +
        (migrations.has("0248_terraform_stacks_component_resolution_fence.sql") ? 1 : 0) +
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
        (migrations.has("0240_enrollment_connection_authority.sql") ? 1 : 0) +
        (migrations.has("0241_atomic_personal_resource_delegation.sql") ? 1 : 0) +
        (migrations.has("0241_enrollment_agent_runtime.sql") ? 1 : 0) +
        (migrations.has("0243_google_drive_object_acl_authority.sql") ? 1 : 0) +
        (migrations.has("0244_slack_app_home_refresh_queue.sql") ? 1 : 0) +
        (migrations.has("0245_model_context_contribution_facts.sql") ? 1 : 0) +
        (migrations.has("0246_integration_personal_instance_authority.sql") ? 1 : 0) +
        (migrations.has("0255_company_brain_governed_write_proposals.sql") ? 1 : 0) +
        (migrations.has("0257_goal_revision_decisions_and_root_constraints.sql") ? 1 : 0) +
        (migrations.has("0258_three_scope_document_knowledge_authority.sql") ? 1 : 0) +
        (migrations.has("0259_company_brain_context_selection_receipts.sql") ? 1 : 0) +
        (migrations.has("0260_task_note_knowledge_promotion.sql") ? 1 : 0) +
        (migrations.has("0261_preference_knowledge_proposal_actor_binding.sql") ? 1 : 0) +
        (migrations.has("0266_company_brain_context_receipt_inspection.sql") ? 1 : 0) +
        (migrations.has("0268_governed_learning_decision_receipts.sql") ? 1 : 0) +
        (migrations.has("0269_governed_learning_activation_controller.sql") ? 1 : 0) +
        (migrations.has("0270_governed_learning_history_inspection.sql") ? 1 : 0) +
        (migrations.has("0271_company_brain_retrieval_only_default.sql") ? 1 : 0) +
        (migrations.has("0272_human_confirmed_learning_activation.sql") ? 1 : 0) +
        (migrations.has("0274_human_confirmed_knowledge_review.sql") ? 1 : 0) +
        (migrations.has("0263_organization_membership_lifecycle.sql") ? 1 : 0) +
        (migrations.has("0275_scheduled_connection_authority.sql") ? 1 : 0) +
        (migrations.has("0276_onboarding_proposal_initiating_human_guc.sql") ? 1 : 0) +
        (migrations.has("0277_workspace_writer_authority_attribution.sql") ? 1 : 0) +
        (migrations.has("0278_workspace_membership_removal_fencing.sql") ? 1 : 0) +
        (migrations.has("0279_workspace_connection_use_lane.sql") ? 1 : 0) +
        (migrations.has("0280_connection_and_variable_set_audit_attribution.sql") ? 1 : 0) +
        (migrations.has("0291_resource_authority_classification_assertion.sql") ? 1 : 0) +
        (migrations.has("0301_session_snapshot_and_pin_visibility.sql") ? 1 : 0) +
        (migrations.has("0300_tenancy_backfill_ledger.sql") ? 1 : 0) +
        (migrations.has("0298_organization_tenancy_parity.sql") ? 1 : 0) +
        (migrations.has("0297_session_ownership_classification_and_backfill.sql") ? 1 : 0) +
        (migrations.has("0299_organization_membership_lock_order.sql") ? 1 : 0) +
        (migrations.has("0281_viewer_holder_authority_claims.sql") ? 1 : 0) +
        (migrations.has("0282_variable_set_session_attach_attribution.sql") ? 1 : 0) +
        (migrations.has("0283_editable_spreadsheet_authored_state.sql") ? 1 : 0) +
        (migrations.has("0284_truthful_human_confirmed_review_reason.sql") ? 1 : 0) +
        (migrations.has("0285_organization_tenancy_inventory.sql") ? 1 : 0) +
        (migrations.has("0286_widen_task_note_expiry_ceiling.sql") ? 1 : 0) +
        (migrations.has("0287_open_suffix_pending_tool_calls.sql") ? 1 : 0) +
        (migrations.has("0288_attached_browser_reenrollment.sql") ? 1 : 0) +
        (migrations.has("0289_session_composer_policy_authority.sql") ? 1 : 0) +
        (migrations.has("0292_truthful_tenancy_inventory_counters.sql") ? 1 : 0) +
        (migrations.has("0293_confirm_time_rule_rebaseline.sql") ? 1 : 0) +
        (migrations.has("0294_preference_activation_authority.sql") ? 1 : 0) +
        (migrations.has("0295_retire_legacy_standing_memory_mode.sql") ? 1 : 0) +
        (migrations.has("0296_force_rls_backfill_noop_repair.sql") ? 1 : 0) +
        (migrations.has("0290_organization_membership_backfill.sql") ? 1 : 0) +
        (migrations.has("0302_personal_workspace_session_ownership.sql") ? 1 : 0) +
        (migrations.has("0303_session_tenancy_product_activation.sql") ? 1 : 0) +
        (migrations.has("0307_session_attention_state.sql") ? 1 : 0) +
        (migrations.has("0308_session_archives.sql") ? 1 : 0) +
        (migrations.has("0309_channel_project_pins.sql") ? 1 : 0) +
        (migrations.has("0310_channel_project_order.sql") ? 1 : 0),
    );
    expect(contract.sha256).toBe(releaseSchemaContractHash(false) ?? currentMainContractHash);
    const latestCompatibleMigration = [
      "0259_company_brain_context_selection_receipts.sql",
      "0258_three_scope_document_knowledge_authority.sql",
      "0257_goal_revision_decisions_and_root_constraints.sql",
      "0255_company_brain_governed_write_proposals.sql",
      "0246_integration_personal_instance_authority.sql",
      "0245_model_context_contribution_facts.sql",
      "0244_slack_app_home_refresh_queue.sql",
      "0243_google_drive_object_acl_authority.sql",
      "0241_enrollment_agent_runtime.sql",
      "0241_atomic_personal_resource_delegation.sql",
      "0240_enrollment_connection_authority.sql",
      "0238_recover_unclaimed_session_turns.sql",
      "0236_session_visibility_slack_policy.sql",
      "0235_canonical_human_login_bindings.sql",
      "0234_xai_subscription_authority.sql",
      "0233_skill_and_integration_authority_cutover.sql",
      "0232_integration_facet_authority_cutover.sql",
      "0231_integration_definition_identity_cutover.sql",
      "0230_user_scoped_variable_sets_rigs.sql",
      "0228_slack_task_policy.sql",
      "0229_slack_inbox_file_fact.sql",
      "0227_slack_native_actions.sql",
      "0224_slack_post_outcome_reconciliation.sql",
      "0223_sessions_channel_fk_validate.sql",
      "0221_sessions_channel_index.sql",
      "0220_memory_slack_append_only_cascade.sql",
      "0219_site_auth_maintenance_sessions.sql",
      "0218_organization_tenancy_foundation.sql",
      "0217_capability_definition_delete_authority.sql",
    ].find((path) => migrations.has(path));
    expect(contract.latestMigration).toBe(
      migrations.has("0310_channel_project_order.sql")
        ? "0310_channel_project_order.sql"
        : migrations.has("0309_channel_project_pins.sql")
          ? "0309_channel_project_pins.sql"
          : migrations.has("0308_session_archives.sql")
            ? "0308_session_archives.sql"
            : migrations.has("0307_session_attention_state.sql")
              ? "0307_session_attention_state.sql"
              : migrations.has("0303_session_tenancy_product_activation.sql")
                ? "0303_session_tenancy_product_activation.sql"
                : migrations.has("0302_personal_workspace_session_ownership.sql")
                  ? "0302_personal_workspace_session_ownership.sql"
                  : migrations.has("0301_session_snapshot_and_pin_visibility.sql")
                    ? "0301_session_snapshot_and_pin_visibility.sql"
                    : migrations.has("0300_tenancy_backfill_ledger.sql")
                      ? "0300_tenancy_backfill_ledger.sql"
                      : migrations.has("0299_organization_membership_lock_order.sql")
                        ? "0299_organization_membership_lock_order.sql"
                        : migrations.has("0298_organization_tenancy_parity.sql")
                          ? "0298_organization_tenancy_parity.sql"
                          : migrations.has("0295_retire_legacy_standing_memory_mode.sql")
                            ? "0295_retire_legacy_standing_memory_mode.sql"
                            : migrations.has("0294_preference_activation_authority.sql")
                              ? "0294_preference_activation_authority.sql"
                              : migrations.has("0293_confirm_time_rule_rebaseline.sql")
                                ? "0293_confirm_time_rule_rebaseline.sql"
                                : migrations.has("0292_truthful_tenancy_inventory_counters.sql")
                                  ? "0292_truthful_tenancy_inventory_counters.sql"
                                  : migrations.has(
                                        "0291_resource_authority_classification_assertion.sql",
                                      )
                                    ? "0291_resource_authority_classification_assertion.sql"
                                    : migrations.has("0290_organization_membership_backfill.sql")
                                      ? "0290_organization_membership_backfill.sql"
                                      : migrations.has("0289_session_composer_policy_authority.sql")
                                        ? "0289_session_composer_policy_authority.sql"
                                        : migrations.has("0288_attached_browser_reenrollment.sql")
                                          ? "0288_attached_browser_reenrollment.sql"
                                          : migrations.has(
                                                "0287_open_suffix_pending_tool_calls.sql",
                                              )
                                            ? "0287_open_suffix_pending_tool_calls.sql"
                                            : migrations.has(
                                                  "0286_widen_task_note_expiry_ceiling.sql",
                                                )
                                              ? "0286_widen_task_note_expiry_ceiling.sql"
                                              : migrations.has(
                                                    "0285_organization_tenancy_inventory.sql",
                                                  )
                                                ? "0285_organization_tenancy_inventory.sql"
                                                : migrations.has(
                                                      "0284_truthful_human_confirmed_review_reason.sql",
                                                    )
                                                  ? "0284_truthful_human_confirmed_review_reason.sql"
                                                  : migrations.has(
                                                        "0283_editable_spreadsheet_authored_state.sql",
                                                      )
                                                    ? "0283_editable_spreadsheet_authored_state.sql"
                                                    : migrations.has(
                                                          "0282_variable_set_session_attach_attribution.sql",
                                                        )
                                                      ? "0282_variable_set_session_attach_attribution.sql"
                                                      : migrations.has(
                                                            "0281_viewer_holder_authority_claims.sql",
                                                          )
                                                        ? "0281_viewer_holder_authority_claims.sql"
                                                        : migrations.has(
                                                              "0280_connection_and_variable_set_audit_attribution.sql",
                                                            )
                                                          ? "0280_connection_and_variable_set_audit_attribution.sql"
                                                          : migrations.has(
                                                                "0279_workspace_connection_use_lane.sql",
                                                              )
                                                            ? "0279_workspace_connection_use_lane.sql"
                                                            : migrations.has(
                                                                  "0278_workspace_membership_removal_fencing.sql",
                                                                )
                                                              ? "0278_workspace_membership_removal_fencing.sql"
                                                              : migrations.has(
                                                                    "0277_workspace_writer_authority_attribution.sql",
                                                                  )
                                                                ? "0277_workspace_writer_authority_attribution.sql"
                                                                : migrations.has(
                                                                      "0276_onboarding_proposal_initiating_human_guc.sql",
                                                                    )
                                                                  ? "0276_onboarding_proposal_initiating_human_guc.sql"
                                                                  : migrations.has(
                                                                        "0275_scheduled_connection_authority.sql",
                                                                      )
                                                                    ? "0275_scheduled_connection_authority.sql"
                                                                    : migrations.has(
                                                                          "0274_human_confirmed_knowledge_review.sql",
                                                                        )
                                                                      ? "0274_human_confirmed_knowledge_review.sql"
                                                                      : migrations.has(
                                                                            "0272_human_confirmed_learning_activation.sql",
                                                                          )
                                                                        ? "0272_human_confirmed_learning_activation.sql"
                                                                        : migrations.has(
                                                                              "0271_company_brain_retrieval_only_default.sql",
                                                                            )
                                                                          ? "0271_company_brain_retrieval_only_default.sql"
                                                                          : migrations.has(
                                                                                "0270_governed_learning_history_inspection.sql",
                                                                              )
                                                                            ? "0270_governed_learning_history_inspection.sql"
                                                                            : migrations.has(
                                                                                  "0269_governed_learning_activation_controller.sql",
                                                                                )
                                                                              ? "0269_governed_learning_activation_controller.sql"
                                                                              : migrations.has(
                                                                                    "0268_governed_learning_decision_receipts.sql",
                                                                                  )
                                                                                ? "0268_governed_learning_decision_receipts.sql"
                                                                                : migrations.has(
                                                                                      "0266_company_brain_context_receipt_inspection.sql",
                                                                                    )
                                                                                  ? "0266_company_brain_context_receipt_inspection.sql"
                                                                                  : migrations.has(
                                                                                        "0261_preference_knowledge_proposal_actor_binding.sql",
                                                                                      )
                                                                                    ? "0261_preference_knowledge_proposal_actor_binding.sql"
                                                                                    : migrations.has(
                                                                                          "0260_task_note_knowledge_promotion.sql",
                                                                                        )
                                                                                      ? "0260_task_note_knowledge_promotion.sql"
                                                                                      : migrations.has(
                                                                                            "0259_company_brain_context_selection_receipts.sql",
                                                                                          )
                                                                                        ? "0259_company_brain_context_selection_receipts.sql"
                                                                                        : migrations.has(
                                                                                              "0258_three_scope_document_knowledge_authority.sql",
                                                                                            )
                                                                                          ? "0258_three_scope_document_knowledge_authority.sql"
                                                                                          : migrations.has(
                                                                                                "0257_goal_revision_decisions_and_root_constraints.sql",
                                                                                              )
                                                                                            ? "0257_goal_revision_decisions_and_root_constraints.sql"
                                                                                            : migrations.has(
                                                                                                  "0255_company_brain_governed_write_proposals.sql",
                                                                                                )
                                                                                              ? "0255_company_brain_governed_write_proposals.sql"
                                                                                              : migrations.has(
                                                                                                    "0248_terraform_stacks_component_resolution_fence.sql",
                                                                                                  )
                                                                                                ? "0248_terraform_stacks_component_resolution_fence.sql"
                                                                                                : migrations.has(
                                                                                                      "0247_terraform_stacks_provenance_repair.sql",
                                                                                                    )
                                                                                                  ? "0247_terraform_stacks_provenance_repair.sql"
                                                                                                  : migrations.has(
                                                                                                        "0263_organization_membership_lifecycle.sql",
                                                                                                      )
                                                                                                    ? "0263_organization_membership_lifecycle.sql"
                                                                                                    : latestCompatibleMigration,
    );
    expect(migrations.get("0289_session_composer_policy_authority.sql")).toMatchObject({
      sha256: "478e7ba49b6940bdd849223a0965b7dcc20a0d4428f0fc85078961dbd3984285",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0293_confirm_time_rule_rebaseline.sql")).toMatchObject({
      sha256: "0a208593d2ab2190407ef127af1398be88765ebe978afe0ca18c3ce5bd32e617",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0294_preference_activation_authority.sql")).toMatchObject({
      sha256: "0e26e7b9869eb91946932b0ba255d4493e48a80fc62923b3ae54580997d6fbbb",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0288_attached_browser_reenrollment.sql")).toMatchObject({
      sha256: "a225b10590a065397ee35c810e6fb962e451b1745677ac4a0212431e60f2b3b6",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0292_truthful_tenancy_inventory_counters.sql")).toMatchObject({
      sha256: "da2484dce64877a3ac254682640148c48747ec89b36737204824e65600c476d5",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0283_editable_spreadsheet_authored_state.sql")).toMatchObject({
      sha256: "b746e4ef7738f755cd8578faccf54582433d69987f155b1c57896e07f92e63eb",
      deploymentMode: "maintenance",
    });
    expect(migrations.get("0263_organization_membership_lifecycle.sql")).toMatchObject({
      sha256: "1119554dc06a768c92f7189a97b438ebdc011747a6c8d7cefc992962f2293593",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0285_organization_tenancy_inventory.sql")).toMatchObject({
      sha256: "942c606d0d85064f427d2374aba9851c5c3087a49764b9f61bef76d3b8dac0f7",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0282_variable_set_session_attach_attribution.sql")).toMatchObject({
      sha256: "ad47dfc672380757da5a46a049b56ff72af54a7fffb73e929e364c6ae29cfda7",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0281_viewer_holder_authority_claims.sql")).toMatchObject({
      sha256: "17d90d51ca95222aec87abf296a3a3936537739a40d4700c932f1cfad6742f00",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0280_connection_and_variable_set_audit_attribution.sql")).toMatchObject({
      sha256: "6157e7d2023622a332faddf0f7a823bc941f0bce6e866523736866b1eabad556",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0279_workspace_connection_use_lane.sql")).toMatchObject({
      sha256: "db923fce3e8f6c12a1230add7b9e92fb0b6ba1090f456474069dee401c61367c",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0278_workspace_membership_removal_fencing.sql")).toMatchObject({
      sha256: "d16d4e0632ed1315ae32ba928d84a218729421e7d2ccfad5ad5806eb44ab0771",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0277_workspace_writer_authority_attribution.sql")).toMatchObject({
      sha256: "74c27f9366ae809d6e0300991c3d5f279138b3e2673ea3fb16c94c1f4d3ecfb6",
      deploymentMode: "rolling",
    });
    expect(migrations.get("0275_scheduled_connection_authority.sql")).toMatchObject({
      sha256: "99d20fdb37735b1bb0b95f3b94ebbaf10f8f44ab8484a1e8d1095e73d6f76ec9",
      deploymentMode: "maintenance",
    });
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
    if (migrations.has("0247_terraform_stacks_provenance_repair.sql")) {
      expect(migrations.get("0247_terraform_stacks_provenance_repair.sql")).toMatchObject({
        sha256: "0bb6196b0a89e4b9d2271ec098793e2c8cbeecf4c9ef7ff036f3ed26e1792cff",
        deploymentMode: "maintenance",
      });
    }
    if (migrations.has("0248_terraform_stacks_component_resolution_fence.sql")) {
      expect(migrations.get("0248_terraform_stacks_component_resolution_fence.sql")).toMatchObject({
        sha256: "4fe9beb4cdf182a4391f7268bc83d11fdbc3125c105d48c8ca0bf41349be095f",
        deploymentMode: "maintenance",
      });
    }
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
    if (migrations.has("0241_atomic_personal_resource_delegation.sql")) {
      expect(migrations.get("0241_atomic_personal_resource_delegation.sql")).toMatchObject({
        sha256: "4a8e3752decc0a497f8eb00de223923747bf2994a0f76ccb977ce7f3ced9e5be",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0243_google_drive_object_acl_authority.sql")) {
      expect(migrations.get("0243_google_drive_object_acl_authority.sql")).toMatchObject({
        sha256: "1cc4b297460ba64d252230ceddc9eaaf4d6ea9b02afcd56518900d5b569bfcfe",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0245_model_context_contribution_facts.sql")) {
      expect(migrations.get("0245_model_context_contribution_facts.sql")).toMatchObject({
        sha256: "437bb07ffe12f9c714bd2a40d0ecd8ed9df1fd9003f4d057fe11101999841f40",
        deploymentMode: "rolling",
      });
    }
    if (migrations.has("0255_company_brain_governed_write_proposals.sql")) {
      expect(migrations.get("0255_company_brain_governed_write_proposals.sql")).toMatchObject({
        sha256: "5d6527267b8de9cb9539e97a0cd30051dc9b2059fd5935261aa8c762d5d6a0d3",
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
