import { expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  type AccessGrant,
  type KnowledgeSourceSyncAction,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createValidatedScheduledTask } from "../src/domain/scheduled-tasks";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const subjectId = "user:owner";
const source: KnowledgeSourceSyncAction = {
  kind: "knowledge_source_sync",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceGeneration: 0,
  sourceLifecycleGeneration: 1,
  sourceConfigGeneration: 1,
  controlWorkspaceId: workspaceId,
  providerCoordinationKey: "atlassian:cloud:project",
  initiatingSubjectId: subjectId,
  allDescendants: true,
  connection: {
    connectionId: "33333333-3333-4333-8333-333333333333",
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

test("new native Atlassian source schedules refuse before database or model setup", async () => {
  const payload = CreateScheduledTaskRequest.parse({
    name: "Native Jira source",
    status: "active",
    schedule: { type: "manual" },
    runMode: "new_session_per_run",
    overlapPolicy: "buffer_one",
    action: { kind: "agent_turn" },
    agentConfig: {
      prompt: "Fetch source",
      resources: [],
      tools: [],
      metadata: {},
      knowledgeSource: source,
    },
  });
  const database = new Proxy(
    {},
    {
      get() {
        throw new Error("Unexpected database effect");
      },
    },
  ) as Database;
  await expect(
    createValidatedScheduledTask({
      settings: testSettings(),
      db: database,
      objectStorage: null,
      grant: {
        accountId: "44444444-4444-4444-8444-444444444444",
        workspaceId,
        subjectId,
        permissions: ["*"],
      } as AccessGrant,
      payload,
    }),
  ).rejects.toMatchObject({ status: 410 });
});
