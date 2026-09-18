import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  changePreferenceRegistryScope,
  applySkillLifecycle,
  createDb,
  installPortableSkill,
  type InstallPortableSkillInput,
  createPrReviewAppRegistration,
  createPrReviewRepositoryBinding,
  createAutomationSource,
  createAutomationTrigger,
  createAutomationRun,
  recordAutomationEvent,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { migrateBefore } from "./helpers/historical-schema";

const migration = "0482_remove_packs.sql";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

test("removes Packs under a non-bypass owner while preserving independent Skill authority and history", async () => {
  const fixture = await acquireOwnerMigratedTestDatabase("remove-packs");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  let client: ReturnType<typeof createDb> | undefined;
  try {
    await migrateBefore(fixture.ownerUrl, migration, {
      applicationDatabaseRoles: ["opengeni_app"],
    });
    await provisionRoles(fixture.adminUrl, {
      appPassword: fixture.appPassword,
      temporalDatabases: [],
    });
    const appUrl = new URL(fixture.adminUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = fixture.appPassword;
    client = createDb(appUrl.toString());
    const grant = (
      await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: crypto.randomUUID(),
        accountName: "Removal test",
        workspaceExternalSource: "test",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Removal test",
        subjectId: "human:removal-test",
      })
    ).workspaceGrants[0]!;
    const tenant = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: grant.subjectId,
    };
    const sessionTemplate = {
      prompt: "Review",
      instructions: null,
      resources: [],
      skills: [],
      tools: [],
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: [],
      model: null,
      reasoningEffort: null,
      sandboxBackend: null,
      policyRole: null,
      metadata: {},
    };
    const registration = await createPrReviewAppRegistration(client.db, {
      ...tenant,
      name: "Review bot",
      provider: "github",
      providerBaseUrl: "https://github.com",
      appId: "123",
      credentialKind: "github_app",
      credentialEncrypted: "fixture-encrypted-key",
      accessTokenExpiresAt: null,
      webhookAuthKind: "hmac_sha256",
      webhookSecretEncrypted: "fixture-secret",
      webhookUsername: null,
    });
    const repository = await createPrReviewRepositoryBinding(client.db, {
      ...tenant,
      registrationId: registration.id,
      provider: "github",
      repositoryUri: "https://github.com/example/repo.git",
      repositoryFullName: "example/repo",
      providerRepositoryId: "123",
      installationId: "456",
      projectId: null,
      model: null,
      additionalInstructions: null,
      status: "active",
      adapterId: "source-control.pull-request.v1",
      eventTypes: ["pull_request.review_requested"],
      configuration: {},
      sessionTemplate,
    });
    const ordinary = await createAutomationSource(client.db, {
      ...tenant,
      webhookSecretEncrypted: "fixture-secret",
      request: {
        name: "Pack-only events",
        adapterId: "signed-json.v1",
        webhookSecret: "fixture-secret",
        configuration: {},
      },
    });
    const ordinaryTrigger = await createAutomationTrigger(client.db, {
      ...tenant,
      adapterId: ordinary.adapterId,
      request: {
        sourceId: ordinary.id,
        name: "Pack-only trigger",
        eventTypes: ["build.failed"],
        configuration: {},
        parameters: {},
        sessionTemplate,
        status: "active",
      },
    });
    const seedRun = async (sourceId: string, triggerId: string, adapterId: string) => {
      const occurrenceKey = crypto.randomUUID();
      const event = await recordAutomationEvent(client!.db, {
        ...tenant,
        sourceId,
        sourceVersion: 1,
        sourceConfiguration: {},
        matchedTriggerRevisions: [{ triggerId, revision: 1 }],
        deliveryKey: crypto.randomUUID(),
        requestDigest: "b".repeat(64),
        normalizedEvent: {
          adapterId,
          eventType: "build.failed",
          occurrenceKey,
          occurredAt: null,
          subject: null,
          resource: null,
          payload: {},
        },
      });
      const run = await createAutomationRun(client!.db, {
        ...tenant,
        sourceId,
        triggerId,
        triggerRevision: 1,
        eventId: event.event.id,
        occurrenceKey,
        acceptedExecution: {
          version: 1,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sourceId,
          sourceVersion: 1,
          triggerId,
          triggerRevision: 1,
          eventId: event.event.id,
          adapterId,
          occurrenceKey,
          initialMessage: "Review",
          sessionTemplate,
          serviceSubjectId: `automation:${triggerId}`,
          serviceLabel: "Test automation",
          provenance: {},
        },
      });
      return { eventId: event.event.id, runId: run.run.id };
    };
    const removedRun = await seedRun(ordinary.id, ordinaryTrigger.id, ordinary.adapterId);
    const retainedRun = await seedRun(
      registration.sourceId,
      repository.triggerId,
      "source-control.pull-request.v1",
    );
    await fixture.admin`UPDATE automation_runs SET status='dispatched' WHERE id=${retainedRun.runId}`;
    const retainedRunBefore =
      await fixture.admin`SELECT row_to_json(r) AS value FROM automation_runs r WHERE id=${retainedRun.runId}`;
    const [independentOperation] = await fixture.admin`INSERT INTO capability_operations
      (account_id,workspace_id,idempotency_key,request_digest,kind,target_kind,target_id,created_by_subject_id)
      VALUES(${grant.accountId},${grant.workspaceId},${crypto.randomUUID()},${"c".repeat(64)},'install','plugin','independent-plugin',${grant.subjectId}) RETURNING id`;
    // Historical ownership is seeded with SQL, never resurrected as runtime APIs.
    const manifest = { id: "removed-test-pack", name: "Removed test pack" };
    await fixture.admin`INSERT INTO workspace_packs(account_id,workspace_id,pack_id,manifest)
      VALUES(${grant.accountId},${grant.workspaceId},${manifest.id},${fixture.admin.json(manifest)})`;
    const [pack] =
      await fixture.admin`INSERT INTO pack_installations(account_id,workspace_id,pack_id,manifest_snapshot,manifest_digest,installed_by_subject_id)
      VALUES(${grant.accountId},${grant.workspaceId},${manifest.id},${fixture.admin.json(manifest)},${"a".repeat(64)},${grant.subjectId}) RETURNING id`;
    await fixture.admin`UPDATE automation_sources SET pack_installation_id=${pack!.id},pack_connector_id='events'
      WHERE id IN (${registration.sourceId},${ordinary.id})`;
    await fixture.admin`UPDATE automation_triggers SET pack_installation_id=${pack!.id},pack_template_id='review'
      WHERE id IN (${repository.triggerId},${ordinaryTrigger.id})`;
    const reviewBefore =
      await fixture.admin`SELECT row_to_json(r) AS value FROM pr_review_app_registrations r WHERE id=${registration.id}`;
    const bindingBefore =
      await fixture.admin`SELECT row_to_json(r) AS value FROM pr_review_repository_bindings r WHERE id=${repository.id}`;
    const revisionBefore =
      await fixture.admin`SELECT row_to_json(r) AS value FROM automation_trigger_revisions r WHERE trigger_id=${repository.triggerId}`;
    const installed: Record<string, Awaited<ReturnType<typeof installPortableSkill>>> = {};
    for (const name of ["source-only", "shared", "customized", "rescoped"]) {
      const content = `---\nname: ${name}\ndescription: Test ${name}.\n---\nTest ${name}.`;
      const input: InstallPortableSkillInput = {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        skillActor: { kind: "human", subjectId: grant.subjectId, principalKind: "human_session" },
        skillOperationId: crypto.randomUUID(),
        capabilityId: `skill:${name}`,
        pluginKey: `skill/test/${name}`,
        source: "github",
        sourceUrl: `https://example.test/${name}`,
        repositoryUrl: "https://example.test/skills",
        sourceCommit: "a".repeat(40),
        sourcePath: name,
        name,
        description: `Test ${name}.`,
        contentSha256: sha256(content),
        totalBytes: Buffer.byteLength(content),
        files: [
          {
            path: "SKILL.md",
            content,
            byteSize: Buffer.byteLength(content),
            contentSha256: sha256(content),
          },
        ],
      };
      const skill = await installPortableSkill(client.db, input);
      installed[name] = skill;
      await fixture.admin`INSERT INTO capability_component_owners(account_id,workspace_id,facet_installation_id,owner_kind,owner_id,removable)
        VALUES(${grant.accountId},${grant.workspaceId},${skill.facetInstallationId},'pack','historical-pack-owner',false)`;
      if (name !== "shared")
        await fixture.admin`DELETE FROM capability_component_owners WHERE facet_installation_id=${skill.facetInstallationId} AND owner_kind='direct'`;
    }
    const governance = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actorSubjectId: grant.subjectId,
      principalKind: "human_session",
      expectedScopeVersion: 1,
      authorizeScope: () => {},
      reason: "Independent human change",
    };
    await applySkillLifecycle(
      client.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        actor: { kind: "human", subjectId: grant.subjectId, principalKind: "human_session" },
      },
      {
        operation: "save",
        operationId: crypto.randomUUID(),
        skillId: installed.customized!.skillReceipt.skillId,
        expectedRevisionId: installed.customized!.skillReceipt.revisionId,
        expectedScopeVersion: 1,
        files: [
          {
            path: "SKILL.md",
            content:
              "---\nname: customized\ndescription: Customized guidance.\n---\nHuman customized guidance",
          },
        ],
        reason: "Independent human customization",
      },
    );
    await changePreferenceRegistryScope(client.db, {
      ...governance,
      preferenceId: installed.rescoped!.skillReceipt.skillId,
      scope: "user",
    });
    const revisionsBefore =
      await fixture.admin`SELECT id,content_hash FROM preference_registry_revisions ORDER BY id`;
    const [before] =
      await fixture.admin`SELECT count(*)::int AS count FROM preference_registry_events`;
    await expect(
      migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] }),
    ).rejects.toThrow("drained application sessions");
    expect(
      await fixture.admin`SELECT id FROM pack_installations WHERE id=${pack!.id}`,
    ).toHaveLength(1);
    await client.close();
    client = undefined;
    await expect(
      migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] }),
    ).rejects.toThrow("Settle Pack automation runs");
    expect(
      await fixture.admin`SELECT id FROM automation_runs WHERE id=${removedRun.runId}`,
    ).toHaveLength(1);
    await fixture.admin`UPDATE automation_runs SET status='failed' WHERE id=${removedRun.runId}`;
    await migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    const heads = await fixture.admin`SELECT id,status FROM preference_registry_preferences`;
    expect(heads.find((h) => h.id === installed["source-only"]!.skillReceipt.skillId)?.status).toBe(
      "inactive",
    );
    for (const name of ["shared", "customized", "rescoped"])
      expect(heads.find((h) => h.id === installed[name]!.skillReceipt.skillId)?.status).toBe(
        "active",
      );
    expect([
      ...(await fixture.admin`SELECT id,content_hash FROM preference_registry_revisions ORDER BY id`),
    ]).toEqual([...revisionsBefore]);
    const [after] =
      await fixture.admin`SELECT count(*)::int AS count FROM preference_registry_events`;
    expect(after!.count).toBe(before!.count + 1);
    const [tables] =
      await fixture.admin`SELECT to_regclass('workspace_packs') AS manifests,to_regclass('pack_installations') AS installations,to_regclass('pack_installation_components') AS components`;
    expect(tables).toEqual({ manifests: null, installations: null, components: null });
    expect(
      await fixture.admin`SELECT id FROM capability_component_owners WHERE owner_kind='pack'`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','opengeni_private') AND p.prokind='f'
      AND p.prosrc ~ '(workspace_packs|pack_installations|pack_installation_components)'`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT attname FROM pg_attribute WHERE attrelid IN ('automation_sources'::regclass,'automation_triggers'::regclass)
      AND NOT attisdropped AND attname LIKE 'pack_%'`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT relname FROM pg_class WHERE relname IN ('capability_component_owners','preference_registry_preferences','automation_sources') AND NOT relforcerowsecurity`,
    ).toHaveLength(0);
    expect([
      ...(await fixture.admin`SELECT row_to_json(r) AS value FROM pr_review_app_registrations r WHERE id=${registration.id}`),
    ]).toEqual([...reviewBefore]);
    expect([
      ...(await fixture.admin`SELECT row_to_json(r) AS value FROM pr_review_repository_bindings r WHERE id=${repository.id}`),
    ]).toEqual([...bindingBefore]);
    expect([
      ...(await fixture.admin`SELECT row_to_json(r) AS value FROM automation_trigger_revisions r WHERE trigger_id=${repository.triggerId}`),
    ]).toEqual([...revisionBefore]);
    expect(
      await fixture.admin`SELECT id FROM automation_sources WHERE id=${registration.sourceId}`,
    ).toHaveLength(1);
    expect(
      await fixture.admin`SELECT id FROM automation_triggers WHERE id=${repository.triggerId}`,
    ).toHaveLength(1);
    expect(
      await fixture.admin`SELECT id FROM automation_sources WHERE id=${ordinary.id}`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT id FROM automation_triggers WHERE id=${ordinaryTrigger.id}`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT proname FROM pg_proc WHERE proname IN ('skill_source_has_effective_owner','skill_publish_finalized_owner')
      AND NOT proconfig @> ARRAY['search_path=public, pg_catalog, pg_temp']`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT id FROM automation_runs WHERE id=${removedRun.runId}`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT id FROM automation_trigger_events WHERE id=${removedRun.eventId}`,
    ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT run_id FROM automation_run_event_links WHERE run_id=${removedRun.runId}`,
    ).toHaveLength(0);
    expect([
      ...(await fixture.admin`SELECT row_to_json(r) AS value FROM automation_runs r WHERE id=${retainedRun.runId}`),
    ]).toEqual([...retainedRunBefore]);
    expect(
      await fixture.admin`SELECT id FROM automation_trigger_events WHERE id=${retainedRun.eventId}`,
    ).toHaveLength(1);
    expect(
      await fixture.admin`SELECT run_id FROM automation_run_event_links WHERE run_id=${retainedRun.runId}`,
    ).toHaveLength(1);
    expect(
      await fixture.admin`SELECT id FROM capability_operations WHERE id=${independentOperation!.id} AND status='pending'`,
    ).toHaveLength(1);
    for (const name of ["source-only", "customized", "rescoped"])
      expect(
        await fixture.admin`SELECT preference_id FROM skill_source_bindings WHERE preference_id=${installed[name]!.skillReceipt.skillId}`,
      ).toHaveLength(0);
    expect(
      await fixture.admin`SELECT preference_id FROM skill_source_bindings WHERE preference_id=${installed.shared!.skillReceipt.skillId}`,
    ).toHaveLength(1);
    // A committed retry is a ledger no-op, including Skill event count.
    await migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    const [replayed] =
      await fixture.admin`SELECT count(*)::int AS count FROM preference_registry_events`;
    expect(replayed!.count).toBe(after!.count);
  } finally {
    await client?.close();
    await fixture.release();
  }
}, 180_000);
