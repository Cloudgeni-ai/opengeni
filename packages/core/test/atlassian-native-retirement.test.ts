import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  type AccessGrant,
  type KnowledgeSourceSyncAction,
} from "@opengeni/contracts";
import { ATLASSIAN_NATIVE_RETIRED_MESSAGE } from "@opengeni/contracts/atlassian-native-retirement";
import { bootstrapWorkspace, createDb } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createValidatedScheduledTask } from "../src/domain/scheduled-tasks";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let grant: AccessGrant;
beforeAll(async () => {
  const value = await acquireSharedTestDatabase("atlassian-native-retirement");
  if (!value) throw new Error("Atlassian retirement requires real PostgreSQL");
  shared = value;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "atlassian-retirement",
    accountExternalId: crypto.randomUUID(),
    accountName: "Retirement",
    workspaceExternalSource: "atlassian-retirement",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Retirement",
    subjectId: `user:${crypto.randomUUID()}`,
  });
  grant = access.workspaceGrants[0]!;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("new native Atlassian source schedules refuse before any database effect or downstream setup", async () => {
  const { workspaceId, subjectId } = grant;
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

  const payload = CreateScheduledTaskRequest.parse({
    name: "Native Jira source",
    status: "active",
    schedule: { type: "manual" },
    runMode: "new_session_per_run",
    overlapPolicy: "buffer_one",
    action: { kind: "agent_turn" },
    agentConfig: {
      prompt: "Fetch source",
      model: "forbidden-model",
      resources: [],
      tools: [],
      metadata: {},
      knowledgeSource: source,
    },
  });
  // Retired source validation is the first check: it rejects before the
  // model guard, the Personal-workspace gate or any other database use.
  let databaseAccesses = 0;
  const database = new Proxy(client.db, {
    get() {
      databaseAccesses += 1;
      throw new Error("Unexpected database effect before retired source refusal");
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
  ).rejects.toMatchObject({ status: 410, message: ATLASSIAN_NATIVE_RETIRED_MESSAGE });
  expect(databaseAccesses).toBe(0);
});
