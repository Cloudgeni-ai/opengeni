import {
  prepareKnowledgeFile,
  updateScheduledTaskForApi,
  captureScheduledTaskRestoreState,
  syncUpdatedScheduledTask,
  type AccessGrantAuthorization,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { parseDocumentBytes, type DocumentServices } from "@opengeni/documents";
import type { ObjectStorage } from "@opengeni/storage";
import { knowledgeContractPdf } from "./fixtures/knowledge-pdf";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  appendSessionHistoryItems,
  createSession,
  createScheduledTask,
  getScheduledTask,
  createFileUpload,
  requireFileForSubject,
  getFilesForSubject,
  listFilesForSubject,
  nestedPostgresSqlState,
  withSessionRlsActorContext,
} from "../src";
import { applySkillLifecycle } from "../src/skills";
import { createTaskNote, archiveTaskNote } from "../src/task-notes";
import {
  freezeAgentLearningPolicy,
  getKnowledgeOriginalFile,
  inspectKnowledgeFilePreparation,
  completeKnowledgeFilePreparation,
  archiveKnowledgeEntry,
  getAgentLearningSettings,
  listAgentLearningOverrides,
  getAgentInstruction,
  getKnowledgeEntry,
  listKnowledgeEntries,
  listKnowledgeReviewBatches,
  restoreKnowledgeEntry,
  reviewKnowledgeEntry,
  saveAgentLearningSettings,
  saveKnowledgeEntry,
  reviewKnowledgeEntries,
  saveAgentInstruction,
  reviewAgentInstruction,
  listAgentInstructionReviews,
  promoteTaskNoteToKnowledge,
  type KnowledgeContext,
} from "../src/knowledge-entries";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("unified-knowledge");
  if (!shared) throw new Error("Unified Knowledge verification requires PostgreSQL");
  client = createDb(shared.appUrl, { max: 8 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  const subjectId = `user:${crypto.randomUUID()}`;
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await shared!.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Knowledge test')`;
  await shared!
    .admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Knowledge workspace')`;
  await shared!
    .admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
  const human: KnowledgeContext & { actor: Extract<KnowledgeContext["actor"], { kind: "human" }> } =
    {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId,
        writeScopes: ["workspace", "personal", "organization"],
        settingsScopes: ["workspace", "personal"],
        review: true,
      },
    };
  return { accountId, workspaceId, subjectId, human };
}
async function attempt(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: "automatic" | "review_first" | null = "automatic",
  personal = false,
  memoryScope: "workspace" | "off" = "workspace",
) {
  const session = await withSessionRlsActorContext({ subjectId: f.subjectId }, () =>
    createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "Learn about Acme",
      memoryScope,
      resources: [],
      metadata: {},
      ...(personal ? { memoryScope: "user" as const, scopeSubjectId: f.subjectId } : {}),
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: f.subjectId },
      createdByContext: {},
    }),
  );
  if (mode)
    await saveAgentLearningSettings(client.db, f.human, {
      scope: personal ? "personal" : "workspace",
      source: { kind: "chat", id: session.id },
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: mode },
    });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared!.admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.session_inference_claim','1',true)`;
    await tx`INSERT INTO session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
      status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,
      initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id)
      VALUES(${turnId},${f.accountId},${f.workspaceId},${session.id},${crypto.randomUUID()},${`knowledge-${turnId}`},
        'running','user',1,'Learn about Acme','test-model','medium','none',1,'subject',${f.subjectId},'{}',${f.subjectId})`;
    await tx`UPDATE sessions SET active_turn_id=${turnId},status='running' WHERE id=${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id=${attemptId} WHERE id=${turnId}`;
    await tx`INSERT INTO session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
      temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
      VALUES(${attemptId},${f.accountId},${f.workspaceId},${session.id},${turnId},1,'running',${`knowledge-${turnId}`},
        ${`run-${attemptId}`},${`activity-${attemptId}`},0,'{}')`;
  });
  const agent: KnowledgeContext & { actor: Extract<KnowledgeContext["actor"], { kind: "agent" }> } =
    {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      actor: { kind: "agent", sessionId: session.id, turnId, attemptId, executionGeneration: 1 },
    };
  return { session, agent };
}
function save(
  context: KnowledgeContext,
  content: string,
  options: { entryId?: string; expectedVersion?: number; scope?: "workspace" | "personal" } = {},
) {
  return saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: options.entryId ?? crypto.randomUUID(),
    expectedVersion: options.expectedVersion ?? 0,
    ...(options.scope ? { scope: options.scope } : {}),
    entry: { kind: "fact", title: "Acme renewal", content },
  });
}
async function fails(action: Promise<unknown>, state: string) {
  let error: unknown;
  try {
    await action;
  } catch (caught) {
    error = caught;
  }
  if (error && nestedPostgresSqlState(error) !== state) throw error;
  expect(nestedPostgresSqlState(error)).toBe(state);
}

describe("unified Knowledge storage", () => {
  test("review reliability: schedule and learning edits commit and compensate together", async () => {
    const f = await fixture();
    const task = await createScheduledTask(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      name: "Original schedule",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      createdBy: { kind: "subject", subjectId: f.subjectId },
      agentConfig: { prompt: "Read useful information", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    const authorization: AccessGrantAuthorization = {
      grant: {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        subjectId: f.subjectId,
        principalKind: "human_session",
        permissions: ["scheduled_tasks:manage", "workspace:admin"],
      },
      accountGrant: null,
      contextIntegrity: true,
      authenticatedSubjectId: f.subjectId,
      canonicalManagedHumanSession: false,
      canonicalLocalHumanSession: false,
    };
    const source = { kind: "scheduled_task" as const, id: task.id };
    const restoreState = await captureScheduledTaskRestoreState(client.db, task);
    await expect(
      updateScheduledTaskForApi(
        client.db,
        f.workspaceId,
        task.id,
        { name: "Must roll back" },
        {
          authorization,
          restoreState,
          request: {
            scope: "workspace",
            operationId: crypto.randomUUID(),
            expectedVersion: 99,
            settings: { knowledge: "review_first" },
          },
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getScheduledTask(client.db, f.workspaceId, task.id))?.name).toBe(
      "Original schedule",
    );
    const changed = await updateScheduledTaskForApi(
      client.db,
      f.workspaceId,
      task.id,
      { name: "Reviewed ingestion" },
      {
        authorization,
        restoreState,
        request: {
          scope: "workspace",
          operationId: crypto.randomUUID(),
          expectedVersion: 0,
          settings: { knowledge: "review_first" },
        },
      },
    );
    expect(changed.name).toBe("Reviewed ingestion");
    expect(
      (await getAgentLearningSettings(client.db, f.human, "workspace", source)).settings,
    ).toEqual({ knowledge: "review_first" });
    await expect(
      syncUpdatedScheduledTask({
        db: client.db,
        previous: restoreState,
        task: changed,
        workflowClient: {
          syncScheduledTask: async () => {
            throw new Error("Temporal unavailable");
          },
        } as unknown as SessionWorkflowClient,
      }),
    ).rejects.toThrow();
    expect((await getScheduledTask(client.db, f.workspaceId, task.id))?.name).toBe(
      "Original schedule",
    );
    expect(
      (await getAgentLearningSettings(client.db, f.human, "workspace", source)).settings,
    ).toEqual({});
  });

  for (const kind of ["background_command_result", "session_wait_timeout"] as const) {
    test(`review reliability: ${kind} continuation preserves the accepted policy in every category`, async () => {
      const f = await fixture();
      await saveAgentLearningSettings(client.db, f.human, {
        scope: "workspace",
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        settings: { knowledge: "off", instructions: "off", skills: "off" },
      });
      const { agent, session } = await attempt(f, null);
      const accepted = await freezeAgentLearningPolicy(client.db, agent);
      await saveAgentLearningSettings(client.db, f.human, {
        scope: "workspace",
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        settings: { knowledge: "automatic", instructions: "automatic", skills: "automatic" },
      });
      const turnId = crypto.randomUUID(),
        attemptId = crypto.randomUUID();
      await shared!.admin.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.session_inference_claim','1',true)`;
        await tx`UPDATE session_turn_attempts SET state='closed',outcome='completed',closed_at=now() WHERE id=${agent.actor.attemptId}`;
        await tx`UPDATE session_turns SET status='completed',active_attempt_id=NULL WHERE id=${agent.actor.turnId}`;
        await tx`INSERT INTO session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
          status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,
          initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id)
          VALUES(${turnId},${f.accountId},${f.workspaceId},${session.id},${crypto.randomUUID()},${`continuation-${turnId}`},
          'running','system',2,'Continue','test-model','medium','none',1,'service','worker','{}',${f.subjectId})`;
        await tx`UPDATE sessions SET active_turn_id=${turnId},status='running' WHERE id=${session.id}`;
        await tx`UPDATE session_turns SET active_attempt_id=${attemptId} WHERE id=${turnId}`;
        await tx`INSERT INTO session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
          temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
          VALUES(${attemptId},${f.accountId},${f.workspaceId},${session.id},${turnId},1,'running',${`continuation-${turnId}`},
          ${`run-${attemptId}`},${`activity-${attemptId}`},0,'{}')`;
      });
      expect(
        await appendSessionHistoryItems(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: session.id,
          turnId,
          expectedExecutionGeneration: 1,
          expectedAttemptId: attemptId,
          items: [
            { position: 1, item: { role: "user", content: "Continue after the completed wait" } },
          ],
        }),
      ).toBe(true);
      const [history] = await shared!
        .admin`SELECT id FROM session_history_items WHERE turn_id=${turnId}`;
      await shared!
        .admin`INSERT INTO session_system_updates(account_id,workspace_id,session_id,kind,source_id,dedupe_key,summary,payload,
        lineage,state,delivered_turn_id,delivered_history_item_id,delivered_at)
        VALUES(${f.accountId},${f.workspaceId},${session.id},${kind},${crypto.randomUUID()},${crypto.randomUUID()},'Continue','{}',
        ${shared!.admin.json({ causalTurnId: agent.actor.turnId })},'delivered',${turnId},${history!.id},now())`;
      const resumed: KnowledgeContext = { ...agent, actor: { ...agent.actor, turnId, attemptId } };
      expect((await freezeAgentLearningPolicy(client.db, resumed)).effective).toEqual(
        accepted.effective,
      );
      await fails(save(resumed, "Must remain Off"), "42501");
    });
  }

  test("review reliability: an edited source can be explicitly reconciled before approving its finding", async () => {
    const f = await fixture();
    const { agent } = await attempt(f, "review_first");
    const source = await saveKnowledgeEntry(client.db, agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        kind: "source",
        title: "Contract",
        content: "Thirty-day notice",
        source: { kind: "manual" },
      },
    });
    const finding = await saveKnowledgeEntry(client.db, agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        kind: "fact",
        title: "Notice period",
        content: "Thirty days",
        evidence: [
          { entryId: source.entryId, revisionId: source.revisionId, quote: "Thirty-day notice" },
        ],
      },
    });
    const published = await reviewKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: source.entryId,
      revisionId: source.revisionId,
      expectedVersion: 1,
      decision: "approve",
      entry: {
        kind: "source",
        title: "Contract",
        content: "Sixty-day notice",
        source: { kind: "manual" },
      },
    });
    await fails(
      reviewKnowledgeEntry(client.db, f.human, {
        operationId: crypto.randomUUID(),
        entryId: finding.entryId,
        revisionId: finding.revisionId,
        expectedVersion: 1,
        decision: "approve",
      }),
      "42501",
    );
    const pending = await getKnowledgeEntry(client.db, agent, finding.entryId, {
      view: "needs_review",
    });
    expect(pending?.revision.entry.evidence[0]?.revisionId).toBe(source.revisionId);
    await reviewKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: finding.entryId,
      revisionId: finding.revisionId,
      expectedVersion: 1,
      decision: "approve",
      entry: {
        ...pending!.revision.entry,
        content: "Sixty days",
        evidence: [{ entryId: source.entryId, revisionId: published.revisionId }],
      },
    });
    const result = await getKnowledgeEntry(client.db, agent, finding.entryId);
    expect(result?.revision.entry.content).toBe("Sixty days");
    expect(result?.revision.entry.evidence[0]?.revisionId).toBe(published.revisionId);
  });

  test("review reliability: later agents discover pending work without publishing it", async () => {
    const f = await fixture();
    const first = await attempt(f, "review_first");
    const proposed = await save(first.agent, "A pending Acme renewal");
    const later = await attempt(f, "review_first");
    const pending = await listKnowledgeEntries(client.db, later.agent, {
      view: "needs_review",
      query: "Acme",
    });
    expect(pending.entries.map((entry) => entry.id)).toEqual([proposed.entryId]);
    expect(pending.entries[0]!.revision.outcome).toBe("pending");
    const record = await getKnowledgeEntry(client.db, later.agent, proposed.entryId, {
      view: "needs_review",
    });
    expect(record?.revision.entry.content).toBe("A pending Acme renewal");
    expect(await getKnowledgeEntry(client.db, later.agent, proposed.entryId)).toBeNull();
    const correction = await save(later.agent, "An improved pending Acme renewal", {
      entryId: proposed.entryId,
      expectedVersion: record!.version,
    });
    expect(correction.outcome).toBe("pending");
    expect(
      (await listKnowledgeEntries(client.db, later.agent, { view: "needs_review" })).entries,
    ).toHaveLength(1);
    const outsider = await fixture();
    const unrelated = await attempt(outsider, "review_first");
    expect(
      (await listKnowledgeEntries(client.db, unrelated.agent, { view: "needs_review" })).entries,
    ).toEqual([]);
    const owner = await attempt(f, "review_first", true);
    const privateProposal = await save(owner.agent, "Private customer detail");
    expect(
      (
        await getKnowledgeEntry(client.db, owner.agent, privateProposal.entryId, {
          view: "needs_review",
        })
      )?.revision.outcome,
    ).toBe("pending");
    expect(
      await getKnowledgeEntry(client.db, later.agent, privateProposal.entryId, {
        view: "needs_review",
      }),
    ).toBeNull();
    const otherOwner = await attempt(
      {
        ...f,
        subjectId: "user:another-owner",
        human: { ...f.human, actor: { ...f.human.actor, subjectId: "user:another-owner" } },
      },
      "review_first",
      true,
    );
    expect(
      await getKnowledgeEntry(client.db, otherOwner.agent, privateProposal.entryId, {
        view: "needs_review",
      }),
    ).toBeNull();
  });

  test("review reliability: rejected new proposals remain discoverable and restorable", async () => {
    const f = await fixture();
    const { agent } = await attempt(f, "review_first");
    const proposed = await save(agent, "Rejected Acme detail");
    const rejected = await reviewKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: proposed.entryId,
      revisionId: proposed.revisionId,
      expectedVersion: proposed.version,
      decision: "reject",
    });
    const discarded = await listKnowledgeEntries(client.db, f.human, { view: "rejected" });
    expect(discarded.entries.map((entry) => entry.id)).toEqual([proposed.entryId]);
    expect(discarded.entries[0]!.revision.outcome).toBe("rejected");
    await restoreKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: proposed.entryId,
      revisionId: proposed.revisionId,
      expectedVersion: rejected.version,
    });
    expect(
      (await getKnowledgeEntry(client.db, agent, proposed.entryId))?.revision.entry.content,
    ).toBe("Rejected Acme detail");
  });

  test("review reliability: worker replacement replays the same logical save", async () => {
    const f = await fixture();
    const { agent } = await attempt(f, "review_first");
    const request = {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: { kind: "fact" as const, title: "Recovery", content: "A committed result" },
    };
    const saved = await saveKnowledgeEntry(client.db, agent, request);
    const replacementId = crypto.randomUUID();
    await shared!.admin.begin(async (tx) => {
      await tx`UPDATE session_turn_attempts SET state='closed',outcome='interrupted_recoverable',closed_at=now() WHERE id=${agent.actor.attemptId}`;
      await tx`UPDATE session_turns SET active_attempt_id=${replacementId},execution_generation=2 WHERE id=${agent.actor.turnId}`;
      await tx`INSERT INTO session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
        VALUES(${replacementId},${f.accountId},${f.workspaceId},${agent.actor.sessionId},${agent.actor.turnId},2,'running',${`recovery-${replacementId}`},${`run-${replacementId}`},${`activity-${replacementId}`},0,'{}')`;
    });
    const replacement: KnowledgeContext = {
      ...agent,
      actor: { ...agent.actor, attemptId: replacementId, executionGeneration: 2 },
    };
    const receipt = await saveKnowledgeEntry(client.db, replacement, request);
    expect(receipt).toEqual({ ...saved, replayed: true });
    await fails(saveKnowledgeEntry(client.db, agent, request), "42501");
    await fails(
      saveKnowledgeEntry(client.db, replacement, {
        ...request,
        entry: { ...request.entry, content: "Different content" },
      }),
      "23505",
    );
    const other = await attempt(f, "review_first");
    await fails(saveKnowledgeEntry(client.db, other.agent, request), "23505");
  });

  test("review reliability: hybrid search preserves lexical relevance before indexing", async () => {
    const f = await fixture();
    const weak = await saveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: "00000000-0000-4000-8000-000000000001",
      expectedVersion: 0,
      entry: { kind: "fact", title: "Unrelated", content: `Acme ${"filler ".repeat(100)} renewal` },
    });
    const strong = await saveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      expectedVersion: 0,
      entry: { kind: "fact", title: "Acme renewal", content: "Acme renewal Acme renewal" },
    });
    const found = await listKnowledgeEntries(
      client.db,
      f.human,
      { query: "Acme renewal", mode: "hybrid" },
      { model: "test", values: [1, 0, 0] },
    );
    expect(found.entries.map((entry) => entry.id)).toEqual([strong.entryId, weak.entryId]);
  });

  test("review reliability: title and late source passages match together", async () => {
    const f = await fixture();
    const source = await saveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        kind: "source",
        title: "Acme",
        content: `${"Unrelated text. ".repeat(2500)}renewal deadline December`,
        source: { kind: "manual" },
      },
    });
    const found = await listKnowledgeEntries(client.db, f.human, {
      query: "Acme renewal",
      mode: "keyword",
    });
    expect(found.entries.map((entry) => entry.id)).toEqual([source.entryId]);
  });

  test("new sessions created by old clients retain memoryScope off until an explicit context change", async () => {
    const f = await fixture();
    const { session, agent } = await attempt(f, null, false, "off");
    const accepted = await freezeAgentLearningPolicy(client.db, agent);
    expect(accepted.effective.knowledge).toBe("off");
    const source = { kind: "chat" as const, id: session.id };
    const migrated = await getAgentLearningSettings(client.db, f.human, "workspace", source);
    expect(migrated.settings.knowledge).toBe("off");
    await fails(save(agent, "An old opt-out must not silently save"), "42501");
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "workspace",
      source,
      operationId: crypto.randomUUID(),
      expectedVersion: migrated.version,
      settings: { knowledge: "inherit" },
    });
    expect(
      (await getAgentLearningSettings(client.db, f.human, "workspace", source)).settings,
    ).toEqual({});
    // The reset is for later accepted work, not an in-flight policy escalation.
    expect((await freezeAgentLearningPolicy(client.db, agent)).effective.knowledge).toBe("off");
  });

  test("a delegated gateway reads shared Knowledge without becoming its named human", async () => {
    const f = await fixture();
    const published = await save(f.human, "Gateway-visible shared fact");
    const personal = await save(f.human, "Gateway-invisible personal fact", { scope: "personal" });
    const gateway: KnowledgeContext = {
      ...f.human,
      actor: {
        kind: "service",
        principalKind: "mcp_gateway",
        subjectId: f.subjectId,
        writeScopes: ["workspace", "organization"],
        review: false,
        settingsScopes: [],
      },
    };
    expect(
      (await listKnowledgeEntries(client.db, gateway)).entries.map((entry) => entry.id),
    ).toEqual([published.entryId]);
    expect(await getKnowledgeEntry(client.db, gateway, personal.entryId)).toBeNull();
    // Even a misconfigured host cannot turn this retrieval adapter into a writer.
    await fails(save(gateway, "Unauthorized gateway write"), "42501");
    await fails(listKnowledgeEntries(client.db, gateway, { view: "needs_review" }), "42501");
  });

  test("personal knowledge and defaults survive deletion of their originating workspace", async () => {
    const f = await fixture();
    const destination = crypto.randomUUID();
    await shared!
      .admin`INSERT INTO workspaces(id,account_id,name) VALUES(${destination},${f.accountId},'Other workspace')`;
    const personal = await save(f.human, "Company research retained privately", {
      scope: "personal",
    });
    const workspaceEntry = await save(f.human, "Workspace-owned research");
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "personal",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "review_first", instructions: "off", skills: "automatic" },
    });
    await shared!.admin`DELETE FROM workspaces WHERE id=${f.workspaceId}`;
    const relocated = { ...f.human, workspaceId: destination };
    expect(
      (await getKnowledgeEntry(client.db, relocated, personal.entryId))?.revision.entry.content,
    ).toBe("Company research retained privately");
    expect(await getKnowledgeEntry(client.db, relocated, workspaceEntry.entryId)).toBeNull();
    expect(
      (await getAgentLearningSettings(client.db, relocated, "personal")).settings.knowledge,
    ).toBe("review_first");
  });
  test("retains exact long text, publishes, searches, and keeps list previews bounded", async () => {
    const f = await fixture();
    const text = `Acme contract\u0000${"renewal details ".repeat(800)}\ud800`;
    const saved = await save(f.human, text);
    expect(saved.outcome).toBe("published");
    expect(
      (await getKnowledgeEntry(client.db, f.human, saved.entryId))?.revision.entry.content,
    ).toBe(text);
    const found = await listKnowledgeEntries(client.db, f.human, { query: "renewal" });
    expect(found.entries.map((e) => e.id)).toEqual([saved.entryId]);
    expect(found.entries[0]!.revision.preview.length).toBeLessThanOrEqual(512);
    expect("entry" in found.entries[0]!.revision).toBe(false);
  });

  test("isolates workspace, organization and personal data with the non-owner runtime role", async () => {
    const f = await fixture();
    const personal = await save(f.human, "Owner-only contract", { scope: "personal" });
    const sharedFact = await save(f.human, "Shared renewal");
    const other = {
      ...f.human,
      actor: { ...f.human.actor, subjectId: `user:${crypto.randomUUID()}` },
    } as KnowledgeContext;
    expect(await getKnowledgeEntry(client.db, other, personal.entryId)).toBeNull();
    expect((await getKnowledgeEntry(client.db, other, sharedFact.entryId))?.id).toBe(
      sharedFact.entryId,
    );
    const alien = await fixture();
    expect(await getKnowledgeEntry(client.db, alien.human, sharedFact.entryId)).toBeNull();
    await fails(
      saveKnowledgeEntry(client.db, f.human, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        entry: {
          title: "Shared excerpt",
          kind: "fact",
          content: "Cannot publish private evidence",
          evidence: [{ entryId: personal.entryId, revisionId: personal.revisionId }],
        },
      }),
      "42501",
    );
    const privileges = await shared!
      .admin`SELECT has_table_privilege('opengeni_app','knowledge_entry_revisions','SELECT') AS allowed`;
    expect(privileges[0]?.allowed).toBe(false);
    const { agent } = await attempt(f);
    expect(await getKnowledgeEntry(client.db, agent, personal.entryId)).toBeNull();
    expect((await getKnowledgeEntry(client.db, agent, sharedFact.entryId))?.id).toBe(
      sharedFact.entryId,
    );
    await fails(
      saveKnowledgeEntry(client.db, agent, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        entry: {
          title: "Unavailable file",
          kind: "source",
          content: "A forged file reference",
          source: { kind: "file", fileId: crypto.randomUUID() },
        },
      }),
      "42501",
    );
  }, 180_000);

  test("a private agent reads shared facts but only authors its own personal Knowledge", async () => {
    const f = await fixture();
    const sharedFact = await save(f.human, "A shared customer fact");
    const { agent } = await attempt(f, null, true);
    expect(
      (await getKnowledgeEntry(client.db, agent, sharedFact.entryId))?.revision.entry.content,
    ).toBe("A shared customer fact");
    const privateFact = await save(agent, "A personal working conclusion");
    expect((await getKnowledgeEntry(client.db, f.human, privateFact.entryId))?.scope).toBe(
      "personal",
    );
    await fails(
      save(agent, "Cannot overwrite the shared fact", {
        entryId: sharedFact.entryId,
        expectedVersion: 1,
      }),
      "42501",
    );
    await fails(
      archiveKnowledgeEntry(client.db, agent, {
        operationId: crypto.randomUUID(),
        entryId: sharedFact.entryId,
        expectedVersion: 1,
      }),
      "42501",
    );
    const other = { ...f.human, actor: { ...f.human.actor, subjectId: "user:someone-else" } };
    expect(await getKnowledgeEntry(client.db, other, privateFact.entryId)).toBeNull();
  });

  test("file pages filter scope before limiting and retain timestamp precision", async () => {
    const f = await fixture();
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    for (const [index, id] of ids.entries()) {
      await shared!
        .admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key,created_at)
        VALUES(${id},${f.accountId},${f.workspaceId},'ready','File.txt','File.txt','text/plain',1,'test',${id},${`2026-09-10T12:00:00.12300${index}Z`}::text::timestamptz)`;
    }
    const input = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: f.subjectId,
      limit: 1,
    };
    const first = await listFilesForSubject(client.db, input);
    const second = await listFilesForSubject(client.db, { ...input, cursor: first.nextCursor! });
    const third = await listFilesForSubject(client.db, { ...input, cursor: second.nextCursor! });
    expect([...first.files, ...second.files, ...third.files].map((file) => file.id)).toEqual(
      [...ids].reverse(),
    );
    expect(third.nextCursor).toBeNull();
    expect((await listFilesForSubject(client.db, { ...input, scope: "personal" })).files).toEqual(
      [],
    );
  });

  test("personal originals require a verified owner scope, not merely a matching workspace subject", async () => {
    const f = await fixture();
    const fileId = crypto.randomUUID();
    const owned = { subjectId: f.subjectId, privateFileOwnerSubjectId: f.subjectId };
    await withSessionRlsActorContext(owned, () =>
      createFileUpload(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        fileId,
        privateOwnerSubjectId: f.subjectId,
        filename: "Private contract.pdf",
        safeFilename: "Private-contract.pdf",
        contentType: "application/pdf",
        sizeBytes: 123,
        bucket: "test",
        objectKey: fileId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await shared!.admin`UPDATE files SET status='ready' WHERE id=${fileId}`;
    const request = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: f.subjectId,
      fileId,
    };
    expect(await getFilesForSubject(client.db, { ...request, fileIds: [fileId] })).toEqual([]);
    const file = await withSessionRlsActorContext(owned, () =>
      requireFileForSubject(client.db, request),
    );
    expect(file.scope).toBe("personal");
    expect((await listFilesForSubject(client.db, { ...request, scope: "personal" })).files).toEqual(
      [],
    );
    const elsewhere = crypto.randomUUID();
    await shared!
      .admin`INSERT INTO workspaces(id,account_id,name) VALUES(${elsewhere},${f.accountId},'Another workspace')`;
    await withSessionRlsActorContext(owned, async () => {
      const page = await listFilesForSubject(client.db, {
        ...request,
        workspaceId: elsewhere,
        scope: "personal",
        limit: 1,
      });
      expect(page.files.map((item) => item.id)).toEqual([fileId]);
      expect(page.nextCursor).toBeNull();
      expect(
        (await requireFileForSubject(client.db, { ...request, workspaceId: elsewhere })).id,
      ).toBe(fileId);
    });

    expect(
      await withSessionRlsActorContext(
        { subjectId: "user:other", privateFileOwnerSubjectId: "user:other" },
        () =>
          getFilesForSubject(client.db, { ...request, subjectId: "user:other", fileIds: [fileId] }),
      ),
    ).toEqual([]);
    const source = {
      title: "Private contract",
      kind: "source" as const,
      content: "Private renewal terms",
      source: { kind: "file" as const, fileId },
    };
    const retained = await saveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "personal",
      entry: source,
    });
    expect(
      (await getKnowledgeEntry(client.db, f.human, retained.entryId))?.revision.entry.content,
    ).toBe(source.content);
    await fails(
      saveKnowledgeEntry(client.db, f.human, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        scope: "workspace",
        entry: source,
      }),
      "42501",
    );
    await fails(
      shared!.admin`UPDATE files SET private_owner_subject_ids=NULL WHERE id=${fileId}`,
      "55000",
    );
  });

  test("personal original and its source remain usable after the originating workspace is removed", async () => {
    const f = await fixture();
    const owned = { subjectId: f.subjectId, privateFileOwnerSubjectId: f.subjectId };
    const fileId = crypto.randomUUID();
    await withSessionRlsActorContext(owned, () =>
      createFileUpload(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        fileId,
        privateOwnerSubjectId: f.subjectId,
        filename: "Private.pdf",
        safeFilename: "Private.pdf",
        contentType: "application/pdf",
        sizeBytes: 123,
        bucket: "test",
        objectKey: fileId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await shared!.admin`UPDATE files SET status='ready' WHERE id=${fileId}`;
    const personal = await attempt(f, "automatic", true);
    const source = await completeKnowledgeFilePreparation(client.db, personal.agent, {
      fileId,
      title: "Private.pdf",
      content: "Private research",
    });
    if (source.status !== "retained") throw new Error("Expected retained source");
    const sharedAgent = await attempt(f);
    expect(
      await getKnowledgeOriginalFile(client.db, sharedAgent.agent, source.receipt.entryId),
    ).toBeNull();
    const destination = crypto.randomUUID();
    await shared!
      .admin`INSERT INTO workspaces(id,account_id,name) VALUES(${destination},${f.accountId},'Other workspace')`;
    await shared!.admin`DELETE FROM workspaces WHERE id=${f.workspaceId}`;
    const reader = { ...f.human, workspaceId: destination };
    expect(
      (await getKnowledgeEntry(client.db, reader, source.receipt.entryId))?.revision.entry.content,
    ).toBe("Private research");
    expect((await getKnowledgeOriginalFile(client.db, reader, source.receipt.entryId))?.id).toBe(
      fileId,
    );
    const stranger: KnowledgeContext = {
      ...reader,
      actor: {
        ...f.human.actor,
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:stranger",
        writeScopes: ["personal"],
        settingsScopes: ["personal"],
        review: true,
      },
    };
    expect(await getKnowledgeOriginalFile(client.db, stranger, source.receipt.entryId)).toBeNull();
  });

  test("retired groups and relationships disappear from discovery without erasing the entry", async () => {
    const f = await fixture();
    const group = await saveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: { title: "Acme", kind: "group", content: "" },
    });
    const fact = await saveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        title: "Renewal",
        kind: "fact",
        content: "Renewal on 1 December",
        groupIds: [group.entryId],
        relationships: [{ entryId: group.entryId, relation: "applies_to" }],
      },
    });
    expect(
      (await listKnowledgeEntries(client.db, f.human, { groupId: group.entryId })).entries.map(
        (e) => e.id,
      ),
    ).toEqual([fact.entryId]);
    await archiveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: group.entryId,
      expectedVersion: 1,
    });
    const read = await getKnowledgeEntry(client.db, f.human, fact.entryId);
    expect(read?.revision.entry).toMatchObject({
      content: "Renewal on 1 December",
      groupIds: [],
      relationships: [],
    });
    expect(
      (await listKnowledgeEntries(client.db, f.human, { groupId: group.entryId })).entries,
    ).toEqual([]);
    const stored = await shared!
      .admin`SELECT body FROM knowledge_entry_revisions WHERE id=${fact.revisionId}`;
    expect(stored[0]?.body.groupIds).toEqual([group.entryId]);
  });

  test("Review first saves without pausing and keeps the published revision until exact approval", async () => {
    const f = await fixture();
    const original = await save(f.human, "Renews 1 December");
    const { agent, session } = await attempt(f, "review_first");
    const proposed = await save(agent, "Renews 15 December", {
      entryId: original.entryId,
      expectedVersion: 1,
    });
    expect(proposed.outcome).toBe("pending");
    expect(proposed.reviewBatchId).not.toBeNull();
    expect(
      (await getKnowledgeEntry(client.db, agent, original.entryId))?.revision.entry.content,
    ).toBe("Renews 1 December");
    const fresh = await save(agent, "A new pending fact");
    expect(fresh.reviewBatchId).toBe(proposed.reviewBatchId);
    expect((await listKnowledgeReviewBatches(client.db, f.human)).batches).toMatchObject([
      { id: proposed.reviewBatchId, sessionId: session.id, pendingCount: 2, scope: "workspace" },
    ]);
    expect(
      (await listKnowledgeReviewBatches(client.db, f.human, { scope: "personal" })).batches,
    ).toEqual([]);
    await fails(listKnowledgeReviewBatches(client.db, agent), "42501");
    const outsider = await fixture();
    expect((await listKnowledgeReviewBatches(client.db, outsider.human)).batches).toEqual([]);

    expect(await getKnowledgeEntry(client.db, agent, fresh.entryId)).toBeNull();
    expect(
      (await shared!.admin`SELECT status FROM sessions WHERE id=${session.id}`)[0]?.status,
    ).toBe("running");
    await fails(
      reviewKnowledgeEntry(client.db, agent, {
        operationId: crypto.randomUUID(),
        entryId: original.entryId,
        revisionId: proposed.revisionId,
        expectedVersion: 2,
        decision: "approve",
      }),
      "42501",
    );
    const approved = await reviewKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: original.entryId,
      revisionId: proposed.revisionId,
      expectedVersion: 2,
      decision: "approve",
    });
    expect(approved.outcome).toBe("published");
    expect((await listKnowledgeReviewBatches(client.db, f.human)).batches).toMatchObject([
      { id: proposed.reviewBatchId, pendingCount: 1 },
    ]);

    expect(
      (await getKnowledgeEntry(client.db, agent, original.entryId))?.revision.entry.content,
    ).toBe("Renews 15 December");
  });

  test("replay is exact; stale corrections conflict; undo creates a revision", async () => {
    const f = await fixture();
    const operation = {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: { title: "Incident", kind: "incident" as const, content: "Original cause" },
    };
    const original = await saveKnowledgeEntry(client.db, f.human, operation);
    expect((await saveKnowledgeEntry(client.db, f.human, operation)).replayed).toBe(true);
    await fails(
      saveKnowledgeEntry(client.db, f.human, {
        ...operation,
        entry: { ...operation.entry, content: "Changed request" },
      }),
      "23505",
    );
    await save(f.human, "Corrected cause", { entryId: original.entryId, expectedVersion: 1 });
    await fails(
      save(f.human, "Stale correction", { entryId: original.entryId, expectedVersion: 1 }),
      "40001",
    );
    const restored = await restoreKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: original.entryId,
      revisionId: original.revisionId,
      expectedVersion: 2,
    });
    expect(restored.revisionId).not.toBe(original.revisionId);
    expect(
      (await getKnowledgeEntry(client.db, f.human, original.entryId))?.revision.entry.content,
    ).toBe("Original cause");
    await archiveKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: original.entryId,
      expectedVersion: 3,
    });
    expect(await getKnowledgeEntry(client.db, f.human, original.entryId)).toBeNull();
  });

  test("chat and schedule overrides can only address their actual personal or workspace layer", async () => {
    const f = await fixture();
    const { session: personal } = await attempt(f, null, true);
    const { session: sharedSession } = await attempt(f, null, false);
    const task = await createScheduledTask(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      name: "Review personal feedback",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `review-${crypto.randomUUID()}`,
      runMode: "existing_session",
      targetSessionId: personal.id,
      overlapPolicy: "allow_concurrent",
      createdBy: { kind: "subject", subjectId: f.subjectId },
      agentConfig: { prompt: "Read feedback", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    for (const source of [
      { kind: "chat" as const, id: personal.id },
      { kind: "scheduled_task" as const, id: task.id },
    ]) {
      await fails(
        saveAgentLearningSettings(client.db, f.human, {
          operationId: crypto.randomUUID(),
          scope: "workspace",
          source,
          expectedVersion: 0,
          settings: { knowledge: "review_first" },
        }),
        "42501",
      );
      await saveAgentLearningSettings(client.db, f.human, {
        operationId: crypto.randomUUID(),
        scope: "personal",
        source,
        expectedVersion: 0,
        settings: { knowledge: "review_first" },
      });
      expect(await getAgentLearningSettings(client.db, f.human, "context", source)).toMatchObject({
        ownerKey: `personal:${f.subjectId}`,
        settings: { knowledge: "review_first" },
      });
      await fails(
        getAgentLearningSettings(
          client.db,
          {
            ...f.human,
            actor: { ...f.human.actor, subjectId: "user:another-manager" },
          },
          "context",
          source,
        ),
        "42501",
      );
    }
    expect(
      await getAgentLearningSettings(client.db, f.human, "context", {
        kind: "chat",
        id: sharedSession.id,
      }),
    ).toMatchObject({ ownerKey: `workspace:${f.workspaceId}` });
    await fails(
      saveAgentLearningSettings(client.db, f.human, {
        operationId: crypto.randomUUID(),
        scope: "personal",
        source: { kind: "chat", id: sharedSession.id },
        expectedVersion: 0,
        settings: { knowledge: "off" },
      }),
      "42501",
    );
    expect(await listAgentLearningOverrides(client.db, f.human, "workspace")).toEqual([]);
    expect(await listAgentLearningOverrides(client.db, f.human, "personal")).toHaveLength(2);
  });

  test("a context override changes future accepted work and Off still permits retrieval and human edits", async () => {
    const f = await fixture();
    const { agent, session } = await attempt(f, "review_first");
    await save(agent, "Freeze the accepted turn policy");
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "workspace",
      source: { kind: "chat", id: session.id },
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      settings: { knowledge: "automatic" },
    });
    expect((await save(agent, "Same accepted turn")).outcome).toBe("pending");
    const defaults = await getAgentLearningSettings(client.db, f.human, "workspace");
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: defaults.version,
      settings: { knowledge: "off", instructions: "review_first", skills: "off" },
    });
    expect((await save(f.human, "Human edits remain available")).outcome).toBe("published");
  });

  test("archive proposals are nonblocking and retain the published entry until review", async () => {
    const f = await fixture();
    const original = await save(f.human, "Incident resolution");
    const { agent, session } = await attempt(f, "review_first");
    const pending = await archiveKnowledgeEntry(client.db, agent, {
      operationId: crypto.randomUUID(),
      entryId: original.entryId,
      expectedVersion: 1,
    });
    expect(pending.outcome).toBe("pending");
    expect(
      (await getKnowledgeEntry(client.db, f.human, original.entryId))?.revision.entry.content,
    ).toBe("Incident resolution");
    expect(
      (await getKnowledgeEntry(client.db, f.human, original.entryId, { view: "needs_review" }))
        ?.revision.change,
    ).toBe("archive");
    expect(
      (await shared!.admin`SELECT status FROM sessions WHERE id=${session.id}`)[0]?.status,
    ).toBe("running");
    expect(
      (
        await reviewKnowledgeEntry(client.db, f.human, {
          operationId: crypto.randomUUID(),
          entryId: original.entryId,
          revisionId: pending.revisionId,
          expectedVersion: 2,
          decision: "approve",
        })
      ).outcome,
    ).toBe("archived");
    expect(await getKnowledgeEntry(client.db, f.human, original.entryId)).toBeNull();
  });

  test("native Skills use the same accepted context policy and remain editable by humans when Off", async () => {
    const f = await fixture();
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "automatic", instructions: "review_first", skills: "automatic" },
    });
    const { agent } = await attempt(f);
    const request = {
      operation: "save",
      operationId: crypto.randomUUID(),
      skillId: crypto.randomUUID(),
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      stableKey: `test-${crypto.randomUUID()}`,
      reason: "Retain the debugging workflow",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: incident-diagnosis\ndescription: Diagnose Acme incidents.\n---\nCheck the service logs and compare the deployment revision.\n",
        },
      ],
    };
    expect((await applySkillLifecycle(client.db, agent, request)).outcome).toBe("applied");
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      settings: { knowledge: "automatic", instructions: "review_first", skills: "off" },
    });
    const next = await attempt(f);
    await fails(
      applySkillLifecycle(client.db, next.agent, {
        ...request,
        operationId: crypto.randomUUID(),
        skillId: crypto.randomUUID(),
      }),
      "42501",
    );
    expect(
      (
        await applySkillLifecycle(client.db, f.human, {
          ...request,
          operationId: crypto.randomUUID(),
          skillId: crypto.randomUUID(),
          stableKey: `human-${crypto.randomUUID()}`,
        })
      ).outcome,
    ).toBe("applied");
  });

  test("one review approves linked sources before findings and supports an edited approval", async () => {
    const f = await fixture();
    const { agent } = await attempt(f, "review_first");
    const group = await saveKnowledgeEntry(client.db, agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: { title: "Acme", kind: "group", content: "Customer account" },
    });
    const source = await saveKnowledgeEntry(client.db, agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        title: "Acme Slack update",
        kind: "source",
        content: "Renewal is 15 December",
        source: { kind: "slack", uri: "https://example.test/slack/1" },
        groupIds: [group.entryId],
      },
    });
    const finding = await saveKnowledgeEntry(client.db, agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        title: "Renewal",
        kind: "fact",
        content: "Renews 1 December",
        groupIds: [group.entryId],
        evidence: [{ entryId: source.entryId, revisionId: source.revisionId }],
      },
    });
    const entries = [finding, source, group].map((receipt) => ({
      operationId: crypto.randomUUID(),
      entryId: receipt.entryId,
      revisionId: receipt.revisionId,
      expectedVersion: 1,
      decision: "approve" as const,
    }));
    const request = {
      entries: entries.map((entry) =>
        entry.entryId === finding.entryId
          ? {
              ...entry,
              entry: {
                title: "Renewal",
                kind: "fact" as const,
                content: "Renews 15 December",
                groupIds: [group.entryId],
                evidence: [{ entryId: source.entryId, revisionId: source.revisionId }],
              },
            }
          : entry,
      ),
    };
    expect(
      (await reviewKnowledgeEntries(client.db, f.human, request)).receipts.map(
        (receipt) => receipt.entryId,
      ),
    ).toEqual([group.entryId, source.entryId, finding.entryId]);
    expect(
      (await getKnowledgeEntry(client.db, agent, finding.entryId))?.revision.entry.content,
    ).toBe("Renews 15 December");
    expect(
      (await reviewKnowledgeEntries(client.db, f.human, request)).receipts.every(
        (receipt) => receipt.replayed,
      ),
    ).toBe(true);
  });

  test("instruction saves retain native heads and use nonblocking review from the same settings", async () => {
    const f = await fixture();
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "automatic", instructions: "automatic", skills: "review_first" },
    });
    const first = await attempt(f);
    expect(
      await getAgentInstruction(client.db, first.agent, {
        kind: "policy",
        scope: "global",
        roleKey: null,
      }),
    ).toMatchObject({
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      content: null,
    });
    const published = await saveAgentInstruction(client.db, first.agent, {
      operationId: crypto.randomUUID(),
      target: { kind: "policy", scope: "global", roleKey: null },
      content: "Include the contract currency when reporting a renewal amount.",
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Avoid ambiguous amounts",
    });
    expect(published.outcome).toBe("published");
    expect(
      await getAgentInstruction(client.db, first.agent, {
        kind: "policy",
        scope: "global",
        roleKey: null,
      }),
    ).toMatchObject({
      expectedCurrentRevisionId: published.revisionId,
      expectedActivationVersion: 1,
      content: "Include the contract currency when reporting a renewal amount.",
    });
    await saveAgentLearningSettings(client.db, f.human, {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      settings: { knowledge: "automatic", instructions: "review_first", skills: "review_first" },
    });
    const second = await attempt(f);
    const pending = await saveAgentInstruction(client.db, second.agent, {
      operationId: crypto.randomUUID(),
      target: { kind: "policy", scope: "global", roleKey: null },
      content: "Include currency and applicable tax when reporting renewal amounts.",
      expectedCurrentRevisionId: published.revisionId,
      expectedActivationVersion: 1,
      reason: "Clarify tax treatment",
    });
    expect(pending.outcome).toBe("pending");
    expect(
      (
        await shared!
          .admin`SELECT revision_id FROM workspace_instruction_policy_heads WHERE workspace_id=${f.workspaceId}`
      )[0]?.revision_id,
    ).toBe(published.revisionId);
    expect(
      (await listAgentInstructionReviews(client.db, f.human)).entries.map(
        (entry) => entry.revisionId,
      ),
    ).toEqual([pending.revisionId]);
    await fails(
      reviewAgentInstruction(client.db, second.agent, {
        operationId: crypto.randomUUID(),
        revisionId: pending.revisionId,
        decision: "approve",
        reason: "Self-approval is forbidden",
      }),
      "42501",
    );
    expect(
      (
        await reviewAgentInstruction(client.db, f.human, {
          operationId: crypto.randomUUID(),
          revisionId: pending.revisionId,
          decision: "approve",
          reason: "Reviewed",
        })
      ).outcome,
    ).toBe("published");
    expect(
      (
        await shared!
          .admin`SELECT revision_id FROM workspace_instruction_policy_heads WHERE workspace_id=${f.workspaceId}`
      )[0]?.revision_id,
    ).toBe(pending.revisionId);
    expect((await listAgentInstructionReviews(client.db, f.human)).entries).toEqual([]);
  });

  test("an ordinary PDF attachment is parsed into one searchable source under its task policy", async () => {
    const f = await fixture();
    const { agent } = await attempt(f);
    const fileId = crypto.randomUUID();
    const bytes = knowledgeContractPdf();
    await shared!
      .admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
      VALUES(${fileId},${f.accountId},${f.workspaceId},'ready','Acme-contract.pdf','Acme-contract.pdf','application/pdf',${bytes.length},'test',${fileId})`;
    let reads = 0;
    const deps = {
      db: client.db,
      objectStorage: {
        getObjectBytes: async (key: string) => {
          expect(key).toBe(fileId);
          reads++;
          return { bytes, contentType: "application/pdf" };
        },
      } as ObjectStorage,
      getDocumentServices: () =>
        ({ parser: { name: "real-pdf-parser", parse: parseDocumentBytes } }) as DocumentServices,
    };
    const prepared = await prepareKnowledgeFile(deps, agent, fileId);
    if (prepared.status !== "retained") throw new Error("Expected a retained source");
    expect(prepared.receipt.outcome).toBe("published");
    const source = await getKnowledgeEntry(client.db, f.human, prepared.receipt.entryId);
    expect(source?.revision.entry.content).toContain("Renewal date: 1 December 2026.");
    expect(source?.revision.entry.source?.fileId).toBe(fileId);
    const retained = await prepareKnowledgeFile(deps, agent, fileId);
    expect(retained.status).toBe("retained");
    expect(reads).toBe(1);
    const records = await listKnowledgeEntries(client.db, f.human, { limit: 20 });
    expect(records.entries.map((entry) => entry.revision.kind)).toEqual(["source"]);
  }, 120_000);

  test("file preparation converges across tasks and keeps pending/rejected sources unpublished", async () => {
    const f = await fixture();
    const first = await attempt(f, "review_first");
    const fileId = crypto.randomUUID();
    await shared!
      .admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
      VALUES(${fileId},${f.accountId},${f.workspaceId},'ready','Acme.pdf','Acme.pdf','application/pdf',50,'test',${fileId})`;
    expect((await inspectKnowledgeFilePreparation(client.db, first.agent, fileId)).status).toBe(
      "prepare",
    );
    const content = "Acme renewal terms\nEUR 20,000.\u0000Exact retained text.";
    const request = { fileId, title: "Acme.pdf", content };
    const results = await Promise.all([
      completeKnowledgeFilePreparation(client.db, first.agent, request),
      completeKnowledgeFilePreparation(client.db, first.agent, request),
    ]);
    const retained = results[0]!;
    if (retained.status !== "retained" || results[1]!.status !== "retained")
      throw new Error("Expected retained source");
    const receipt = retained.receipt;
    expect(results[1]!.receipt.entryId).toBe(receipt.entryId);
    expect(receipt.outcome).toBe("pending");
    expect(await getKnowledgeEntry(client.db, first.agent, receipt.entryId)).toBeNull();
    expect(
      (await getKnowledgeEntry(client.db, f.human, receipt.entryId, { view: "needs_review" }))
        ?.revision.entry.content,
    ).toBe(content);
    const automatic = await attempt(f);
    const reread = await inspectKnowledgeFilePreparation(client.db, automatic.agent, fileId);
    expect(reread.status === "retained" && reread.receipt.outcome).toBe("pending");
    await reviewKnowledgeEntry(client.db, f.human, {
      operationId: crypto.randomUUID(),
      entryId: receipt.entryId,
      revisionId: receipt.revisionId,
      expectedVersion: receipt.version,
      decision: "reject",
    });
    const rejected = await completeKnowledgeFilePreparation(client.db, automatic.agent, request);
    expect(rejected.status === "retained" && rejected.receipt.outcome).toBe("rejected");
    expect(
      (await listKnowledgeEntries(client.db, automatic.agent, { query: "Acme" })).entries,
    ).toEqual([]);
    const other = await fixture();
    const otherAgent = await attempt(other);
    await fails(inspectKnowledgeFilePreparation(client.db, otherAgent.agent, fileId), "42501");
  });

  test("later review-first tasks can reference an already pending source without duplicating it", async () => {
    const f = await fixture();
    const first = await attempt(f, "review_first");
    const source = await saveKnowledgeEntry(client.db, first.agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        kind: "source",
        title: "Slack update",
        content: "Billing API supports Acme",
        source: { kind: "slack", externalId: "channel:message" },
      },
    });
    const later = await attempt(f, "review_first");
    const finding = await saveKnowledgeEntry(client.db, later.agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        kind: "fact",
        title: "Acme support",
        content: "Billing API supports Acme",
        evidence: [{ entryId: source.entryId, revisionId: source.revisionId }],
      },
    });
    expect(finding.reviewBatchId).not.toBe(source.reviewBatchId);
    expect(finding.outcome).toBe("pending");
    await fails(
      reviewKnowledgeEntry(client.db, f.human, {
        operationId: crypto.randomUUID(),
        entryId: finding.entryId,
        revisionId: finding.revisionId,
        expectedVersion: finding.version,
        decision: "approve",
      }),
      "42501",
    );
    await reviewKnowledgeEntries(client.db, f.human, {
      entries: [finding, source].map((receipt) => ({
        operationId: crypto.randomUUID(),
        entryId: receipt.entryId,
        revisionId: receipt.revisionId,
        expectedVersion: receipt.version,
        decision: "approve" as const,
      })),
    });
    expect(
      (await getKnowledgeEntry(client.db, later.agent, finding.entryId))?.revision.outcome,
    ).toBe("published");
  });

  test("automatically prepared source text is searchable and keeps findings separate", async () => {
    const f = await fixture();
    const { agent } = await attempt(f);
    const fileId = crypto.randomUUID();
    await shared!
      .admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
      VALUES(${fileId},${f.accountId},${f.workspaceId},'ready','Acme.pdf','Acme.pdf','application/pdf',50,'test',${fileId})`;
    const saved = await completeKnowledgeFilePreparation(client.db, agent, {
      fileId,
      title: "Acme.pdf",
      content: "Acme renewal occurs in December.",
    });
    if (saved.status !== "retained") throw new Error("Expected retained source");
    expect(
      (await listKnowledgeEntries(client.db, agent, { query: "December" })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([saved.receipt.entryId]);
    expect(
      (await getKnowledgeEntry(client.db, agent, saved.receipt.entryId))?.revision.entry.kind,
    ).toBe("source");
    const finding = await saveKnowledgeEntry(client.db, agent, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: {
        title: "Acme renewal month",
        kind: "fact",
        content: "December",
        evidence: [{ entryId: saved.receipt.entryId, revisionId: saved.receipt.revisionId }],
      },
    });
    expect(
      (await listKnowledgeEntries(client.db, agent, { kind: "fact" })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([finding.entryId]);
    await save(agent, "An unrelated retained finding");
    expect(
      (await listKnowledgeEntries(client.db, agent, { fileId })).entries
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([saved.receipt.entryId, finding.entryId].sort());
    await shared!.admin`UPDATE files SET status='failed' WHERE id=${fileId}`;
    expect(await getKnowledgeEntry(client.db, agent, finding.entryId)).toBeNull();
  });

  test("task-note promotion retains exact text once and cannot read another task tree", async () => {
    const f = await fixture();
    const { agent } = await attempt(f);
    if (agent.actor.kind !== "agent") throw new Error("Expected agent fixture");
    const claims = { accountId: f.accountId, workspaceId: f.workspaceId, ...agent.actor };
    const text =
      "The import failed because the upstream field was renamed.\nKeep the original event ID with the fix.";
    const { note } = await createTaskNote(client.db, {
      ...claims,
      operationId: crypto.randomUUID(),
      kind: "finding",
      text,
      expiresInDays: 1,
    });
    const request = {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0 as const,
      noteId: note.id,
      expectedNoteVersion: 1 as const,
      title: "Import incident",
    };
    const saved = await promoteTaskNoteToKnowledge(client.db, agent, request);
    expect((await getKnowledgeEntry(client.db, agent, saved.entryId))?.revision.entry.content).toBe(
      text,
    );
    await archiveTaskNote(client.db, {
      ...claims,
      operationId: crypto.randomUUID(),
      noteId: note.id,
      expectedVersion: 1,
      reason: "Task complete",
    });
    expect((await promoteTaskNoteToKnowledge(client.db, agent, request)).replayed).toBe(true);
    const other = await attempt(f);
    await fails(
      promoteTaskNoteToKnowledge(client.db, other.agent, {
        ...request,
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
      }),
      "42501",
    );
  });
});
