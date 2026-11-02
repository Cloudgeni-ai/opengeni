import { expect, test } from "bun:test";
import { CreateScheduledTaskRequest, type AccessGrant } from "@opengeni/contracts";
import { KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE } from "@opengeni/contracts/knowledge-source-sync-retirement";
import { testSettings } from "@opengeni/testing/settings";
import { createValidatedScheduledTask } from "../src/domain/scheduled-tasks";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const subjectId = "user:removed-sync";
const grant: AccessGrant = {
  accountId: "44444444-4444-4444-8444-444444444444",
  workspaceId,
  subjectId,
  permissions: ["scheduled_tasks:manage"],
  principalKind: "human_session",
};

test("a schedule that still asks for a Knowledge source answers 410 before any database effect", async () => {
  const payload = CreateScheduledTaskRequest.parse({
    name: "Source sync",
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
      knowledgeSource: {
        kind: "knowledge_source_sync",
        sourceId: "22222222-2222-4222-8222-222222222222",
        sourceGeneration: 0,
        sourceLifecycleGeneration: 1,
        sourceConfigGeneration: 1,
        controlWorkspaceId: workspaceId,
        providerCoordinationKey: "googleapis.com:source",
        initiatingSubjectId: subjectId,
        allDescendants: true,
        connection: {
          connectionId: "33333333-3333-4333-8333-333333333333",
          connectionVersion: 1,
          providerDomain: "googleapis.com",
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
      },
    },
  });
  let databaseAccesses = 0;
  const database = new Proxy({} as Parameters<typeof createValidatedScheduledTask>[0]["db"], {
    get() {
      databaseAccesses += 1;
      throw new Error("Unexpected database effect before the removed-feature refusal");
    },
  });
  await expect(
    createValidatedScheduledTask({
      settings: testSettings(),
      db: database,
      objectStorage: null,
      grant,
      payload,
    }),
  ).rejects.toMatchObject({ status: 410, message: KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE });
  expect(databaseAccesses).toBe(0);
});
