import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const SECRET = "new-session-draft-connector-exclusions-secret";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("new-session-draft-exclusions");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("New-session draft exclusion tests require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  if (!client) throw new Error("PostgreSQL fixture unavailable");
  const context = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test:new-session-draft-exclusions",
    accountExternalId: crypto.randomUUID(),
    accountName: "Draft exclusions",
    workspaceExternalSource: "test:new-session-draft-exclusions",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Draft exclusions",
    subjectId: `user:draft-exclusions-${crypto.randomUUID()}`,
  });
  const grant = context.workspaceGrants[0]!;
  const settings = testSettings({ delegationSecret: SECRET, sandboxBackend: "none" });
  const app = createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
  });
  async function request(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
          ...(grant as AccessGrant),
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        })}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return { grant, settings, request };
}

// The web composer's Send with connectors on "Customize" but nothing pinned:
// it saves the draft as an explicit empty tool list plus the exclusion list,
// then creates with workspace-default tools (no `tools`) and the exclusions.
// Every Send used to answer 409 NEW_SESSION_DRAFT_CONFLICT right after the
// draft save succeeded, so the person could not start a chat at all.
test("PG: Send from a Customize-on composer with no pinned connectors creates the chat", async () => {
  if (!client) return;
  const f = await fixture();
  const draftPath = `/v1/workspaces/${f.grant.workspaceId}/new-session-draft`;
  const loaded = await f.request("GET", draftPath);
  expect(loaded.status).toBe(200);
  const remote = (await loaded.json()) as { revision: number };
  const draft = {
    text: "What messages can you read on slack?",
    resources: [],
    tools: [],
    toolsProvided: true,
    model: f.settings.openaiModel,
    reasoningEffort: f.settings.openaiReasoningEffort,
    latencyMode: "standard",
    modelProvided: true,
    options: { visibility: "workspace", excludedMcpServerIds: [] },
  };
  const savedResponse = await f.request("PUT", draftPath, {
    ...draft,
    expectedRevision: remote.revision,
  });
  expect(savedResponse.status).toBe(200);
  const saved = (await savedResponse.json()) as { revision: number };

  const created = await f.request("POST", `/v1/workspaces/${f.grant.workspaceId}/sessions`, {
    initialMessage: draft.text,
    visibility: "workspace",
    resources: [],
    excludedMcpServerIds: [],
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode,
    clientEventId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    expectedNewSessionDraftRevision: saved.revision,
  });
  expect(created.status, await created.clone().text()).toBe(202);
  expect(await created.json()).toMatchObject({
    toolPolicy: { mode: "workspace_default" },
  });

  const after = (await (await f.request("GET", draftPath)).json()) as {
    revision: number;
    text: string;
  };
  expect(after.text).toBe("");
  expect(after.revision).toBe(saved.revision + 1);
}, 180_000);
