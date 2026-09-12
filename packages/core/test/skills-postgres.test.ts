import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createHash } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getAgentLearningSettings,
  saveAgentLearningSettings,
  withSessionRlsActorContext,
  type DbClient,
  installPortableSkill,
  listInstalledPortableSkills,
  type InstallPortableSkillInput,
  uninstallPortableSkill,
  getCurrentPreferenceRegistryGovernanceMetadata,
  assertSkillReadAttempt,
  listSkillDescriptors,
  replayPortableSkillInstall,
  createPreferenceRegistryProposal,
  activatePreferenceRegistryRevision,
  correctPreferenceRegistry,
  applySkillLifecycle,
  confirmSkillHumanResponse,
  skillReviewResolution,
  acceptSessionHumanInputResponse,
  appendSessionEvents,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  preparePackInstallationOperation,
  finalizePackInstallationOperation,
  preparePluginPackageInstall,
  finalizePluginPackageInstall,
  deleteWorkspace,
  deleteWorkspaceIfQuiescent,
  createWorkspace,
  withWorkspaceRls,
  supersedePreferenceRegistry,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  appendKnowledgeSourceAclVersion,
  upsertKnowledgeSourceObject,
  appendKnowledgeDocumentVersion,
  upsertKnowledgeEntity,
  upsertKnowledgeFact,
  appendKnowledgeClaim,
  appendKnowledgeClaimEvidence,
  createKnowledgeChangeProposal,
  type Database,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { SkillSaveInput } from "@opengeni/contracts";
import {
  CapabilityPack,
  stableJson,
  skillReviewHumanInput,
  type SkillReviewReference,
} from "@opengeni/contracts";
import { approveSkill, listSkills, readSkill, restoreSkill, saveSkill } from "../src/domain/skills";
import { serializeHumanInputRequests } from "../../runtime/src/run-events";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const skillMarkdown = (body: string) =>
  `---\nname: test-skill\ndescription: Test Skill folder\n---\n${body}`;
async function expectDatabaseGuard(operation: Promise<unknown>, message: string) {
  let rejected = false;
  try {
    await operation;
  } catch (error) {
    rejected = true;
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join("\n")).toContain(message);
  }
  expect(rejected).toBe(true);
}

async function seedOrgScopedCompanyBrainReceipt(
  db: Database,
  admin: postgres.Sql,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    preferenceId: string;
    revisionId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
  },
) {
  const scope = { kind: "organization" as const, workspaceId: null, subjectId: null };
  const actor = {
    kind: "human" as const,
    subjectId: input.actorSubjectId,
    initiatingHumanSubjectId: input.actorSubjectId,
  };
  const ctx = { accountId: input.accountId, workspaceId: input.workspaceId, actor };
  const label = `receipt-${crypto.randomUUID()}`;
  const provider = await upsertKnowledgeProvider(db, {
    ...ctx,
    scope,
    operationId: crypto.randomUUID(),
    providerKey: label,
    externalTenantId: label,
  });
  const source = await upsertKnowledgeSource(db, {
    ...ctx,
    scope,
    operationId: crypto.randomUUID(),
    providerId: provider.id,
    externalSourceId: label,
    sourceKind: "test",
  });
  const acl = await appendKnowledgeSourceAclVersion(db, {
    ...ctx,
    operationId: crypto.randomUUID(),
    sourceId: source.id,
    audience: scope,
    expectedSourceLifecycleGeneration: source.lifecycleGeneration,
    expectedAclGeneration: 0,
    aclVersion: "v1",
    agentAccess: true,
    reasonCode: "receipt-fixture",
  });
  const object = await upsertKnowledgeSourceObject(db, {
    ...ctx,
    operationId: crypto.randomUUID(),
    sourceId: source.id,
    externalObjectId: label,
  });
  const contentHash = createHash("sha256").update(label).digest("hex");
  const version = await appendKnowledgeDocumentVersion(db, {
    ...ctx,
    operationId: crypto.randomUUID(),
    objectId: object.id,
    expectedSourceLifecycleGeneration: source.lifecycleGeneration,
    expectedObjectLifecycleGeneration: object.lifecycleGeneration,
    expectedVersionGeneration: 0,
    externalVersionId: "v1",
    contentSha256: contentHash,
    ingestionKey: `${label}-ingestion`,
    aclVersionId: acl.id,
    aclGeneration: acl.generation,
    reasonCode: "receipt-fixture",
  });
  const entity = await upsertKnowledgeEntity(db, {
    ...ctx,
    scope,
    operationId: crypto.randomUUID(),
    entityType: "ways-of-working",
    normalizedKey: label,
    displayName: "Company-brain receipt fixture",
  });
  const fact = await upsertKnowledgeFact(db, {
    ...ctx,
    operationId: crypto.randomUUID(),
    subjectEntityId: entity.id,
    predicateKey: "ways.company-brain-receipt",
    object: { kind: "text", value: "Historical company-brain preference proposal" },
  });
  const claim = await appendKnowledgeClaim(db, {
    ...ctx,
    operationId: crypto.randomUUID(),
    factId: fact.id,
    origin: "inferred",
    confidenceBps: 9000,
    effectiveAt: new Date(Date.now() - 1000).toISOString(),
    extractionMethod: "test",
  });
  const evidence = await appendKnowledgeClaimEvidence(db, {
    ...ctx,
    operationId: crypto.randomUUID(),
    claimId: claim.id,
    documentVersionId: version.id,
    polarity: "supports",
    contentHash,
  });
  const proposal = await createKnowledgeChangeProposal(db, {
    ...ctx,
    operationId: crypto.randomUUID(),
    claimId: claim.id,
    evidenceId: evidence.id,
    targetKind: "preference",
    targetScope: "organization",
    targetKey: "legacy-company-brain",
    content: "Historical company-brain preference proposal",
  });
  const [event] =
    await admin`SELECT id FROM preference_registry_events WHERE preference_id=${input.preferenceId} AND type='proposal_created'`;
  if (!event) throw new Error("expected proposal_created event");
  const receiptId = crypto.randomUUID();
  await admin`INSERT INTO company_brain_preference_proposal_receipts (
      id, account_id, workspace_id, operation_id, input_hash, knowledge_proposal_id,
      preference_id, revision_id, creation_event_id, session_id, turn_id, attempt_id,
      execution_generation, actor_subject_id, initiating_human_subject_id)
    VALUES (
      ${receiptId}, ${input.accountId}, ${input.workspaceId}, ${crypto.randomUUID()}, ${contentHash},
      ${proposal.id}, ${input.preferenceId}, ${input.revisionId}, ${event.id},
      ${input.sessionId}, ${input.turnId}, ${input.attemptId}, 1,
      ${input.actorSubjectId}, ${input.actorSubjectId})`;
  return { receiptId, proposalId: proposal.id };
}
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_SKILLS_TEST_ADMIN_URL;
  if (adminUrl) {
    await migrate(adminUrl);
    const password = crypto.randomUUID();
    await provisionRoles(adminUrl, { appPassword: password });
    const parsed = new URL(adminUrl);
    const appUrl = `postgres://opengeni_app:${password}@127.0.0.1:${parsed.port || "5432"}${parsed.pathname}`;
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      adminUrl,
      appUrl,
      admin,
      release: async () => {
        await admin.end();
      },
    };
  } else shared = await acquireSharedTestDatabase("unified-skills");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("PostgreSQL required");
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(mode: "off" | "suggest" | "automatic" | null) {
  const key = crypto.randomUUID();
  const subjectId = `user:skill-${key}`;
  const grant = (
    await bootstrapWorkspace(client!.db, {
      accountExternalSource: "test",
      accountExternalId: key,
      accountName: "Skills test",
      workspaceExternalSource: "test",
      workspaceExternalId: key,
      workspaceName: "Skills test",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const context = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const human = {
    ...context,
    actor: { kind: "human", subjectId, principalKind: "human_session" } as const,
  };
  if (mode !== null) {
    await saveAgentLearningSettings(
      client!.db,
      {
        ...human,
        actor: { ...human.actor, settingsScopes: ["workspace"] },
      },
      {
        scope: "workspace",
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        settings: {
          knowledge: "automatic",
          instructions: "review_first",
          skills: mode === "suggest" ? "review_first" : mode,
        },
      },
    );
  }
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client!.db, {
      ...context,
      initialMessage: "test Skills",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared!.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim','1',true)`;
    await sql`insert into session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
      status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,
      initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id)
      values(${turnId},${context.accountId},${context.workspaceId},${session.id},${crypto.randomUUID()},${turnId},
        'running','user',1,'test','test-model','medium','none',1,'subject',${subjectId},'{}',${subjectId})`;
    await sql`update sessions set active_turn_id=${turnId},status='running' where id=${session.id} and workspace_id=${context.workspaceId}`;
    await sql`update session_turns set active_attempt_id=${attemptId} where id=${turnId} and workspace_id=${context.workspaceId}`;
    await sql`insert into session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
      temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
      values(${attemptId},${context.accountId},${context.workspaceId},${session.id},${turnId},1,'running',${turnId},${attemptId},${attemptId},0,'{}')`;
  });
  const agent = {
    ...context,
    actor: {
      kind: "agent",
      sessionId: session.id,
      turnId,
      attemptId,
      executionGeneration: 1,
    } as const,
  };
  const input: SkillSaveInput = {
    ...human,
    operationId: crypto.randomUUID(),
    skillId: crypto.randomUUID(),
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    stableKey: `test-${key}`,
    files: [
      { path: "SKILL.md", content: skillMarkdown("# Test Skill\nUse original behavior.") },
      { path: "references/context.txt", content: "context" },
    ],
    reason: "Skill test",
  };
  return { context, human, agent, input };
}

describe("unified Skill real PostgreSQL lifecycle", () => {
  for (const kind of ["pack", "plugin"] as const) {
    for (const scenario of [
      "suggest",
      "automatic",
      "customized",
      "policy_off",
      "superseded",
      "human_off",
      "attempt_ended",
    ] as const) {
      test(`${kind} finalization atomically handles ${scenario} guidance and preserves historical snapshots`, async () => {
        if (!client) return;
        const mode = scenario === "suggest" ? "suggest" : "automatic";
        const f = await fixture(scenario === "human_off" ? "off" : mode);
        const key = crypto.randomUUID();
        const digest = (value: string) => createHash("sha256").update(value).digest("hex");
        const scope = { ...f.context, subjectId: f.human.actor.subjectId };
        const pack = CapabilityPack.parse({
          id: `composite-${key}`,
          name: "Composite test",
          description: "Composite publication test",
          role: "test",
          category: "test",
          version: "1",
        });
        const packInput = {
          ...scope,
          pack,
          manifestDigest: digest(stableJson(pack)),
          selectedRigId: null,
          metadata: {},
          idempotencyKey: crypto.randomUUID(),
          requestDigest: digest(key),
        };
        const pluginInput = {
          ...scope,
          pluginKey: `plugin/composite/${key}`,
          version: "1",
          name: "Composite test",
          description: "Composite publication test",
          category: "test",
          tags: [],
          manifestDigest: digest(stableJson(pack)),
          manifest: { components: [], bom: [] },
          idempotencyKey: crypto.randomUUID(),
          requestDigest: digest(key),
        };
        const preparedPack =
          kind === "pack" ? await preparePackInstallationOperation(client.db, packInput) : null;
        const preparedPlugin =
          kind === "plugin" ? await preparePluginPackageInstall(client.db, pluginInput) : null;
        const ownerId = preparedPack?.installation.id ?? preparedPlugin!.pluginInstallationId;
        const content = skillMarkdown("Do not publish before composite commit");
        const install: InstallPortableSkillInput = {
          ...scope,
          skillActor: scenario === "human_off" ? f.human.actor : f.agent.actor,
          skillOperationId: crypto.randomUUID(),
          capabilityId: `skill:${key}`,
          pluginKey: `skill/composite/${key}`,
          source: "github",
          sourceUrl: "https://example.test/composite",
          repositoryUrl: "https://example.test/composite",
          sourceCommit: "a".repeat(40),
          sourcePath: key,
          name: "test-skill",
          description: "Test Skill folder",
          contentSha256: digest(content),
          totalBytes: Buffer.byteLength(content),
          files: [
            {
              path: "SKILL.md",
              content,
              byteSize: Buffer.byteLength(content),
              contentSha256: digest(content),
            },
          ],
          owner: { kind, id: ownerId, removable: false },
        };
        const child = await installPortableSkill(client.db, install);
        expect(child.skillReceipt.outcome).toBe("pending");
        expect(child.skillReceipt.pendingReason).toBe(
          mode === "automatic" ? "source_finalization" : "approval",
        );
        expect(await listSkillDescriptors(client.db, f.context)).toEqual([]);
        expect(await listInstalledPortableSkills(client.db, f.context.workspaceId)).toEqual([]);
        await expectDatabaseGuard(
          approveSkill(client.db, {
            ...f.human,
            operationId: crypto.randomUUID(),
            skillId: child.skillReceipt.skillId,
            revisionId: child.skillReceipt.revisionId,
            expectedRevisionId: null,
            expectedScopeVersion: 1,
            reason: "Cannot approve unfinished owner",
          }),
          "finalized source owner",
        );
        await expectDatabaseGuard(
          activatePreferenceRegistryRevision(client.db, {
            ...f.context,
            actorSubjectId: scope.subjectId,
            principalKind: "human_session",
            preferenceId: child.skillReceipt.skillId,
            revisionId: child.skillReceipt.revisionId,
            expectedCurrentRevisionId: null,
            expectedScopeVersion: 1,
            authorizeScope: () => {},
            reason: "Legacy approval cannot bypass owner finalization",
          }),
          "finalized source owner",
        );
        const [clock] = await shared!.admin`SELECT clock_timestamp() AS at`;
        let retainedChild = child;
        if (scenario === "superseded") {
          const changedContent = skillMarkdown("Newest deferred source wins");
          retainedChild = await installPortableSkill(client.db, {
            ...install,
            skillOperationId: crypto.randomUUID(),
            sourceCommit: "b".repeat(40),
            contentSha256: digest(changedContent),
            totalBytes: Buffer.byteLength(changedContent),
            files: [
              {
                path: "SKILL.md",
                content: changedContent,
                byteSize: Buffer.byteLength(changedContent),
                contentSha256: digest(changedContent),
              },
            ],
          });
        }
        if (scenario === "customized") {
          await saveSkill(client.db, {
            ...f.input,
            skillId: child.skillReceipt.skillId,
            operationId: crypto.randomUUID(),
            files: [{ path: "SKILL.md", content: skillMarkdown("Human customization wins") }],
          });
        } else if (scenario === "policy_off") {
          const authority = {
            ...f.human,
            actor: { ...f.human.actor, settingsScopes: ["workspace" as const] },
          };
          const policy = await getAgentLearningSettings(client.db, authority, "workspace");
          await saveAgentLearningSettings(client.db, authority, {
            scope: "workspace",
            operationId: crypto.randomUUID(),
            expectedVersion: policy.version,
            settings: { ...policy.settings, skills: "off" },
          });
        } else if (scenario === "attempt_ended") {
          await shared!
            .admin`UPDATE session_turn_attempts SET state='closed',outcome='completed',closed_at=now() WHERE id=${f.agent.actor.attemptId}`;
        }
        const finalize = async (db: Database) =>
          preparedPack
            ? finalizePackInstallationOperation(db, {
                ...scope,
                operationId: preparedPack.operationId,
                operationVersion: preparedPack.operationVersion,
                packInstallationId: ownerId,
                packId: pack.id,
                result: { status: "installed", packId: pack.id },
              })
            : finalizePluginPackageInstall(db, {
                ...scope,
                operationId: preparedPlugin!.operationId,
                pluginInstallationId: ownerId,
                retainedFacetInstallationIds: [retainedChild.facetInstallationId],
                retainedBindingIds: [],
                result: { status: "installed" },
              });
        await expect(
          client.db.transaction(async (tx) => {
            await finalize(tx as unknown as Database);
            throw new Error("simulated parent finalization rollback");
          }),
        ).rejects.toThrow("simulated parent finalization rollback");
        expect(await listSkillDescriptors(client.db, f.context)).toHaveLength(
          scenario === "customized" ? 1 : 0,
        );
        expect(
          await shared!
            .admin`SELECT operation_id FROM skill_write_receipts WHERE receipt->>'sourceOperationId'=${install.skillOperationId!}`,
        ).toHaveLength(0);
        const [finalized, concurrentReplay] = await Promise.all([
          finalize(client.db),
          scenario === "attempt_ended"
            ? Promise.resolve(child)
            : installPortableSkill(client.db, install),
        ]);
        expect(concurrentReplay.skillReceipt.outcome).toBe("pending");
        const finalizedReplay = await finalize(client.db);
        expect(finalizedReplay.skillPublications ?? []).toEqual(finalized.skillPublications ?? []);
        expect(finalized.skillPublications ?? []).toHaveLength(
          scenario === "superseded" ? 2 : mode === "automatic" ? 1 : 0,
        );
        if (mode === "automatic")
          expect(
            finalized.skillPublications!.find(
              (entry) => entry.sourceOperationId === install.skillOperationId,
            ),
          ).toMatchObject({
            sourceOperationId: install.skillOperationId,
            outcome:
              scenario === "customized" || scenario === "superseded"
                ? "preserved"
                : scenario === "attempt_ended"
                  ? "pending"
                  : "applied",
            revisionId: child.skillReceipt.revisionId,
          });
        expect(await listSkillDescriptors(client.db, f.context)).toHaveLength(
          scenario === "automatic" ||
            scenario === "policy_off" ||
            scenario === "customized" ||
            scenario === "superseded" ||
            scenario === "human_off"
            ? 1
            : 0,
        );
        if (scenario === "human_off") {
          const governance = await getCurrentPreferenceRegistryGovernanceMetadata(client.db, {
            workspaceId: scope.workspaceId,
            subjectId: scope.subjectId,
          });
          expect(governance.descriptors).toContainEqual(
            expect.objectContaining({
              id: child.skillReceipt.skillId,
              activationAuthority: "human_confirmed",
            }),
          );
        }
        if (scenario === "superseded")
          expect(
            (await readSkill(client.db, f.context, child.skillReceipt.skillId))?.revisionId,
          ).toBe(retainedChild.skillReceipt.revisionId);
        const [historical] = await shared!
          .admin`SELECT * FROM preference_registry_canonical_snapshot_at(${f.context.accountId},${f.context.workspaceId},${scope.subjectId},${clock!.at})`;
        expect(historical!.canonical_descriptors).toEqual([]);
        const replay = preparedPack
          ? await preparePackInstallationOperation(client.db, packInput)
          : await preparePluginPackageInstall(client.db, pluginInput);
        expect(replay.replayResult?.skillPublications ?? []).toEqual(
          finalized.skillPublications ?? [],
        );
        if (scenario === "attempt_ended") {
          await expectDatabaseGuard(installPortableSkill(client.db, install), "live attempt");
        } else {
          const childReplay = await installPortableSkill(client.db, install);
          expect(childReplay.skillReceipt.outcome).toBe("pending");
          expect(childReplay.skillReceipt).not.toHaveProperty("deferredPublication");
        }
        if (mode === "suggest" || scenario === "attempt_ended") {
          const approved = await approveSkill(client.db, {
            ...f.human,
            operationId: crypto.randomUUID(),
            skillId: child.skillReceipt.skillId,
            revisionId: child.skillReceipt.revisionId,
            expectedRevisionId: null,
            expectedScopeVersion: 1,
            reason: "Approve after parent finalization",
          });
          expect(approved.outcome).toBe("applied");
        }
        expect(
          await shared!
            .admin`SELECT id FROM preference_registry_events WHERE preference_id=${child.skillReceipt.skillId} AND type='activated'`,
        ).toHaveLength(1);
      }, 30_000);
    }
  }

  for (const mode of ["off", "suggest", "automatic"] as const) {
    test(`truthful machine install principals obey ${mode} and cannot perform other lifecycle operations`, async () => {
      if (!client) return;
      const f = await fixture(mode);
      for (const principalKind of ["service", "api_key", "configured_key"] as const) {
        const key = crypto.randomUUID();
        const content = skillMarkdown("Machine source");
        const digest = createHash("sha256").update(content).digest("hex");
        const actor = { kind: "service", subjectId: `service:test-${key}`, principalKind } as const;
        const input: InstallPortableSkillInput = {
          ...f.context,
          subjectId: actor.subjectId,
          skillActor: actor,
          skillOperationId: crypto.randomUUID(),
          capabilityId: `skill:${key}`,
          pluginKey: `skill/machine/${key}`,
          source: "github",
          sourceUrl: "https://example.test/machine",
          repositoryUrl: "https://example.test/machine",
          sourceCommit: "a".repeat(40),
          sourcePath: key,
          name: "test-skill",
          description: "Test Skill folder",
          contentSha256: digest,
          totalBytes: Buffer.byteLength(content),
          files: [
            {
              path: "SKILL.md",
              content,
              byteSize: Buffer.byteLength(content),
              contentSha256: digest,
            },
          ],
        };
        if (mode === "off") {
          await expectDatabaseGuard(installPortableSkill(client.db, input), "Learning is Off");
          expect(
            await shared!
              .admin`SELECT operation_id FROM skill_write_receipts WHERE operation_id=${input.skillOperationId!}`,
          ).toHaveLength(0);
          expect(
            await shared!
              .admin`SELECT id FROM capability_plugins WHERE plugin_key=${input.pluginKey}`,
          ).toHaveLength(0);
          continue;
        }
        const installed = await installPortableSkill(client.db, input);
        expect(installed.skillReceipt.outcome).toBe(mode === "suggest" ? "pending" : "applied");
        const [head] = await shared!
          .admin`SELECT status,active_revision_id FROM preference_registry_preferences WHERE id=${installed.skillReceipt.skillId}`;
        expect(head!.active_revision_id).toBe(
          mode === "suggest" ? null : installed.skillReceipt.revisionId,
        );
        const [receipt] = await shared!
          .admin`SELECT actor FROM skill_write_receipts WHERE operation_id=${input.skillOperationId!}`;
        expect(receipt!.actor).toEqual(actor);
        const [revision] = await shared!
          .admin`SELECT created_by_subject_id FROM preference_registry_revisions WHERE id=${installed.skillReceipt.revisionId}`;
        expect(revision!.created_by_subject_id).toBe(actor.subjectId);
        const replay = await installPortableSkill(client.db, input);
        expect(replay.skillReceipt.replayed).toBe(true);
        expect(replay.skillReceipt.revisionId).toBe(installed.skillReceipt.revisionId);
        await expectDatabaseGuard(
          uninstallPortableSkill(client.db, {
            ...f.context,
            capabilityId: input.capabilityId,
            expectedInstallationVersion: installed.installationVersion,
            skillActor: actor,
          }),
          "requires a trusted human session actor",
        );
        for (const operation of ["save", "approve", "restore"] as const) {
          await expectDatabaseGuard(
            applySkillLifecycle(
              client.db,
              { ...f.context, actor },
              {
                operation,
                operationId: crypto.randomUUID(),
                skillId: installed.skillReceipt.skillId,
                revisionId: installed.skillReceipt.revisionId,
                files: f.input.files,
                expectedRevisionId: head!.active_revision_id,
                expectedScopeVersion: 1,
                reason: "Machine authority negative test",
              },
            ),
            "Skill lifecycle actor is not authorized",
          );
        }
        await expectDatabaseGuard(
          applySkillLifecycle(
            client.db,
            { ...f.context, accountId: crypto.randomUUID(), actor },
            {
              operation: "install",
              operationId: crypto.randomUUID(),
              skillFacetId: installed.facetId,
            },
          ),
          "exact tenant context",
        );
        await expectDatabaseGuard(
          applySkillLifecycle(
            client.db,
            { ...f.context, actor },
            {
              operation: "install",
              scope: "organization",
              operationId: crypto.randomUUID(),
              skillFacetId: installed.facetId,
            },
          ),
          "Skill lifecycle actor is not authorized",
        );
        if (principalKind === "api_key" && mode === "automatic") {
          const appSql = postgres(shared!.appUrl, { max: 1 });
          try {
            await expectDatabaseGuard(
              appSql.begin(async (tx) => {
                await tx`SELECT set_config('opengeni.account_id',${f.context.accountId},true),
                set_config('opengeni.workspace_id',${f.context.workspaceId},true),
                set_config('opengeni.subject_id',${actor.subjectId},true),
                set_config('opengeni.principal_kind','service',true)`;
                await tx`SELECT skill_apply_lifecycle(${f.context.accountId},${f.context.workspaceId},${tx.json(actor)},
                ${tx.json({ operation: "install", operationId: crypto.randomUUID(), skillFacetId: installed.facetId })})`;
              }),
              "Skill lifecycle actor is not authorized",
            );
          } finally {
            await appSql.end();
          }
        }
      }
    }, 30_000);
  }

  test("stores full 1024-character description projections and rejects overflow without truncation", async () => {
    if (!client) return;
    const f = await fixture("off");
    const description = "d".repeat(1024);
    const files = [
      {
        path: "SKILL.md",
        content: `---\nname: test-skill\ndescription: ${description}\n---\nSkill body`,
      },
    ];
    const saved = await saveSkill(client.db, { ...f.input, files });
    expect((await readSkill(client.db, f.context, saved.skillId))?.description).toBe(description);
    expect((await readSkill(client.db, f.context, saved.skillId))?.files).toEqual(files);
    await expect(
      saveSkill(client.db, {
        ...f.input,
        skillId: saved.skillId,
        operationId: crypto.randomUUID(),
        expectedRevisionId: saved.revisionId,
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: test-skill\ndescription: ${description}x\n---\nSkill body`,
          },
        ],
      }),
    ).rejects.toThrow();
    expect((await readSkill(client.db, f.context, saved.skillId))?.revisionId).toBe(
      saved.revisionId,
    );
  }, 30_000);

  test("legacy creation/correction are retired; files-bearing activation and restore preserve history", async () => {
    if (!client) return;
    const f = await fixture("off");
    const governance = {
      ...f.context,
      actorSubjectId: f.human.actor.subjectId,
      principalKind: "human_session",
      authorizeScope: () => {},
      expectedScopeVersion: 1,
      reason: "Legacy folder guard test",
    };
    const legacyFields = {
      title: "Legacy authored Skill",
      description: "Pre-unification text",
      content: "Historical instructions",
      precedenceRank: 0,
      conflictStrategy: "override" as const,
      conflictsWith: [],
      expiresAt: null,
    };
    await expectDatabaseGuard(
      createPreferenceRegistryProposal(client.db, {
        ...governance,
        ...legacyFields,
        stableKey: f.input.stableKey,
        scope: "workspace",
        provenanceSource: "human",
        provenanceSourceId: null,
      }),
      "Skill folder saves require the unified file lifecycle",
    );
    const folder = await saveSkill(client.db, f.input);
    await expectDatabaseGuard(
      correctPreferenceRegistry(client.db, {
        ...governance,
        ...legacyFields,
        preferenceId: folder.skillId,
        expectedCurrentRevisionId: folder.revisionId,
      }),
      "Skill folder saves require the unified file lifecycle",
    );
    const updated = await saveSkill(client.db, {
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevisionId: folder.revisionId,
      files: [{ path: "SKILL.md", content: skillMarkdown("Updated body") }],
    });
    await activatePreferenceRegistryRevision(client.db, {
      ...governance,
      preferenceId: folder.skillId,
      revisionId: folder.revisionId,
      expectedCurrentRevisionId: updated.revisionId,
    });
    expect((await readSkill(client.db, f.context, folder.skillId))?.files).toEqual(f.input.files);
    const restored = await restoreSkill(client.db, {
      ...f.human,
      operationId: crypto.randomUUID(),
      skillId: folder.skillId,
      revisionId: folder.revisionId,
      expectedRevisionId: folder.revisionId,
      expectedScopeVersion: 1,
      reason: "Explicitly restore historical text as a folder",
    });
    expect(restored.revisionId).not.toBe(folder.revisionId);
    expect((await readSkill(client.db, f.context, folder.skillId))?.files).toEqual(f.input.files);
    const [unchanged] = await shared!
      .admin`select content,skill_files from preference_registry_revisions where id=${folder.revisionId}`;
    expect(unchanged!.skill_files).toEqual(f.input.files);
  }, 30_000);

  test("portable retries replay before distribution CAS or moving-source resolution", async () => {
    if (!client) return;
    const f = await fixture("automatic");
    const key = crypto.randomUUID();
    const content = skillMarkdown("Original replay source");
    const digest = createHash("sha256").update(content).digest("hex");
    const requestIdentity = {
      sourceUrl: "https://example.test/moving",
      options: {},
      expectedInstallationVersion: null,
    };
    const input: InstallPortableSkillInput = {
      ...f.context,
      subjectId: f.human.actor.subjectId,
      skillActor: f.agent.actor,
      skillOperationId: crypto.randomUUID(),
      skillRequestIdentity: requestIdentity,
      capabilityId: `skill:${key}`,
      pluginKey: `skill/replay/${key}`,
      source: "github",
      sourceUrl: requestIdentity.sourceUrl,
      repositoryUrl: "https://example.test/repo",
      sourceCommit: "a".repeat(40),
      sourcePath: key,
      name: "replay-skill",
      description: "Replay test",
      contentSha256: digest,
      totalBytes: Buffer.byteLength(content),
      files: [
        { path: "SKILL.md", content, byteSize: Buffer.byteLength(content), contentSha256: digest },
      ],
    };
    const installed = await installPortableSkill(client.db, input);
    const moved = await installPortableSkill(client.db, {
      ...input,
      skillOperationId: crypto.randomUUID(),
      sourceCommit: "b".repeat(40),
      expectedInstallationVersion: installed.installationVersion,
      skillRequestIdentity: {
        ...requestIdentity,
        expectedInstallationVersion: installed.installationVersion,
      },
    });
    expect(moved.installationVersion).toBe(installed.installationVersion + 1);
    await expect(
      installPortableSkill(client.db, {
        ...input,
        skillOperationId: crypto.randomUUID(),
        sourceCommit: "d".repeat(40),
        sourcePath: key.toUpperCase(),
        expectedInstallationVersion: moved.installationVersion,
      }),
    ).rejects.toThrow("differs only by case");
    const expectedReplay = {
      ...installed,
      skillReceipt: { ...installed.skillReceipt, replayed: true },
    };
    const retries = await Promise.all([
      installPortableSkill(client.db, input),
      installPortableSkill(client.db, input),
    ]);
    expect(retries).toEqual([expectedReplay, expectedReplay]);
    expect(
      await replayPortableSkillInstall(client.db, {
        ...f.agent,
        operationId: input.skillOperationId!,
        requestIdentity,
      }),
    ).toEqual(expectedReplay);
    // Even if an adapter resolved the moving URL before retry, original request binding wins.
    expect(
      await installPortableSkill(client.db, { ...input, sourceCommit: "c".repeat(40) }),
    ).toEqual(expectedReplay);
    await expect(
      replayPortableSkillInstall(client.db, {
        ...f.agent,
        operationId: input.skillOperationId!,
        requestIdentity: { sourceUrl: "different" },
      }),
    ).rejects.toThrow("reused with different input");
    await expect(
      replayPortableSkillInstall(client.db, {
        ...f.agent,
        actor: { ...f.agent.actor, executionGeneration: 2 },
        operationId: input.skillOperationId!,
        requestIdentity,
      }),
    ).rejects.toThrow("exact live attempt");
    await expect(
      replayPortableSkillInstall(client.db, {
        ...f.human,
        operationId: input.skillOperationId!,
        requestIdentity,
      }),
    ).rejects.toThrow();
    const [current] = await shared!
      .admin`select version,plugin_version_id from capability_plugin_installations where id=${installed.pluginInstallationId}`;
    expect(current!.version).toBe(moved.installationVersion);
    expect(current!.plugin_version_id).toBe(moved.pluginVersionId);
    const [versions] = await shared!
      .admin`select count(*)::integer as count from capability_plugin_versions where plugin_id=${installed.pluginId}`;
    expect(versions!.count).toBe(2);
    expect(installed.skillReceipt).not.toHaveProperty("portableInstall");
  }, 30_000);

  test("no policy means Require approval; agent reads are fenced and descriptors omit bodies", async () => {
    if (!client) return;
    const f = await fixture(null);
    await assertSkillReadAttempt(client.db, f.agent);
    await expect(
      assertSkillReadAttempt(client.db, {
        ...f.agent,
        actor: { ...f.agent.actor, executionGeneration: 2 },
      }),
    ).rejects.toThrow("exact live attempt");
    const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
    expect(pending.outcome).toBe("pending");
    expect(await listSkillDescriptors(client.db, f.context)).toEqual([]);
    const record = await readSkill(client.db, f.context, pending.skillId, pending.revisionId);
    await approveSkill(client.db, {
      ...f.human,
      operationId: crypto.randomUUID(),
      skillId: pending.skillId,
      revisionId: pending.revisionId,
      expectedRevisionId: null,
      expectedScopeVersion: record!.scopeVersion,
      reason: "Approve test Skill",
    });
    const descriptors = await listSkillDescriptors(client.db, f.context);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).not.toHaveProperty("files");
    expect(descriptors[0]?.id).toBe(pending.skillId);
    const invalid = await shared!.admin`select skill_files_valid(${JSON.stringify([
      { path: "SKILL.md", content: "main" },
      { path: "a", content: "file" },
      { path: "a/b", content: "nested" },
    ])}::jsonb) AS valid`;
    expect(invalid[0]?.valid).toBe(false);
  });

  test("human bypasses Off, roundtrips files, retries exactly, CAS conflicts and restore creates history", async () => {
    if (!client) return;
    const f = await fixture("off");
    const first = await saveSkill(client.db, f.input);
    expect(first.outcome).toBe("applied");
    expect(await saveSkill(client.db, f.input)).toEqual({ ...first, replayed: true });
    expect((await readSkill(client.db, f.context, first.skillId))?.files).toEqual(f.input.files);
    await expect(
      saveSkill(client.db, {
        ...f.input,
        files: [{ path: "SKILL.md", content: skillMarkdown("different same key") }],
      }),
    ).rejects.toThrow();
    const second = await saveSkill(client.db, {
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevisionId: first.revisionId,
      files: [{ path: "SKILL.md", content: skillMarkdown("changed") }],
    });
    await expect(
      saveSkill(client.db, {
        ...f.input,
        operationId: crypto.randomUUID(),
        expectedRevisionId: first.revisionId,
      }),
    ).rejects.toThrow();
    const restored = await restoreSkill(client.db, {
      ...f.human,
      operationId: crypto.randomUUID(),
      skillId: first.skillId,
      revisionId: first.revisionId,
      expectedRevisionId: second.revisionId,
      expectedScopeVersion: 1,
      reason: "Restore original folder",
    });
    expect(restored.revisionId).not.toBe(first.revisionId);
    expect((await readSkill(client.db, f.context, first.skillId))?.files).toEqual(f.input.files);
    expect(
      (await readSkill(client.db, f.context, first.skillId, second.revisionId))?.files[0]?.content,
    ).toBe(skillMarkdown("changed"));
  });
  test("Off refuses without receipts or heads; Suggest stays pending until human approval", async () => {
    if (!client) return;
    const off = await fixture("off");
    await expect(saveSkill(client.db, { ...off.input, ...off.agent })).rejects.toThrow();
    expect(await listSkills(client.db, off.context)).toHaveLength(0);
    const f = await fixture("suggest");
    const input = { ...f.input, ...f.agent };
    const pending = await saveSkill(client.db, input);
    expect(pending.outcome).toBe("pending");
    expect((await readSkill(client.db, f.context, pending.skillId))?.pendingRevisionIds).toEqual([
      pending.revisionId,
    ]);
    expect((await readSkill(client.db, f.context, pending.skillId))?.activeRevisionId).toBeNull();
    expect((await saveSkill(client.db, input)).replayed).toBe(true);
    const request = {
      operationId: crypto.randomUUID(),
      skillId: pending.skillId,
      revisionId: pending.revisionId,
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      reason: "Approve tested pending Skill",
    };
    await expect(approveSkill(client.db, { ...f.agent, ...request })).rejects.toThrow();
    expect((await approveSkill(client.db, { ...f.human, ...request })).outcome).toBe("applied");
    expect((await readSkill(client.db, f.context, pending.skillId))?.pendingRevisionIds).toEqual(
      [],
    );
  });
  test("Automatic is truthful, fences tenancy/generation, and cannot write org/user Skills", async () => {
    if (!client) return;
    const f = await fixture("automatic");
    const saved = await saveSkill(client.db, { ...f.input, ...f.agent });
    expect(saved.outcome).toBe("applied");
    const [revision] = await shared!
      .admin`select provenance_source,created_by_subject_id from preference_registry_revisions where id=${saved.revisionId}`;
    expect(revision!.provenance_source).toBe("agent");
    expect(revision!.created_by_subject_id).toBe(
      `service:skill-attempt:${f.agent.actor.attemptId}`,
    );
    const metadata = await getCurrentPreferenceRegistryGovernanceMetadata(client.db, {
      workspaceId: f.context.workspaceId,
      subjectId: f.human.actor.subjectId,
    });
    expect(metadata.descriptors).toContainEqual(
      expect.objectContaining({ id: saved.skillId, activationAuthority: "automatic" }),
    );
    const [snapshot] = await shared!.admin`select * from preference_registry_canonical_snapshot_at(
      ${f.context.accountId},${f.context.workspaceId},${f.human.actor.subjectId},now())`;
    expect(snapshot!.canonical_descriptors).toContainEqual(
      expect.objectContaining({ id: saved.skillId, activationAuthority: "automatic" }),
    );
    const other = await fixture("automatic");
    expect(await readSkill(client.db, other.context, saved.skillId)).toBeNull();
    await expect(
      saveSkill(client.db, {
        ...f.input,
        ...f.agent,
        ...other.context,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      saveSkill(client.db, {
        ...f.input,
        ...f.agent,
        actor: { ...f.agent.actor, executionGeneration: 2 },
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    for (const scope of ["organization", "user"] as const) {
      await expect(
        saveSkill(client.db, {
          ...f.input,
          ...f.agent,
          operationId: crypto.randomUUID(),
          skillId: crypto.randomUUID(),
          scope,
        }),
      ).rejects.toThrow();
    }
    await shared!
      .admin`update session_turn_attempts set state='closed',outcome='failed',closed_at=now() where id=${f.agent.actor.attemptId}`;
    await expect(
      saveSkill(client.db, { ...f.input, ...f.agent, operationId: crypto.randomUUID() }),
    ).rejects.toThrow();
  });
  test("workspace deletion removes owned Skill history and preserves other scopes", async () => {
    if (!client) return;
    async function workspace() {
      const key = crypto.randomUUID();
      const subjectId = `user:cascade-${key}`;
      const grant = (
        await bootstrapWorkspace(client!.db, {
          accountExternalSource: "test",
          accountExternalId: key,
          accountName: "Cascade test",
          workspaceExternalSource: "test",
          workspaceExternalId: key,
          workspaceName: "Cascade test",
          subjectId,
        })
      ).workspaceGrants[0]!;
      return {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        actor: { kind: "human", subjectId, principalKind: "human_session" } as const,
      };
    }
    const human = await workspace();
    const other = await workspace();
    const content = skillMarkdown("Portable deletion fixture");
    const digest = createHash("sha256").update(content).digest("hex");
    const installed = await installPortableSkill(client.db, {
      ...human,
      subjectId: human.actor.subjectId,
      skillActor: human.actor,
      capabilityId: `skill:${human.workspaceId}`,
      pluginKey: `skill/test/${human.workspaceId}`,
      source: "github",
      sourceUrl: "https://example.test/skills",
      repositoryUrl: "https://example.test/repo",
      sourceCommit: "a".repeat(40),
      sourcePath: "skill",
      name: "test-skill",
      description: "Test Skill folder",
      contentSha256: digest,
      totalBytes: Buffer.byteLength(content),
      files: [
        { path: "SKILL.md", content, byteSize: Buffer.byteLength(content), contentSha256: digest },
      ],
    });
    const customized = await saveSkill(client.db, {
      ...human,
      operationId: crypto.randomUUID(),
      skillId: installed.skillReceipt.skillId,
      expectedRevisionId: installed.skillReceipt.revisionId,
      expectedScopeVersion: 1,
      stableKey: `installed-${installed.skillReceipt.skillId.replaceAll("-", "")}`,
      files: [{ path: "SKILL.md", content: skillMarkdown("Customized portable fixture") }],
      reason: "Customize",
    });
    const restored = await restoreSkill(client.db, {
      ...human,
      operationId: crypto.randomUUID(),
      skillId: customized.skillId,
      revisionId: installed.skillReceipt.revisionId!,
      expectedRevisionId: customized.revisionId,
      expectedScopeVersion: 1,
      reason: "Restore original",
    });
    expect(restored.outcome).toBe("applied");
    const authored = await saveSkill(client.db, {
      ...human,
      operationId: crypto.randomUUID(),
      skillId: crypto.randomUUID(),
      stableKey: "authored-deleted",
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      files: [{ path: "SKILL.md", content }],
      reason: "Authored workspace Skill",
    });
    const organization = await saveSkill(client.db, {
      ...human,
      operationId: crypto.randomUUID(),
      skillId: crypto.randomUUID(),
      stableKey: "org-retained",
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      scope: "organization",
      files: [{ path: "SKILL.md", content }],
      reason: "Organization retention control",
    });
    const personal = await saveSkill(client.db, {
      ...human,
      operationId: crypto.randomUUID(),
      skillId: crypto.randomUUID(),
      stableKey: "user-retained",
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      scope: "user",
      files: [{ path: "SKILL.md", content }],
      reason: "Personal retention control",
    });
    const sibling = await saveSkill(client.db, {
      ...other,
      operationId: crypto.randomUUID(),
      skillId: crypto.randomUUID(),
      stableKey: "other-workspace",
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      files: [{ path: "SKILL.md", content }],
      reason: "Other workspace retention control",
    });
    for (const table of [
      "preference_registry_preferences",
      "preference_registry_revisions",
      "preference_registry_events",
      "skill_write_receipts",
    ]) {
      await expect(
        shared!.admin.begin(async (tx) => {
          if (table === "preference_registry_preferences")
            await tx`DELETE FROM preference_registry_preferences WHERE id=${restored.skillId}`;
          else if (table === "skill_write_receipts")
            await tx`DELETE FROM skill_write_receipts WHERE workspace_id=${human.workspaceId}`;
          else await tx.unsafe(`DELETE FROM ${table} WHERE preference_id=$1`, [restored.skillId]);
        }),
      ).rejects.toThrow();
    }
    const runtime = postgres(shared!.appUrl, { max: 1 });
    try {
      const [access] =
        await runtime`SELECT has_function_privilege(current_user, ${"opengeni_private.guard_workspace_owned_skill_head_delete()"}, 'EXECUTE') AS allowed`;
      expect(access!.allowed).toBe(false);
      await expect(runtime`DELETE FROM preference_registry_preferences`.execute()).rejects.toThrow(
        "permission denied",
      );
    } finally {
      await runtime.end();
    }
    const [instruction] = await shared!
      .admin`SELECT pg_get_functiondef('workspace_instruction_policy_reject_mutation()'::regprocedure) AS definition`;
    expect(instruction!.definition).toContain("workspace instruction-policy history is immutable");
    await expect(
      supersedePreferenceRegistry(client.db, {
        accountId: human.accountId,
        workspaceId: human.workspaceId,
        actorSubjectId: human.actor.subjectId,
        principalKind: "human_session",
        preferenceId: organization.skillId,
        replacementPreferenceId: restored.skillId,
        expectedCurrentRevisionId: organization.revisionId,
        expectedScopeVersion: 1,
        authorizeScope: () => undefined,
        reason: "Org cannot supersede a workspace Skill",
      }),
    ).rejects.toThrow("same scope tier");
    // Exercise a supported same-workspace history link through the normal API.
    // Both ends must survive activity-gate finalization and then cascade together.
    await supersedePreferenceRegistry(client.db, {
      accountId: human.accountId,
      workspaceId: human.workspaceId,
      actorSubjectId: human.actor.subjectId,
      principalKind: "human_session",
      preferenceId: restored.skillId,
      replacementPreferenceId: authored.skillId,
      expectedCurrentRevisionId: restored.revisionId,
      expectedScopeVersion: 1,
      authorizeScope: () => undefined,
      reason: "Replace workspace Skill before deleting its workspace",
    });
    await expect(
      shared!.admin.begin(async (tx) => {
        await tx`INSERT INTO preference_registry_events(
          account_id, preference_id, type, version, old_revision_id, related_preference_id, actor_subject_id, reason)
          VALUES (${human.accountId}, ${organization.skillId}, 'superseded', 3, ${organization.revisionId},
            ${sibling.skillId}, ${human.actor.subjectId}, 'Cross-account related Skill')`;
      }),
    ).rejects.toThrow();
    // Synthetic corruption rollback only: Skill save and supersedePreferenceRegistry cannot
    // create org→workspace related_preference_id. This plants an invalid cross-tier
    // superseded_by via lifecycle GUCs to prove the deferred FK fail-closes.
    await expect(
      shared!.admin.begin(async (tx) => {
        const [orgHead] =
          await tx`SELECT active_revision_id FROM preference_registry_preferences WHERE id=${organization.skillId}`;
        await tx`SELECT set_config('opengeni.preference_lifecycle_head_id', ${organization.skillId}, true),
          set_config('opengeni.preference_lifecycle_operation', 'supersede', true)`;
        await tx`UPDATE preference_registry_preferences
          SET status='superseded', superseded_by_preference_id=${restored.skillId}, updated_at=now()
          WHERE id=${organization.skillId}`;
        await tx`INSERT INTO preference_registry_events(
          account_id, preference_id, type, version, old_revision_id, related_preference_id, actor_subject_id, reason)
          VALUES (${human.accountId}, ${organization.skillId}, 'superseded', 3, ${orgHead!.active_revision_id},
            ${restored.skillId}, ${human.actor.subjectId}, 'Retain workspace Skill through surviving org audit')`;
        await tx`DELETE FROM workspaces WHERE id=${human.workspaceId}`;
      }),
    ).rejects.toThrow();
    expect(
      await shared!.admin`SELECT id FROM workspaces WHERE id=${human.workspaceId}`,
    ).toHaveLength(1);
    await expectDatabaseGuard(
      withWorkspaceRls(client.db, other.workspaceId, (tx) =>
        deleteWorkspace(tx, human.workspaceId),
      ),
      "tenant context mismatch",
    );
    expect((await readSkill(client.db, human, restored.skillId))?.revisionId).toBe(
      restored.revisionId,
    );
    const [rejectHistory] = await shared!
      .admin`SELECT pg_get_functiondef('preference_registry_reject_history_mutation()'::regprocedure) AS definition`;
    expect(rejectHistory!.definition).toContain("preference registry history is immutable");
    expect(rejectHistory!.definition).not.toContain("pg_trigger_depth");
    const [historyGuard] = await shared!
      .admin`SELECT pg_get_functiondef('opengeni_private.guard_workspace_owned_skill_history_delete()'::regprocedure) AS definition`;
    expect(historyGuard!.definition).toContain("pg_trigger_depth");
    const snapshotSessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const descriptors = "[]";
    const descriptorHash = createHash("sha256").update(descriptors).digest("hex");
    const configSourceId = crypto.randomUUID();
    await shared!.admin.begin(async (sql) => {
      await sql`select set_config('opengeni.session_inference_claim','1',true)`;
      await sql`select set_config('opengeni.session_activity_gate_state','open',true)`;
      await sql`select set_config('opengeni.session_activity_gate_workspace_id',${human.workspaceId},true)`;
      await sql`ALTER TABLE sessions DISABLE TRIGGER USER`;
      await sql`ALTER TABLE session_turns DISABLE TRIGGER USER`;
      await sql`ALTER TABLE session_turn_attempts DISABLE TRIGGER USER`;
      await sql`ALTER TABLE preference_registry_snapshots DISABLE TRIGGER USER`;
      await sql`insert into sessions(id,account_id,workspace_id,status,initial_message,created_by_kind,created_by_subject_id,model,reasoning_effort,latency_mode,sandbox_backend,sandbox_group_id,tool_policy,root_session_id,nested_agent_depth,effective_max_nested_agent_depth,nested_agent_depth_policy_source)
        values(${snapshotSessionId},${human.accountId},${human.workspaceId},'idle','snapshot retention','subject',${human.actor.subjectId},'test-model','medium','standard','none',${snapshotSessionId},${sql.json({ mode: "explicit", inheritedFromSessionId: null })},${snapshotSessionId},0,1,'default')`;
      await sql`insert into session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
        status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,
        initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id)
        values(${turnId},${human.accountId},${human.workspaceId},${snapshotSessionId},${crypto.randomUUID()},${turnId},
          'running','user',1,'test','test-model','medium','none',1,'subject',${human.actor.subjectId},'{}',${human.actor.subjectId})`;
      await sql`insert into session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
        temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies,authority_epoch,authority_visibility)
        values(${attemptId},${human.accountId},${human.workspaceId},${snapshotSessionId},${turnId},1,'running',
          ${turnId},${attemptId},${attemptId},0,'{}',1,'workspace_shared')`;
      await sql`INSERT INTO preference_registry_snapshots(
        account_id,workspace_id,session_id,turn_id,attempt_id,execution_generation,initiating_human_subject_id,descriptors,descriptor_hash)
        VALUES(${human.accountId},${human.workspaceId},${snapshotSessionId},${turnId},${attemptId},1,${human.actor.subjectId},${sql.json([])},${descriptorHash})`;
      await sql`INSERT INTO skill_config_conversion_receipts(account_id,workspace_id,source_kind,source_id,original_configuration,original_hash,replacement_hash)
        VALUES(${human.accountId},${human.workspaceId},'session',${configSourceId},'[]',${createHash("sha256").update("[]").digest("hex")},${createHash("sha256").update("[]").digest("hex")})`;
    });
    await shared!.admin`ALTER TABLE preference_registry_snapshots ENABLE TRIGGER USER`;
    await shared!.admin`ALTER TABLE session_turn_attempts ENABLE TRIGGER USER`;
    await shared!.admin`ALTER TABLE session_turns ENABLE TRIGGER USER`;
    await shared!.admin`ALTER TABLE sessions ENABLE TRIGGER USER`;
    await expect(
      shared!
        .admin`DELETE FROM preference_registry_snapshots WHERE workspace_id=${human.workspaceId}`.execute(),
    ).rejects.toThrow("immutable");
    await expect(
      shared!
        .admin`DELETE FROM skill_config_conversion_receipts WHERE workspace_id=${human.workspaceId}`.execute(),
    ).rejects.toThrow("immutable");
    // Workspace-scoped knowledge_change_proposals still RESTRICT workspace
    // delete (pre-Skill residual, not widened). Bind the historical receipt to
    // an organization-scoped proposal so 0431 CASCADE can remove it.
    const companyBrain = await seedOrgScopedCompanyBrainReceipt(client.db, shared!.admin, {
      accountId: human.accountId,
      workspaceId: human.workspaceId,
      actorSubjectId: human.actor.subjectId,
      preferenceId: authored.skillId,
      revisionId: authored.revisionId,
      sessionId: snapshotSessionId,
      turnId,
      attemptId,
    });
    expect(
      await shared!
        .admin`SELECT id FROM company_brain_preference_proposal_receipts WHERE id=${companyBrain.receiptId}`,
    ).toHaveLength(1);
    await expect(
      shared!
        .admin`DELETE FROM company_brain_preference_proposal_receipts WHERE id=${companyBrain.receiptId}`.execute(),
    ).rejects.toThrow("immutable");
    await shared!
      .admin`update sessions set status='idle', active_turn_id=null where id=${snapshotSessionId}`;
    await shared!
      .admin`update session_turn_attempts set state='closed', outcome='completed', closed_at=now() where id=${attemptId}`;
    expect(
      await deleteWorkspaceIfQuiescent(client.db, {
        accountId: other.accountId,
        workspaceId: other.workspaceId,
      }),
    ).toEqual({ status: "only_workspace" });
    const keeper = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Skill deletion keeper",
    });
    const authorized = deleteWorkspaceIfQuiescent(client.db, {
      accountId: human.accountId,
      workspaceId: human.workspaceId,
    });
    const raced = await Promise.allSettled([
      authorized,
      deleteWorkspaceIfQuiescent(client.db, {
        accountId: human.accountId,
        workspaceId: human.workspaceId,
      }),
    ]);
    const authorizedResults = raced.map((result) =>
      result.status === "fulfilled" ? result.value.status : result.reason,
    );
    expect(authorizedResults).toEqual(expect.arrayContaining(["deleted"]));
    expect(
      authorizedResults.every((status) => status === "deleted" || status === "not_found"),
    ).toBe(true);
    expect(
      await shared!.admin`SELECT id FROM workspaces WHERE id=${human.workspaceId}`,
    ).toHaveLength(0);
    expect(await shared!.admin`SELECT id FROM workspaces WHERE id=${keeper.id}`).toHaveLength(1);
    expect(
      await shared!
        .admin`SELECT id FROM preference_registry_preferences WHERE id IN (${restored.skillId}, ${authored.skillId})`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT id FROM preference_registry_revisions WHERE preference_id IN (${restored.skillId}, ${authored.skillId})`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT id FROM preference_registry_events WHERE preference_id IN (${restored.skillId}, ${authored.skillId})`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT operation_id FROM skill_write_receipts WHERE workspace_id=${human.workspaceId}`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT preference_id FROM skill_source_bindings WHERE workspace_id=${human.workspaceId}`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT id FROM preference_registry_snapshots WHERE workspace_id=${human.workspaceId}`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT source_id FROM skill_config_conversion_receipts WHERE workspace_id=${human.workspaceId}`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT id FROM company_brain_preference_proposal_receipts WHERE id=${companyBrain.receiptId}`,
    ).toHaveLength(0);
    expect(
      await shared!
        .admin`SELECT id FROM knowledge_change_proposals WHERE id=${companyBrain.proposalId}`,
    ).toHaveLength(1);
    expect(
      await shared!
        .admin`SELECT id FROM preference_registry_preferences WHERE id=${sibling.skillId}`,
    ).toHaveLength(1);
    const surviving = await shared!
      .admin`SELECT id, active_revision_id FROM preference_registry_preferences
      WHERE id IN (${organization.skillId}, ${personal.skillId}) ORDER BY id`;
    expect(surviving).toHaveLength(2);
    expect(surviving.map((row) => row.active_revision_id).sort()).toEqual(
      [organization.revisionId, personal.revisionId].sort(),
    );
  }, 30_000);
  test("concurrent writers have one CAS winner and runtime cannot directly mutate receipts", async () => {
    if (!client) return;
    const f = await fixture("automatic");
    const first = await saveSkill(client.db, f.input);
    const writes = await Promise.allSettled(
      ["one", "two"].map((content) =>
        saveSkill(client!.db, {
          ...f.input,
          operationId: crypto.randomUUID(),
          expectedRevisionId: first.revisionId,
          files: [{ path: "SKILL.md", content: skillMarkdown(content) }],
        }),
      ),
    );
    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((write) => write.status === "rejected")).toHaveLength(1);
    const runtime = postgres(shared!.appUrl, { max: 1 });
    try {
      await expect(runtime`delete from skill_write_receipts`.execute()).rejects.toThrow();
      await expect(
        runtime`update skill_source_bindings set facet_key='forged'`.execute(),
      ).rejects.toThrow();
      expect(await runtime`select * from skill_write_receipts`).toHaveLength(0);
    } finally {
      await runtime.end();
    }
  }, 30_000);
  test("installed and authored saves share a head; source refresh preserves customized folder and owners", async () => {
    if (!client) return;
    const f = await fixture("off");
    const key = crypto.randomUUID();
    const content = skillMarkdown("# Source Skill\nOriginal source instructions.");
    const reference = "Original reference bytes.";
    const digest = createHash("sha256").update(content).digest("hex");
    const input: InstallPortableSkillInput = {
      ...f.context,
      subjectId: f.human.actor.subjectId,
      skillActor: f.human.actor,
      capabilityId: `skill:${key}`,
      pluginKey: `skill/test/${key}`,
      source: "github",
      sourceUrl: "https://example.test/skills",
      repositoryUrl: "https://example.test/repo",
      sourceCommit: "a".repeat(40),
      sourcePath: key,
      name: "source-skill",
      description: "Source Skill description",
      contentSha256: digest,
      totalBytes: Buffer.byteLength(content) + Buffer.byteLength(reference),
      files: [
        {
          path: "references/context.txt",
          content: reference,
          byteSize: Buffer.byteLength(reference),
          contentSha256: createHash("sha256").update(reference).digest("hex"),
        },
        { path: "SKILL.md", content, byteSize: Buffer.byteLength(content), contentSha256: digest },
      ],
    };
    const installed = await installPortableSkill(client.db, input);
    expect(installed.skillReceipt.outcome).toBe("applied");
    // Deliberately submitted in reverse byte order. Locale-aware collation
    // sorts the lowercase reference first; the canonical head must not.
    expect((await readSkill(client.db, f.context, installed.skillReceipt.skillId))?.files).toEqual([
      { path: "SKILL.md", content },
      { path: "references/context.txt", content: reference },
    ]);
    const customFiles = [
      { path: "SKILL.md", content: skillMarkdown("Customized behavior") },
      { path: "reference.txt", content: "keep me" },
    ];
    const custom = await saveSkill(client.db, {
      ...f.input,
      skillId: installed.skillReceipt.skillId,
      expectedRevisionId: installed.skillReceipt.revisionId,
      files: customFiles,
    });
    const updatedContent = skillMarkdown("Updated upstream source");
    const updatedDigest = createHash("sha256").update(updatedContent).digest("hex");
    const refreshed = await installPortableSkill(client.db, {
      ...input,
      sourceCommit: "b".repeat(40),
      contentSha256: updatedDigest,
      totalBytes: Buffer.byteLength(updatedContent),
      expectedInstallationVersion: installed.installationVersion,
      files: [
        {
          path: "SKILL.md",
          content: updatedContent,
          byteSize: Buffer.byteLength(updatedContent),
          contentSha256: updatedDigest,
        },
      ],
    });
    expect(refreshed.skillReceipt.skillId).toBe(custom.skillId);
    expect(refreshed.skillReceipt.revisionId).toBe(custom.revisionId);
    expect(refreshed.skillReceipt.outcome).toBe("preserved");
    await expect(
      uninstallPortableSkill(client.db, {
        ...f.context,
        capabilityId: input.capabilityId,
        expectedInstallationVersion: refreshed.installationVersion,
      }),
    ).rejects.toThrow("requires a trusted human session actor");
    const projection = await listInstalledPortableSkills(client.db, f.context.workspaceId);
    expect(projection[0]?.name).toBe("test-skill");
    expect(projection[0]?.description).toBe("Test Skill folder");
    expect(projection[0]?.files).toEqual(customFiles);
    expect(await listSkills(client.db, f.context)).toHaveLength(1);
    // Draft authored entries also occupy metadata pages. They must not make
    // a later installed/customized Skill disappear from runtime resolution.
    await shared!.admin.begin(async (tx) => {
      await tx`WITH heads AS (
        INSERT INTO preference_registry_preferences(account_id,stable_key,scope,scope_workspace_id,created_by_subject_id)
        SELECT ${f.context.accountId},'a-padding-'||n::text,'workspace',${f.context.workspaceId},${f.human.actor.subjectId}
        FROM generate_series(1,1000) n RETURNING id,account_id
      ), revisions AS (
        INSERT INTO preference_registry_revisions(account_id,preference_id,title,description,content,content_hash,
          conflict_strategy,provenance_source,trust,created_by_subject_id,skill_files,skill_activation_mode)
        SELECT h.account_id,h.id,r.title,r.description,r.content,r.content_hash,
          r.conflict_strategy,r.provenance_source,r.trust,${f.human.actor.subjectId},r.skill_files,r.skill_activation_mode
        FROM heads h CROSS JOIN preference_registry_revisions r WHERE r.id=${custom.revisionId}
        RETURNING id,account_id,preference_id
      ) INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,
          new_scope,new_workspace_id,actor_subject_id,reason)
        SELECT account_id,preference_id,'proposal_created',1,id,'workspace',${f.context.workspaceId},
          ${f.human.actor.subjectId},'Pagination fixture inactive Skill proposal' FROM revisions`;
    });
    const beyondFirstPage = await listInstalledPortableSkills(client.db, f.context.workspaceId);
    expect(beyondFirstPage).toHaveLength(1);
    expect(beyondFirstPage[0]?.name).toBe("test-skill");
    expect(beyondFirstPage[0]?.files).toEqual(customFiles);
    const [owners] = await shared!
      .admin`select count(*)::integer as count from capability_component_owners where workspace_id=${f.context.workspaceId}`;
    expect(owners!.count).toBeGreaterThan(0);
    const removed = await uninstallPortableSkill(client.db, {
      ...f.context,
      capabilityId: input.capabilityId,
      expectedInstallationVersion: refreshed.installationVersion,
      skillActor: f.human.actor,
    });
    expect(removed.skillReleases).toEqual([
      expect.objectContaining({
        skillId: custom.skillId,
        disposition: "preserved",
        eventId: null,
      }),
    ]);
    expect(removed.skillReleases![0]!.warning).toContain("remains active");
    expect((await readSkill(client.db, f.context, custom.skillId))?.files).toEqual(customFiles);
    expect(await listInstalledPortableSkills(client.db, f.context.workspaceId)).toHaveLength(0);

    const selected = await installPortableSkill(client.db, {
      ...input,
      pluginKey: `${input.pluginKey}-selected`,
      capabilityId: `${input.capabilityId}-selected`,
      activationMode: "session_selected",
    });
    const selectedRecord = await readSkill(client.db, f.context, selected.skillReceipt.skillId);
    expect(selectedRecord?.activationMode).toBe("session_selected");
    const metadata = await getCurrentPreferenceRegistryGovernanceMetadata(client.db, {
      workspaceId: f.context.workspaceId,
      subjectId: f.human.actor.subjectId,
    });
    expect(
      metadata.descriptors.some((descriptor) => descriptor.id === selected.skillReceipt.skillId),
    ).toBe(false);
    const [snapshot] = await shared!.admin`select * from preference_registry_canonical_snapshot_at(
      ${f.context.accountId},${f.context.workspaceId},${f.human.actor.subjectId},now())`;
    expect(snapshot!.canonical_descriptors).not.toContainEqual(
      expect.objectContaining({ id: selected.skillReceipt.skillId }),
    );
    expect(
      (await listInstalledPortableSkills(client.db, f.context.workspaceId)).some((skill) =>
        skill.capabilityId.endsWith("-selected"),
      ),
    ).toBe(false);
    expect(
      (
        await listInstalledPortableSkills(client.db, f.context.workspaceId, {
          includeSessionSelected: true,
        })
      ).some((skill) => skill.capabilityId.endsWith("-selected")),
    ).toBe(true);
    await expect(
      uninstallPortableSkill(client.db, {
        ...f.context,
        capabilityId: `${input.capabilityId}-selected`,
        expectedInstallationVersion: selected.installationVersion,
        skillActor: f.agent.actor,
      }),
    ).rejects.toThrow("agent removal are unsupported");
    const sourceRemoved = await uninstallPortableSkill(client.db, {
      ...f.context,
      capabilityId: `${input.capabilityId}-selected`,
      expectedInstallationVersion: selected.installationVersion,
      skillActor: f.human.actor,
    });
    expect(sourceRemoved.skillReleases).toEqual([
      expect.objectContaining({
        skillId: selected.skillReceipt.skillId,
        disposition: "deactivated",
        eventId: expect.any(String),
      }),
    ]);
    const [head] = await shared!
      .admin`select status from preference_registry_preferences where id=${selected.skillReceipt.skillId}`;
    expect(head!.status).toBe("inactive");
    const [event] = await shared!
      .admin`select actor_subject_id from preference_registry_events where id=${sourceRemoved.skillReleases![0]!.eventId}`;
    expect(event!.actor_subject_id).toBe(f.human.actor.subjectId);
  });
});

async function answeredSkillInput(
  f: Awaited<ReturnType<typeof fixture>>,
  review: SkillReviewReference,
  values = ["save"],
  respondedBy = f.human.actor.subjectId,
  options: {
    label?: string;
    authorized?: boolean;
    pending?: boolean;
    legacyWire?: boolean;
    serializeWire?: boolean;
  } = {},
) {
  const id = crypto.randomUUID();
  let questions = skillReviewHumanInput(review).questions.map((question) => ({
    ...question,
    ...(options.label ? { label: options.label } : {}),
    ...(options.legacyWire
      ? {
          allowOther: true,
          options: question.options.map((option) => ({ ...option, description: null })),
          validation: null,
        }
      : {}),
  }));
  if (options.serializeWire) {
    questions = serializeHumanInputRequests([
      {
        name: "request_human_input",
        rawItem: {
          callId: `skill-${id}`,
          arguments: JSON.stringify({ questions, allowSkip: false, expiresInSeconds: null }),
        },
      },
    ])[0]!.input.questions as typeof questions;
  }
  await shared!.admin`
    insert into session_human_input_requests (
      id,account_id,workspace_id,session_id,turn_id,turn_generation,creation_attempt_id,
      tool_call_id,status,questions,allow_skip,response,responded_by,responded_at,skill_review_human_authorized
    ) values (
      ${id},${f.context.accountId},${f.context.workspaceId},${f.agent.actor.sessionId},
      ${f.agent.actor.turnId},1,${f.agent.actor.attemptId},${`skill-${id}`},${options.pending ? "pending" : "answered"},
      ${shared!.admin.json(questions)}::jsonb,false,
      ${shared!.admin.json({ outcome: "answered", answers: [{ questionId: questions[0]!.id, values }] })}::jsonb,
      ${options.pending ? null : respondedBy},${options.pending ? null : new Date()},${!options.pending && options.authorized !== false}
    )`;
  return id;
}

describe("one chat Skill confirmation", () => {
  test("forward Skill cutover refuses a connected runtime before changing schema", async () => {
    if (!client || !shared) return;
    const f = await fixture("suggest");
    await saveSkill(client.db, f.input);
    const migration = await Bun.file(
      new URL("../../db/drizzle/0435_skill_chat_confirmation.sql", import.meta.url),
    ).text();
    const runtimeRole = decodeURIComponent(new URL(shared.appUrl).username);
    await expect(
      shared.admin.begin(async (tx) => {
        await tx`select set_config('opengeni.migration_application_roles',${JSON.stringify([runtimeRole])},true)`;
        await tx.unsafe(migration);
      }),
    ).rejects.toThrow("0435 requires drained application sessions");
    expect(
      (
        await readSkill(
          client.db,
          { ...f.context, subjectId: f.human.actor.subjectId },
          f.input.skillId,
        )
      )?.activeRevisionId,
    ).toBeTruthy();
  });

  test("direct agent Skill installation returns one bound chat review and activates installed files", async () => {
    if (!client || !shared) return;
    const f = await fixture("suggest");
    const content = skillMarkdown("Installed Skill instructions");
    const hash = createHash("sha256").update(content).digest("hex");
    const key = crypto.randomUUID();
    const input: InstallPortableSkillInput = {
      ...f.context,
      subjectId: `service:skill-attempt:${f.agent.actor.attemptId}`,
      skillActor: f.agent.actor,
      skillOperationId: crypto.randomUUID(),
      capabilityId: `skill:${key}`,
      pluginKey: `skill/direct-chat/${key}`,
      source: "github",
      sourceUrl: "https://example.test/skill",
      repositoryUrl: "https://example.test/repo",
      sourceCommit: "a".repeat(40),
      sourcePath: key,
      name: "test-skill",
      description: "Test Skill folder",
      contentSha256: hash,
      totalBytes: Buffer.byteLength(content),
      files: [
        { path: "SKILL.md", content, byteSize: Buffer.byteLength(content), contentSha256: hash },
      ],
    };
    // Same direct-owner default used by the worker's skill_install callback.
    const installed = await installPortableSkill(client.db, input);
    expect(installed.skillReceipt).toMatchObject({
      outcome: "pending",
      pendingReason: "approval",
      skillReview: {
        sourceOperationId: input.skillOperationId,
        skillId: installed.skillReceipt.skillId,
        revisionId: installed.skillReceipt.revisionId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
      },
    });
    const review = installed.skillReceipt.skillReview!;
    expect(await skillReviewResolution(client.db, f.context, review)).toBe("pending");
    expect(skillReviewHumanInput(review).questions[0]!.skillReview).toEqual(review);
    const requestId = await answeredSkillInput(f, review);
    expect(
      await confirmSkillHumanResponse(client.db, {
        ...f.context,
        subjectId: f.human.actor.subjectId,
        requestId,
      }),
    ).toMatchObject({ outcome: "applied", revisionId: installed.skillReceipt.revisionId });
    expect(await listInstalledPortableSkills(client.db, f.context.workspaceId)).toHaveLength(1);
    const replay = await installPortableSkill(client.db, input);
    expect(replay.skillReceipt).toEqual({ ...installed.skillReceipt, replayed: true });
    // Original receipt stays pending history; worker projection prevents a second prompt.
    expect(
      await skillReviewResolution(client.db, f.context, replay.skillReceipt.skillReview!),
    ).toBe("activated");
  }, 180000);

  test("activates exact complete folder once; rejects agent answers, unverified humans and altered references", async () => {
    if (!client || !shared) return;
    const f = await fixture("suggest");
    const pending = await saveSkill(client.db, {
      ...f.input,
      ...f.agent,
      files: [
        ...f.input.files,
        { path: "references/large.txt", content: "full content".repeat(1000) },
      ],
    });
    expect(pending.outcome).toBe("pending");
    const review = pending.skillReview!;
    const confirm = (requestId: string, subjectId = f.human.actor.subjectId) =>
      confirmSkillHumanResponse(client!.db, { ...f.context, subjectId, requestId });

    await expectDatabaseGuard(
      confirm(
        await answeredSkillInput(f, review, ["save"], `agent_attempt:${f.agent.actor.attemptId}`),
      ),
      "Exact human Skill confirmation unavailable",
    );
    await expectDatabaseGuard(
      confirm(await answeredSkillInput(f, { ...review, revisionId: crypto.randomUUID() })),
      "Exact human Skill confirmation unavailable",
    );
    await expectDatabaseGuard(
      confirm(
        await answeredSkillInput(f, review, ["save"], f.human.actor.subjectId, {
          authorized: false,
        }),
      ),
      "Exact human Skill confirmation unavailable",
    );
    await expectDatabaseGuard(
      confirm(
        await answeredSkillInput(f, review, ["save"], f.human.actor.subjectId, {
          label: "Save harmless metadata?",
        }),
      ),
      "Exact human Skill confirmation unavailable",
    );
    const requestId = await answeredSkillInput(f, review);
    // The original attempt has already paused. No model continuation is needed.
    await shared.admin`update session_turn_attempts set state='closed',outcome='requires_action',closed_at=now()
      where id=${f.agent.actor.attemptId}`;
    await shared.admin`update session_turns set status='requires_action' where id=${f.agent.actor.turnId}`;
    const applied = await confirm(requestId);
    expect(applied?.outcome).toBe("applied");
    expect(applied?.revisionId).toBe(pending.revisionId);
    expect(
      await skillReviewResolution(
        client.db,
        { ...f.context, subjectId: f.human.actor.subjectId },
        review,
      ),
    ).toBe("activated");

    expect(await confirm(requestId)).toEqual({ ...applied, replayed: true });
    const record = await readSkill(
      client.db,
      { ...f.context, subjectId: f.human.actor.subjectId },
      pending.skillId,
    );
    expect(record?.activeRevisionId).toBe(pending.revisionId);
    expect(record?.pendingRevisionIds).toEqual([]);
    expect(record?.files.find((file) => file.path === "references/large.txt")?.content).toBe(
      "full content".repeat(1000),
    );
  }, 180000);

  test("refuses stale revisions, foreign humans and revoked workspace authority", async () => {
    if (!client || !shared) return;
    for (const change of ["agent", "human", "revoked", "foreign"] as const) {
      const f = await fixture("suggest");
      const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
      const requestId = await answeredSkillInput(f, pending.skillReview!);
      if (change === "agent" || change === "human") {
        await saveSkill(client.db, {
          ...f.input,
          ...f[change],
          operationId: crypto.randomUUID(),
          files: [{ path: "SKILL.md", content: skillMarkdown("Newer edit") }],
        });
      }
      if (change === "revoked")
        await shared.admin`delete from workspace_memberships where workspace_id=${f.context.workspaceId}
        and subject_id=${f.human.actor.subjectId}`;
      await expect(
        confirmSkillHumanResponse(client.db, {
          ...f.context,
          requestId,
          subjectId: change === "foreign" ? "user:other" : f.human.actor.subjectId,
        }),
      ).rejects.toThrow();
    }
  }, 180000);

  test.each([false, true])(
    "real response admission for reported wire (serialized=%s) activates atomically and failure leaves the question unanswered",
    async (serializeWire) => {
      if (!client || !shared) return;
      const f = await fixture("suggest");
      const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
      const requestId = await answeredSkillInput(
        f,
        pending.skillReview!,
        ["save"],
        f.human.actor.subjectId,
        { pending: true, legacyWire: true, serializeWire },
      );
      const [trigger] = await appendSessionEvents(
        client.db,
        f.context.workspaceId,
        f.agent.actor.sessionId,
        [{ type: "user.message", payload: { text: "Create Skill" } }],
      );
      await shared.admin`update session_turns set trigger_event_id=${trigger!.id} where id=${f.agent.actor.turnId}`;
      await shared.admin`update sessions set status='requires_action' where id=${f.agent.actor.sessionId}`;
      await shared.admin`update session_turns set status='requires_action' where id=${f.agent.actor.turnId}`;
      await shared.admin`update session_turn_attempts set state='closed',outcome='requires_action',closed_at=now()
      where id=${f.agent.actor.attemptId}`;
      const response = {
        outcome: "answered",
        answers: [{ questionId: `skill:${pending.revisionId}`, values: ["save"] }],
      };
      const input = {
        ...f.context,
        sessionId: f.agent.actor.sessionId,
        requestId,
        response,
        respondedBy: f.human.actor.subjectId,
      };
      const [originalCard] =
        await shared.admin`select questions from session_human_input_requests where id=${requestId}`;
      await expect(
        acceptSessionHumanInputResponse(client.db, {
          ...input,
          canonicalHumanSession: true,
          response: { ...response, answers: [{ ...response.answers[0]!, other: "save anyway" }] },
        }),
      ).rejects.toThrow();
      await expect(acceptSessionHumanInputResponse(client.db, input)).rejects.toThrow();
      await expect(
        acceptSessionHumanInputResponse(client.db, {
          ...input,
          canonicalHumanSession: true,
          respondedBy: "user:another",
        }),
      ).rejects.toThrow();
      const [stillPending] =
        await shared.admin`select status,skill_review_human_authorized from session_human_input_requests where id=${requestId}`;
      expect(stillPending).toMatchObject({
        status: "pending",
        skill_review_human_authorized: false,
      });
      const accepted = await acceptSessionHumanInputResponse(client.db, {
        ...input,
        canonicalHumanSession: true,
      });
      expect(accepted.action).toBe("accepted");
      expect(
        (
          await readSkill(
            client.db,
            { ...f.context, subjectId: f.human.actor.subjectId },
            pending.skillId,
          )
        )?.activeRevisionId,
      ).toBe(pending.revisionId);
      const replay = await acceptSessionHumanInputResponse(client.db, {
        ...input,
        canonicalHumanSession: true,
      });
      expect(replay.action).toBe("completed");
      expect(replay.events).toEqual([]);
      const [retainedCard] =
        await shared.admin`select questions from session_human_input_requests where id=${requestId}`;
      expect(retainedCard!.questions).toEqual(originalCard!.questions);
    },
    180000,
  );

  test("real settlement preserves Skill choices and exact legacy bytes across a parallel interruption re-freeze", async () => {
    if (!client || !shared) return;
    const f = await fixture("suggest");
    const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
    const questions = skillReviewHumanInput(pending.skillReview!).questions;
    const skillRequestId = crypto.randomUUID();
    const ordinaryRequestId = crypto.randomUUID();
    const [trigger] = await appendSessionEvents(
      client.db,
      f.context.workspaceId,
      f.agent.actor.sessionId,
      [{ type: "user.message", payload: { text: "Create Skill" } }],
    );
    await shared.admin`update session_turns set trigger_event_id=${trigger!.id} where id=${f.agent.actor.turnId}`;
    const skillRequest = {
      id: skillRequestId,
      toolCallId: "skill-call",
      questions,
      allowSkip: false,
      expiresAt: null,
    };
    const first = await applySessionTurnSettlement(client.db, f.context.workspaceId, {
      sessionId: f.agent.actor.sessionId,
      turnId: f.agent.actor.turnId,
      triggerEventId: trigger!.id,
      attemptId: f.agent.actor.attemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: f.agent.actor.turnId,
      runState: {
        serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
        pendingApprovals: [],
        humanInputRequests: [
          skillRequest,
          {
            id: ordinaryRequestId,
            toolCallId: "ordinary-call",
            allowSkip: false,
            expiresAt: null,
            questions: [
              {
                id: "ordinary",
                kind: "single_select",
                prompt: "Continue?",
                required: true,
                allowOther: false,
                options: [{ id: "yes", label: "Yes" }],
              },
            ],
          },
        ],
      },
      events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
    });
    expect(first.action).toBe("settled");
    const [storedNew] =
      await shared.admin`select questions from session_human_input_requests where id=${skillRequestId}`;
    expect(storedNew!.questions).toEqual(questions);
    expect(storedNew!.questions[0].allowOther).toBe(false);
    // Simulate the exact historical serializer shape, never a migration write.
    const legacy = questions.map((question) => ({
      ...question,
      allowOther: true,
      validation: null,
      options: question.options.map((option) => ({ ...option, description: null })),
    }));
    await shared.admin`update session_human_input_requests set questions=${shared.admin.json(legacy)}::jsonb where id=${skillRequestId}`;
    const answered = await acceptSessionHumanInputResponse(client.db, {
      ...f.context,
      sessionId: f.agent.actor.sessionId,
      requestId: ordinaryRequestId,
      respondedBy: f.human.actor.subjectId,
      response: { outcome: "answered", answers: [{ questionId: "ordinary", values: ["yes"] }] },
    });
    if (answered.action !== "accepted") throw new Error("ordinary interruption not admitted");
    const attemptId = crypto.randomUUID();
    const resumed = await claimSessionWorkForAttempt(client.db, f.context.workspaceId, {
      sessionId: f.agent.actor.sessionId,
      workflowId: f.agent.actor.turnId,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "approval", triggerEventId: answered.event.id },
    });
    if (resumed.action !== "claimed") throw new Error(`resume claim failed: ${resumed.reason}`);
    const serialized = serializeHumanInputRequests([
      {
        name: "request_human_input",
        rawItem: {
          callId: "skill-call",
          arguments: JSON.stringify({ questions: legacy, allowSkip: false }),
        },
      },
    ])[0]!.input.questions;
    const refreeze = (nextQuestions = serialized, expiresAt: Date | null = null) =>
      applySessionTurnSettlement(client!.db, f.context.workspaceId, {
        sessionId: f.agent.actor.sessionId,
        turnId: resumed.turn.id,
        triggerEventId: resumed.turn.triggerEventId,
        attemptId,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: resumed.turn.id,
        runState: {
          serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
          pendingApprovals: [],
          humanInputRequests: [{ ...skillRequest, questions: nextQuestions, expiresAt }],
        },
        events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
      });
    await expect(
      refreeze(
        serialized.map((question) => ({
          ...question,
          skillReview: { ...question.skillReview!, sourceOperationId: crypto.randomUUID() },
        })),
      ),
    ).rejects.toThrow(/changed contract/);
    await expect(
      refreeze(serialized.map((question) => ({ ...question, prompt: "Save metadata only?" }))),
    ).rejects.toThrow(/confirmation contract/);
    await expect(refreeze(serialized, new Date(Date.now() + 60000))).rejects.toThrow(
      /changed contract/,
    );
    // Unknown stored fields cannot disappear through parser projection.
    await shared.admin`update session_human_input_requests set questions=jsonb_set(questions,'{0,options,0,extra}','null'::jsonb) where id=${skillRequestId}`;
    await expect(refreeze()).rejects.toThrow(/changed contract/);
    await shared.admin`update session_human_input_requests set questions=${shared.admin.json(legacy)}::jsonb where id=${skillRequestId}`;
    expect((await refreeze()).action).toBe("settled");
    const [retained] =
      await shared.admin`select questions,turn_generation,skill_review_human_authorized from session_human_input_requests where id=${skillRequestId}`;
    expect(retained!.questions).toEqual(legacy);
    expect(retained!.turn_generation).toBe(resumed.turn.executionGeneration);
    expect(retained!.skill_review_human_authorized).toBe(false);
    const saved = await acceptSessionHumanInputResponse(client.db, {
      ...f.context,
      sessionId: f.agent.actor.sessionId,
      requestId: skillRequestId,
      respondedBy: f.human.actor.subjectId,
      canonicalHumanSession: true,
      response: {
        outcome: "answered",
        answers: [{ questionId: questions[0]!.id, values: ["save"] }],
      },
    });
    expect(saved.action).toBe("accepted");
    expect((await readSkill(client.db, f.context, pending.skillId))?.activeRevisionId).toBe(
      pending.revisionId,
    );
  }, 180000);

  test("legacy-wire compatibility keeps exact option semantics and rejects Other at the SQL boundary", async () => {
    if (!client || !shared) return;
    for (const mutation of [
      "description",
      "label",
      "extra-option",
      "extra-field",
      "other",
    ] as const) {
      const f = await fixture("suggest");
      const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
      const requestId = await answeredSkillInput(
        f,
        pending.skillReview!,
        ["save"],
        f.human.actor.subjectId,
        { legacyWire: true },
      );
      const [row] =
        await shared.admin`select questions,response from session_human_input_requests where id=${requestId}`;
      const questions = row!.questions;
      const response = row!.response;
      if (mutation === "description") questions[0].options[0].description = "Only saves metadata";
      if (mutation === "label") questions[0].options[0].label = "Preview";
      if (mutation === "extra-option") questions[0].options.push({ id: "other", label: "Other" });
      if (mutation === "extra-field") questions[0].options[0].extra = null;
      if (mutation === "other") response.answers[0].other = "do not activate";
      await shared.admin`update session_human_input_requests set questions=${shared.admin.json(questions)}::jsonb,
        response=${shared.admin.json(response)}::jsonb where id=${requestId}`;
      await expectDatabaseGuard(
        confirmSkillHumanResponse(client.db, {
          ...f.context,
          subjectId: f.human.actor.subjectId,
          requestId,
        }),
        "Exact human Skill confirmation unavailable",
      );
      expect((await readSkill(client.db, f.context, pending.skillId))?.activeRevisionId).toBeNull();
    }
  }, 180000);

  test("legacy-wire Don't save declines without activation", async () => {
    if (!client || !shared) return;
    const f = await fixture("suggest");
    const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
    const requestId = await answeredSkillInput(
      f,
      pending.skillReview!,
      ["skip"],
      f.human.actor.subjectId,
      { legacyWire: true },
    );
    const result = await confirmSkillHumanResponse(client.db, {
      ...f.context,
      subjectId: f.human.actor.subjectId,
      requestId,
    });
    expect(result?.decision).toBe("rejected");
    expect((await readSkill(client.db, f.context, pending.skillId))?.activeRevisionId).toBeNull();
  }, 180000);

  test("stale Save and Don't save roll back the human response after newer proposed or active edits", async () => {
    if (!client || !shared) return;
    for (const choice of ["save", "skip"]) {
      for (const actor of ["agent", "human"] as const) {
        const f = await fixture("suggest");
        const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
        const requestId = await answeredSkillInput(
          f,
          pending.skillReview!,
          [choice],
          f.human.actor.subjectId,
          { pending: true },
        );
        const [trigger] = await appendSessionEvents(
          client.db,
          f.context.workspaceId,
          f.agent.actor.sessionId,
          [{ type: "user.message", payload: { text: "Create Skill" } }],
        );
        await saveSkill(client.db, {
          ...f.input,
          ...f[actor],
          operationId: crypto.randomUUID(),
          files: [{ path: "SKILL.md", content: skillMarkdown("Newer edit") }],
        });
        await shared.admin`update session_turns set trigger_event_id=${trigger!.id},status='requires_action' where id=${f.agent.actor.turnId}`;
        await shared.admin`update sessions set status='requires_action' where id=${f.agent.actor.sessionId}`;
        await shared.admin`update session_turn_attempts set state='closed',outcome='requires_action',closed_at=now() where id=${f.agent.actor.attemptId}`;
        await expect(
          acceptSessionHumanInputResponse(client.db, {
            ...f.context,
            sessionId: f.agent.actor.sessionId,
            requestId,
            respondedBy: f.human.actor.subjectId,
            canonicalHumanSession: true,
            response: {
              outcome: "answered",
              answers: [{ questionId: `skill:${pending.revisionId}`, values: [choice] }],
            },
          }),
        ).rejects.toThrow();
        const [stored] =
          await shared.admin`select status,skill_review_human_authorized from session_human_input_requests where id=${requestId}`;
        expect(stored).toMatchObject({ status: "pending", skill_review_human_authorized: false });
        const [rejected] =
          await shared.admin`select count(*)::int as count from preference_registry_events where new_revision_id=${pending.revisionId} and type='rejected'`;
        expect(rejected?.count).toBe(0);
      }
    }
  }, 180000);

  test("Don't save settles only the pending revision and preserves the active Skill", async () => {
    if (!client || !shared) return;
    const f = await fixture("suggest");
    const active = await saveSkill(client.db, f.input);
    const proposed = await saveSkill(client.db, {
      ...f.input,
      ...f.agent,
      operationId: crypto.randomUUID(),
      expectedRevisionId: active.revisionId,
      files: [{ path: "SKILL.md", content: skillMarkdown("Proposed edit") }],
    });
    const requestId = await answeredSkillInput(f, proposed.skillReview!, ["skip"]);
    const declined = await confirmSkillHumanResponse(client.db, {
      ...f.context,
      subjectId: f.human.actor.subjectId,
      requestId,
    });
    expect(declined).toMatchObject({
      outcome: "preserved",
      decision: "rejected",
      revisionId: proposed.revisionId,
    });
    const record = await readSkill(
      client.db,
      { ...f.context, subjectId: f.human.actor.subjectId },
      proposed.skillId,
    );
    expect(record?.activeRevisionId).toBe(active.revisionId);
    expect(record?.pendingRevisionIds).toEqual([]);
    expect(
      await skillReviewResolution(
        client.db,
        { ...f.context, subjectId: f.human.actor.subjectId },
        proposed.skillReview!,
      ),
    ).toBe("declined");
    const replay = await confirmSkillHumanResponse(client.db, {
      ...f.context,
      subjectId: f.human.actor.subjectId,
      requestId,
    });
    expect(replay.replayed).toBe(true);
    for (const choice of ["save", "skip"]) {
      const repeatedRequest = await answeredSkillInput(f, proposed.skillReview!, [choice]);
      await expect(
        confirmSkillHumanResponse(client.db, {
          ...f.context,
          subjectId: f.human.actor.subjectId,
          requestId: repeatedRequest,
        }),
      ).rejects.toThrow("This Skill changed");
    }
    const [rejections] =
      await shared.admin`select count(*)::int as count from preference_registry_events where new_revision_id=${proposed.revisionId} and type='rejected'`;
    expect(rejections?.count).toBe(1);
  }, 180000);

  test("autonomous produces no review and Off creates no durable proposal", async () => {
    if (!client || !shared) return;
    const auto = await fixture("automatic");
    const result = await saveSkill(client.db, { ...auto.input, ...auto.agent });
    expect(result.outcome).toBe("applied");
    expect(result.skillReview).toBeUndefined();
    const off = await fixture("off");
    await expect(saveSkill(client.db, { ...off.input, ...off.agent })).rejects.toThrow();
    expect(
      await readSkill(
        client.db,
        { ...off.context, subjectId: off.human.actor.subjectId },
        off.input.skillId,
      ),
    ).toBeNull();
  }, 180000);
});
