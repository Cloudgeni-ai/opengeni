import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  enqueueSessionTurn,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { postUserMessageTurn } from "../src/domain/sessions";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-inherited-policy");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("follow-up gate and accepted turn retain one frozen policy when a different turn starts after preflight", async () => {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Policy inheritance",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Policy inheritance",
    subjectId: id,
  });
  const owner = access.workspaceGrants[0]!;
  const workspaceId = owner.workspaceId!;
  const settings = testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" });
  const session = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId,
    initialMessage: "original",
    model: "scripted-model",
    resources: [],
    metadata: {},
    reasoningEffort: "high",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  // The API has already resolved and validated A before its remaining admission work.
  const acceptedPolicy = resolveTurnExecutionPolicyV1(settings, {
    modelId: "scripted-model",
    requestedModelId: null,
    modelSource: "session",
    reasoningEffort: "high",
    reasoningSource: "session",
    latencyMode: "standard",
    latencyModeSource: "session",
  });
  // Another previously queued turn starts on B before the final prompt gate.
  // B is deliberately unavailable here: validating B would reject accepted A.
  const other = await enqueueSessionTurn(client.db, {
    accountId: owner.accountId,
    workspaceId,
    sessionId: session.id,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${session.id}`,
    source: "user",
    prompt: "different turn",
    model: "unavailable-other-model",
    reasoningEffort: "low",
    resources: [],
    tools: [],
    metadata: {},
    sandboxBackend: "none",
    initiator: { kind: "subject", subjectId: owner.subjectId },
  });
  await appendSessionEvents(client.db, workspaceId, session.id, [
    { type: "turn.started", turnId: other.id, payload: {} },
  ]);
  const result = await postUserMessageTurn({
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: async () => undefined },
    settings,
    accountId: owner.accountId,
    workspaceId,
    sessionId: session.id,
    text: "continue with accepted policy",
    resources: [],
    actor: owner.subjectId,
    turnExecutionPolicy: acceptedPolicy,
  });
  expect(result.turn).toMatchObject({
    model: "scripted-model",
    reasoningEffort: "high",
    latencyMode: "standard",
  });
}, 30_000);
