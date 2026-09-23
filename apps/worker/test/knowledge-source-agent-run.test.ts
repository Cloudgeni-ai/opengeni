import { afterAll, beforeAll, expect, test } from "bun:test";
import { knowledgeSourceAgentConfig, type KnowledgeSourceSyncAction } from "@opengeni/contracts";
import {
  createDb,
  createScheduledTask,
  claimSessionWorkForAttempt,
  getScheduledTaskRunAcceptedExecution,
  freezeAgentLearningPolicy,
  getSessionAuthorityProjection,
  listScheduledTaskRuns,
  withSessionRlsActorContext,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import { createKnowledgeSourceAttemptTools } from "../src/activities/agent-turn/knowledge-source-tools";
import type { ActivityServices, RunKnowledgeSourceSyncBatchInput } from "../src/activities/types";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("knowledge-source-agent-run");
  if (!db) throw new Error("PostgreSQL is required");
  shared = db;
  client = createDb(db.appUrl);
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

for (const personal of [false, true])
  test(`source selection runs in an ordinary ${personal ? "private" : "shared"} agent session`, async () => {
    const subjectId = `user:${crypto.randomUUID()}`;
    const [account] =
      await shared.admin`INSERT INTO managed_accounts(name) VALUES('Source agent test') RETURNING id`;
    const [workspace] =
      await shared.admin`INSERT INTO workspaces(account_id,name) VALUES(${account!.id},'Sources') RETURNING id`;
    const accountId = account!.id as string,
      workspaceId = workspace!.id as string;
    await shared.admin`INSERT INTO workspace_inference_controls(account_id,workspace_id) VALUES(${accountId},${workspaceId})`;
    const [personalWorkspace] =
      await shared.admin`INSERT INTO workspaces(account_id,name) VALUES(${accountId},'Personal') RETURNING id`;
    await shared.admin`INSERT INTO organization_memberships(account_id,subject_id,status,personal_workspace_id)
    VALUES(${accountId},${subjectId},'active',${personalWorkspace!.id})`;
    await shared.admin`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,permissions)
    VALUES(${accountId},${workspaceId},${subjectId},'["*"]')`;
    await shared.admin`INSERT INTO session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by)
    VALUES(${accountId},1,${"0".repeat(64)},${"1".repeat(64)},'database-test')`;
    await shared.admin`INSERT INTO organization_private_session_settings(account_id,enabled,version,updated_by_membership_id)
    VALUES(${accountId},true,1,null)`;
    const source: KnowledgeSourceSyncAction = {
      kind: "knowledge_source_sync",
      sourceId: crypto.randomUUID(),
      sourceGeneration: 0,
      sourceLifecycleGeneration: 1,
      sourceConfigGeneration: 1,
      controlWorkspaceId: workspaceId,
      providerCoordinationKey: "test:drive",
      initiatingSubjectId: subjectId,
      allDescendants: true,
      connection: {
        connectionId: crypto.randomUUID(),
        connectionVersion: 1,
        providerDomain: "drive.google.com",
        kind: "oauth2",
        ownerSubjectId: subjectId,
      },
      destination: personal
        ? { kind: "personal", workspaceId, subjectId }
        : { kind: "workspace", workspaceId, subjectId: null },
      limits: {
        maxItems: 20,
        maxBytes: 10000,
        maxFileBytes: 10000,
        maxProviderRequests: 20,
        maxElapsedSeconds: 30,
        maxConcurrency: 1,
        maxFailureDetails: 5,
      },
    };
    const task = await createScheduledTask(client.db, {
      accountId,
      workspaceId,
      createdBy: { kind: "subject", subjectId },
      name: "Read selected source",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `test-source-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      action: { kind: "agent_turn" },
      agentConfig: knowledgeSourceAgentConfig(source),
      metadata: {},
    });
    const activities = createScheduledTaskActivities(
      async () =>
        ({
          settings: testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" }),
          db: client.db,
          bus: new MemoryEventBus(),
        }) as unknown as ActivityServices,
    );
    const result = await activities.dispatchScheduledTaskRun({
      workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `source-${crypto.randomUUID()}`,
    });
    if (result.action !== "start")
      throw new Error(
        JSON.stringify({
          result,
          runs: await listScheduledTaskRuns(client.db, workspaceId, task.id),
        }),
      );
    const [run] = await listScheduledTaskRuns(client.db, workspaceId, task.id);
    if (!run) throw new Error("Scheduled run missing");
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId,
      runId: run.id,
    });
    expect(accepted?.task.action.kind).toBe("agent_turn");
    expect(accepted?.task.agentConfig.knowledgeSource).toEqual(source);
    expect(accepted?.causalHumanSubjectId).toBe(subjectId);
    const authority = await withSessionRlsActorContext({ subjectId }, () =>
      getSessionAuthorityProjection(client.db, workspaceId, result.sessionId),
    );
    expect(authority?.visibility).toBe(personal ? "user_private" : "workspace_shared");
    if (personal) expect(authority?.ownerSubjectId).toBe(subjectId);
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: result.sessionId,
      attemptId,
      workflowId: result.workflowId,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("Expected accepted source turn");
    const context: KnowledgeContext = {
      accountId,
      workspaceId,
      actor: {
        kind: "agent",
        sessionId: result.sessionId,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
      },
    };
    const policy = await freezeAgentLearningPolicy(client.db, context);
    expect(policy.scheduledTaskRunId).toBe(run.id);
    expect(policy.defaultScope).toBe(personal ? "personal" : "workspace");
    let invoked: RunKnowledgeSourceSyncBatchInput | undefined;
    const tools = await createKnowledgeSourceAttemptTools({
      db: client.db,
      context,
      fetch: async (input) => {
        invoked = input;
        return { action: "complete", bufferedWake: false };
      },
    });
    expect(tools.map((tool) => tool.modelName)).toEqual([
      "knowledge_source_fetch",
      "knowledge_source_read",
    ]);
    await tools[0]!.execute({});
    expect(invoked).toMatchObject({
      taskId: task.id,
      sourceId: source.sourceId,
      scheduledTaskRunId: run.id,
      agent: context.actor,
    });
  }, 90_000);
