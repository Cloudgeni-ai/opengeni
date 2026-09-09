import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createHash } from "node:crypto";
import {
  activateWorkspaceLearningPolicyRevision,
  bootstrapWorkspace,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
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
  preparePackInstallationOperation,
  finalizePackInstallationOperation,
  preparePluginPackageInstall,
  finalizePluginPackageInstall,
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
    const policy = await createWorkspaceLearningPolicyRevision(client!.db, {
      ...context,
      workspaceMode: mode,
      actorSubjectId: subjectId,
      principalKind: "human_session",
    });
    await activateWorkspaceLearningPolicyRevision(client!.db, {
      ...context,
      revisionId: policy.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: subjectId,
      principalKind: "human_session",
      reason: "Skill lifecycle test policy",
    });
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
          const [policyHead] = await shared!
            .admin`SELECT revision_id,activation_version FROM workspace_learning_policy_heads WHERE workspace_id=${f.context.workspaceId}`;
          const policy = await createWorkspaceLearningPolicyRevision(client.db, {
            ...f.context,
            workspaceMode: "off",
            actorSubjectId: scope.subjectId,
            principalKind: "human_session",
          });
          await activateWorkspaceLearningPolicyRevision(client.db, {
            ...f.context,
            revisionId: policy.id,
            expectedCurrentRevisionId: policyHead!.revision_id,
            expectedActivationVersion: Number(policyHead!.activation_version),
            actorSubjectId: scope.subjectId,
            principalKind: "human_session",
            reason: "Downgrade Learning before source finalization",
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
                : scenario === "policy_off" || scenario === "attempt_ended"
                  ? "pending"
                  : "applied",
            revisionId: child.skillReceipt.revisionId,
          });
        expect(await listSkillDescriptors(client.db, f.context)).toHaveLength(
          scenario === "automatic" ||
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
        if (mode === "suggest" || scenario === "policy_off" || scenario === "attempt_ended") {
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
  options: { label?: string; authorized?: boolean; pending?: boolean } = {},
) {
  const id = crypto.randomUUID();
  const questions = skillReviewHumanInput(review).questions.map((question) => ({
    ...question,
    ...(options.label ? { label: options.label } : {}),
  }));
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

  test("real response admission activates atomically and failure leaves the question unanswered", async () => {
    if (!client || !shared) return;
    const f = await fixture("suggest");
    const pending = await saveSkill(client.db, { ...f.input, ...f.agent });
    const requestId = await answeredSkillInput(
      f,
      pending.skillReview!,
      ["save"],
      f.human.actor.subjectId,
      { pending: true },
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
    expect(stillPending).toMatchObject({ status: "pending", skill_review_human_authorized: false });
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
    const staleSave = await answeredSkillInput(f, proposed.skillReview!, ["save"]);
    await expect(
      confirmSkillHumanResponse(client.db, {
        ...f.context,
        subjectId: f.human.actor.subjectId,
        requestId: staleSave,
      }),
    ).rejects.toThrow();
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
