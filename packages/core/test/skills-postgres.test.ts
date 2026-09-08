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
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { SkillSaveInput } from "@opengeni/contracts";
import { approveSkill, listSkills, readSkill, restoreSkill, saveSkill } from "../src/domain/skills";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
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

async function fixture(mode: "off" | "suggest" | "automatic") {
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
    title: "Test Skill",
    description: "Test Skill folder",
    files: [
      { path: "SKILL.md", content: "# Test Skill\nUse original behavior." },
      { path: "references/context.txt", content: "context" },
    ],
    reason: "Skill test",
  };
  return { context, human, agent, input };
}

describe("unified Skill real PostgreSQL lifecycle", () => {
  test("human bypasses Off, roundtrips files, retries exactly, CAS conflicts and restore creates history", async () => {
    if (!client) return;
    const f = await fixture("off");
    const first = await saveSkill(client.db, f.input);
    expect(first.outcome).toBe("applied");
    expect(await saveSkill(client.db, f.input)).toEqual({ ...first, replayed: true });
    expect((await readSkill(client.db, f.context, first.skillId))?.files).toEqual(f.input.files);
    await expect(
      saveSkill(client.db, { ...f.input, title: "different same key" }),
    ).rejects.toThrow();
    const second = await saveSkill(client.db, {
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevisionId: first.revisionId,
      files: [{ path: "SKILL.md", content: "changed" }],
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
    ).toBe("changed");
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
          files: [{ path: "SKILL.md", content }],
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
    const content = "# Source Skill\nOriginal source instructions.";
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
      totalBytes: Buffer.byteLength(content),
      files: [
        { path: "SKILL.md", content, byteSize: Buffer.byteLength(content), contentSha256: digest },
      ],
    };
    const installed = await installPortableSkill(client.db, input);
    expect(installed.skillReceipt.outcome).toBe("applied");
    const customFiles = [
      { path: "SKILL.md", content: "Customized behavior" },
      { path: "reference.txt", content: "keep me" },
    ];
    const custom = await saveSkill(client.db, {
      ...f.input,
      skillId: installed.skillReceipt.skillId,
      expectedRevisionId: installed.skillReceipt.revisionId,
      files: customFiles,
    });
    const updatedContent = "Updated upstream source";
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
    ).rejects.toThrow("Deactivate the unified Skill head");
    const projection = await listInstalledPortableSkills(client.db, f.context.workspaceId);
    expect(projection[0]?.name).toBe("source-skill");
    expect(projection[0]?.files).toEqual(customFiles);
    expect(await listSkills(client.db, f.context)).toHaveLength(1);
    const [owners] = await shared!
      .admin`select count(*)::integer as count from capability_component_owners where workspace_id=${f.context.workspaceId}`;
    expect(owners!.count).toBeGreaterThan(0);

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
  });
});
