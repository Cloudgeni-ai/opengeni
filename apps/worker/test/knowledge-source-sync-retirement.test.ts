import { describe, expect, spyOn, test } from "bun:test";
import {
  knowledgeSourceAgentConfig,
  ScheduledTask,
  type KnowledgeSourceSyncAction,
  type ScheduledTaskRunAcceptedExecution,
} from "@opengeni/contracts";
import { ATLASSIAN_NATIVE_RETIRED_REASON } from "@opengeni/contracts/atlassian-native-retirement";
import { GOOGLE_DRIVE_NATIVE_RETIRED_REASON } from "@opengeni/contracts/google-drive-native-retirement";
import { KNOWLEDGE_SOURCE_SYNC_RETIRED_REASON } from "@opengeni/contracts/knowledge-source-sync-retirement";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ControlActivityServices } from "../src/activities/types";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const subjectId = "user:historical-owner";

function source(providerDomain: string): KnowledgeSourceSyncAction {
  return {
    kind: "knowledge_source_sync",
    sourceId: "55555555-5555-4555-8555-555555555555",
    sourceGeneration: 0,
    sourceLifecycleGeneration: 1,
    sourceConfigGeneration: 1,
    controlWorkspaceId: workspaceId,
    providerCoordinationKey: `${providerDomain}:folder`,
    initiatingSubjectId: subjectId,
    allDescendants: true,
    connection: {
      connectionId: "66666666-6666-4666-8666-666666666666",
      connectionVersion: 1,
      providerDomain,
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
}

function historicalTask(action: KnowledgeSourceSyncAction): ScheduledTask {
  return ScheduledTask.parse({
    id: taskId,
    accountId,
    workspaceId,
    name: "Historical source sync",
    status: "active",
    ownerSubjectId: subjectId,
    schedule: { type: "manual" },
    temporalScheduleId: "old-source-task",
    runMode: "new_session_per_run",
    overlapPolicy: "buffer_one",
    action: { kind: "agent_turn" },
    agentConfig: knowledgeSourceAgentConfig(action),
    executionDigest: "a".repeat(64),
    targetSessionId: null,
    reusableSessionId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
}

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

describe.each([
  ["Google Drive", "googleapis.com", GOOGLE_DRIVE_NATIVE_RETIRED_REASON],
  ["Atlassian", "api.atlassian.com", ATLASSIAN_NATIVE_RETIRED_REASON],
  ["OneDrive", "graph.microsoft.com", KNOWLEDGE_SOURCE_SYNC_RETIRED_REASON],
] as const)("retired %s Knowledge sync", (_name, providerDomain, reason) => {
  const action = source(providerDomain);
  const task = historicalTask(action);

  test("future fires stop before run admission or model/session creation", async () => {
    const prior = spyOn(db, "getScheduledTaskRunByProducerKey").mockResolvedValue(null);
    const taskRead = spyOn(db, "getScheduledTask");
    try {
      const activities = createScheduledTaskActivities(services);
      // Both the agent-task shape and the frozen historical action shape.
      for (const saved of [task, { ...task, action } as ScheduledTask]) {
        for (const status of ["active", "paused"] as const) {
          taskRead.mockResolvedValue({ ...saved, status });
          expect(await activities.dispatchScheduledTaskRun(dispatchInput)).toEqual({
            action: "blocked",
            reason,
          });
        }
      }
    } finally {
      prior.mockRestore();
      taskRead.mockRestore();
    }
  });

  test("a queued run settles failed once rather than recovering a new session", async () => {
    const prior = spyOn(db, "getScheduledTaskRunByProducerKey").mockResolvedValue({
      id: runId,
      workspaceId,
      taskId,
      actionKind: "agent_turn",
      status: "queued",
    } as Awaited<ReturnType<typeof db.getScheduledTaskRunByProducerKey>>);
    const snapshot = spyOn(db, "getScheduledTaskRunAcceptedExecution").mockResolvedValue({
      task,
      causalHumanSubjectId: subjectId,
    } as ScheduledTaskRunAcceptedExecution);
    const settle = spyOn(db, "markScheduledTaskRunFailedIfQueued").mockResolvedValue(undefined);
    try {
      expect(
        await createScheduledTaskActivities(services).dispatchScheduledTaskRun(dispatchInput),
      ).toEqual({ action: "blocked", reason });
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(database, workspaceId, runId, reason);
    } finally {
      prior.mockRestore();
      snapshot.mockRestore();
      settle.mockRestore();
    }
  });
});
