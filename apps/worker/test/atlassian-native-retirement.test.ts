import { expect, spyOn, test } from "bun:test";
import {
  knowledgeSourceAgentConfig,
  ScheduledTask,
  type KnowledgeSourceSyncAction,
  type ScheduledTaskRunAcceptedExecution,
} from "@opengeni/contracts";
import { ATLASSIAN_NATIVE_RETIRED_REASON } from "@opengeni/contracts/atlassian-native-retirement";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import { createKnowledgeSourceSyncActivities } from "../src/activities/knowledge-source-sync";
import { createKnowledgeSourceAttemptTools } from "../src/activities/agent-turn/knowledge-source-tools";
import type { ControlActivityServices } from "../src/activities/types";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const subjectId = "user:historical-owner";
const source: KnowledgeSourceSyncAction = {
  kind: "knowledge_source_sync",
  sourceId: "55555555-5555-4555-8555-555555555555",
  sourceGeneration: 0,
  sourceLifecycleGeneration: 1,
  sourceConfigGeneration: 1,
  controlWorkspaceId: workspaceId,
  providerCoordinationKey: "atlassian:cloud:project",
  initiatingSubjectId: subjectId,
  allDescendants: true,
  connection: {
    connectionId: "66666666-6666-4666-8666-666666666666",
    connectionVersion: 1,
    providerDomain: "api.atlassian.com",
    kind: "oauth2",
    ownerSubjectId: subjectId,
  },
  destination: { kind: "workspace", workspaceId, subjectId: null },
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
const task = ScheduledTask.parse({
  id: taskId,
  accountId,
  workspaceId,
  name: "Historical Jira sync",
  status: "active",
  ownerSubjectId: subjectId,
  schedule: { type: "manual" },
  temporalScheduleId: "old-native-task",
  runMode: "new_session_per_run",
  overlapPolicy: "buffer_one",
  action: { kind: "agent_turn" },
  agentConfig: knowledgeSourceAgentConfig(source),
  executionDigest: "a".repeat(64),
  targetSessionId: null,
  reusableSessionId: null,
  metadata: {},
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});
const accepted = { task, causalHumanSubjectId: subjectId } as ScheduledTaskRunAcceptedExecution;
// Unexpected reads, writes and network requests fail rather than silently
// succeeding, so these tests pin the retirement boundary before execution.
const database = new Proxy(
  {},
  {
    get() {
      throw new Error("Unexpected database effect");
    },
  },
) as db.Database;
const services = async () =>
  ({ db: database, settings: testSettings(), objectStorage: {} }) as ControlActivityServices;
const dispatchInput = {
  workspaceId,
  taskId,
  triggerType: "scheduled" as const,
  producerKey: "old-fire",
};

test("future native source fires stop before run admission or model/session creation", async () => {
  const prior = spyOn(db, "getScheduledTaskRunByProducerKey").mockResolvedValue(null);
  const taskRead = spyOn(db, "getScheduledTask");
  try {
    const activities = createScheduledTaskActivities(services);
    for (const historicalTask of [task, { ...task, action: source } as ScheduledTask]) {
      taskRead.mockResolvedValue(historicalTask);
      expect(await activities.dispatchScheduledTaskRun(dispatchInput)).toEqual({
        action: "blocked",
        reason: ATLASSIAN_NATIVE_RETIRED_REASON,
      });
    }
  } finally {
    prior.mockRestore();
    taskRead.mockRestore();
  }
});

test("a queued native run settles failed once rather than recovering a new session", async () => {
  const prior = spyOn(db, "getScheduledTaskRunByProducerKey").mockResolvedValue({
    id: runId,
    workspaceId,
    taskId,
    actionKind: "agent_turn",
    status: "queued",
  } as Awaited<ReturnType<typeof db.getScheduledTaskRunByProducerKey>>);
  const snapshot = spyOn(db, "getScheduledTaskRunAcceptedExecution").mockResolvedValue(accepted);
  const settle = spyOn(db, "markScheduledTaskRunFailedIfQueued").mockResolvedValue(undefined);
  try {
    expect(
      await createScheduledTaskActivities(services).dispatchScheduledTaskRun(dispatchInput),
    ).toEqual({
      action: "blocked",
      reason: ATLASSIAN_NATIVE_RETIRED_REASON,
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(
      database,
      workspaceId,
      runId,
      ATLASSIAN_NATIVE_RETIRED_REASON,
    );
  } finally {
    prior.mockRestore();
    snapshot.mockRestore();
    settle.mockRestore();
  }
});

test("already accepted native source attempts cannot advertise or fetch native content", async () => {
  const agent: Extract<db.KnowledgeActor, { kind: "agent" }> = {
    kind: "agent",
    sessionId: "77777777-7777-4777-8777-777777777777",
    turnId: "88888888-8888-4888-8888-888888888888",
    attemptId: "99999999-9999-4999-8999-999999999999",
    executionGeneration: 1,
  };
  const policy = spyOn(db, "freezeAgentLearningPolicy").mockResolvedValue({
    scheduledTaskRunId: runId,
  } as Awaited<ReturnType<typeof db.freezeAgentLearningPolicy>>);
  const snapshot = spyOn(db, "getScheduledTaskRunAcceptedExecution").mockResolvedValue(accepted);
  const taskRead = spyOn(db, "getScheduledTask").mockResolvedValue(task);
  const provider = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected provider call");
  });
  try {
    const result = await createKnowledgeSourceSyncActivities(services).runKnowledgeSourceSyncBatch({
      accountId,
      workspaceId,
      taskId,
      scheduledTaskRunId: runId,
      sourceId: source.sourceId,
      overlapPolicy: "buffer_one",
      agent,
    });
    expect(result).toEqual({
      action: "failed",
      bufferedWake: false,
      errorCode: ATLASSIAN_NATIVE_RETIRED_REASON,
    });
    expect(
      await createKnowledgeSourceAttemptTools({
        db: database,
        context: { accountId, workspaceId, actor: agent },
        fetch: async () => {
          throw new Error("Unexpected source fetch");
        },
      }),
    ).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  } finally {
    policy.mockRestore();
    snapshot.mockRestore();
    taskRead.mockRestore();
    provider.mockRestore();
  }
});
