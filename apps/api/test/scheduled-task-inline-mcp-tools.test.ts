import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionWorkflowClient } from "@opengeni/core";
import { createDb, createOrganizationApiKey, createWorkspace, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

// A task that starts its own chats may name the MCP servers it attaches to them
// in its tool selection, as a session create may. Unknown servers still fail.

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-task-inline-mcp-tools");
  if (!acquired) throw new Error("Scheduled task inline MCP tool tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Inline MCP fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "mcp_servers:attach",
      "scheduled_tasks:run",
      "scheduled_tasks:manage",
    ],
  });
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `/v1/workspaces/${workspace.id}/scheduled-tasks`;
  const request = async (method: string, path: string, body?: unknown) =>
    await app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { base, request };
}

const server = { id: "task-tools", name: "Task tools", url: "https://mcp.example.test/tools" };

const agentConfig = (fields: Record<string, unknown>) => ({
  prompt: "Review the open work",
  resources: [],
  tools: [],
  metadata: {},
  sandboxBackend: "none",
  mcpServers: [server],
  ...fields,
});

const task = (fields: Record<string, unknown>) => ({
  name: "Nightly review",
  schedule: { type: "manual" },
  runMode: "new_session_per_run",
  overlapPolicy: "skip",
  ...fields,
});

type StoredTask = {
  id: string;
  agentConfig: { tools?: Array<{ kind: string; id: string; eager?: unknown }> };
};

test("a task's tools may name an MCP server the task attaches", async () => {
  const { base, request } = await fixture();
  const tools = [{ kind: "mcp", id: server.id, eager: ["search"] }];

  const created = await request("POST", base, task({ agentConfig: agentConfig({ tools }) }));
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as StoredTask;
  const stored = (await (await request("GET", `${base}/${id}`)).json()) as StoredTask;
  expect(stored.agentConfig.tools).toContainEqual(expect.objectContaining({ id: server.id }));

  const updated = await request("PATCH", `${base}/${id}`, {
    agentConfig: agentConfig({ tools: [{ kind: "mcp", id: server.id }] }),
  });
  expect(updated.status).toBe(200);
});

test("a task's tools still may not name an unknown MCP server", async () => {
  const { base, request } = await fixture();

  const unknown = await request(
    "POST",
    base,
    task({ agentConfig: agentConfig({ tools: [{ kind: "mcp", id: "not-configured" }] }) }),
  );
  expect(unknown.status).toBe(422);

  const detached = await request(
    "POST",
    base,
    task({
      agentConfig: agentConfig({ mcpServers: [], tools: [{ kind: "mcp", id: server.id }] }),
    }),
  );
  expect(detached.status).toBe(422);
});
