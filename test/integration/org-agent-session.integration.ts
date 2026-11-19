// Organization (Console) agents end to end: real PostgreSQL and NATS, the API
// served over HTTP, an organization API key, and the worker's real turn
// activity with a scripted model. A chat named by key, by `{ ref }` with its
// own instructions, with `agentOverrides`, and the Console test chat route all
// create through the ordinary session create and run a turn whose system
// prompt carries the agent's Instructions (then the chat's own).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import type { Settings } from "@opengeni/config";
import { sha256Hex } from "@opengeni/contracts/values";
import { createApiKey, createDb, createWorkspace, listSessionEvents } from "@opengeni/db";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { startTestServices, type TestServices } from "@opengeni/testing/compose";
import { testSettings } from "@opengeni/testing/settings";
import { createActivityTestHarness as createWorkerActivities } from "../../apps/worker/src/activities";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { organizationApiKeyPermissions } from "../../apps/api/src/routes/api-keys";

const noopWorkflowClient: SessionWorkflowClient = {
  signalUserMessage: async () => undefined,
  wakeSessionWorkflow: async () => undefined,
  requestSessionWorkflowWakeDispatch: async () => undefined,
  signalApprovalDecision: async () => undefined,
  signalSessionControl: async () => undefined,
  syncScheduledTask: async () => undefined,
  deleteScheduledTaskSchedule: async () => undefined,
  triggerScheduledTask: async () => undefined,
};

describe("organization agents end to end", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let admin: ReturnType<typeof postgres>;
  let bus: EventBus;
  let settings: Settings;
  let server: ReturnType<typeof Bun.serve>;
  let accountId: string;
  let workspaceId: string;
  let authorization: string;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    // The API and worker use the restricted runtime role, as deployed (RLS applies).
    dbClient = createDb(services.runtimeDatabaseUrl);
    admin = postgres(services.databaseUrl, { max: 2 });
    bus = await createNatsEventBus(services.natsUrl);
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('Org agents e2e') returning id`;
    accountId = account!.id;
    workspaceId = (await createWorkspace(dbClient.db, { accountId, name: "Managed tenant" })).id;
    await admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
      values (${accountId}, ${workspaceId}, 'console')`;
    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(dbClient.db, {
      accountId,
      workspaceId: null,
      name: "Organization key",
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions: organizationApiKeyPermissions,
      credentialKind: "organization",
    });
    authorization = `Bearer ${token}`;
    settings = testSettings({
      databaseUrl: services.runtimeDatabaseUrl,
      natsUrl: services.natsUrl,
      productAccessMode: "managed",
      delegationSecret: "org-agents-e2e-delegation",
      sandboxBackend: "none",
      environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    });
    settings.orgAgentsAccountIds = [accountId];
    const app = createApp({
      settings,
      db: dbClient.db,
      bus,
      workflowClient: noopWorkflowClient,
    });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  }, 180_000);

  afterAll(async () => {
    server?.stop(true);
    await bus?.close();
    await dbClient?.close();
    await admin?.end();
    await services?.down();
  }, 120_000);

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
  }
  const agents = () => `/v1/organizations/${accountId}/agents`;
  const sessions = () => `/v1/workspaces/${workspaceId}/sessions`;

  /** Runs the chat's next turn in the worker; returns the system prompt the model got. */
  async function runTurn(chatWorkspaceId: string, sessionId: string): Promise<string> {
    const model = new ScriptedModel([{ outputText: "Done." }]);
    const runtime = createProductionAgentRuntime({ model });
    runtime.generateSessionTitle = async () => ({ title: null, usage: null });
    const activities = createWorkerActivities({ settings, db: dbClient.db, bus, runtime });
    const result = await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId,
      workspaceId: chatWorkspaceId,
      sessionId,
      trigger: { kind: "next" },
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, chatWorkspaceId, sessionId, 0, 200);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(model.calls).toBe(1);
    return String((model.requests[0] as { systemInstructions?: unknown }).systemInstructions);
  }

  async function publishedAgent(key: string, instructions: string) {
    const created = await call("POST", agents(), {
      key,
      name: key,
      instructions,
      config: { model: "scripted-model" },
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;
    const published = await call("POST", `${agents()}/${agentId}/publish`, {
      version: 1,
      expectedVersion: created.body.agent.rowVersion,
    });
    expect(published.status).toBe(200);
    return { agentId, rowVersion: published.body.agent.rowVersion as number };
  }

  test("agent as a key: the turn runs with the agent's Instructions", async () => {
    const { agentId } = await publishedAgent("support", "Always greet the customer by name.");
    const created = await call("POST", sessions(), { initialMessage: "Hello", agent: "support" });
    expect([created.status, created.body.orgAgent]).toEqual([
      202,
      { id: agentId, key: "support", version: 1, overrides: null },
    ]);
    const prompt = await runTurn(workspaceId, created.body.id);
    expect(prompt).toContain("Always greet the customer by name.");
  }, 180_000);

  test("agent as { ref } with the chat's instructions after the agent's", async () => {
    await publishedAgent("billing", "Explain invoices plainly.");
    const created = await call("POST", sessions(), {
      initialMessage: "Hello",
      agent: { ref: "billing", instructions: "Answer in French." },
    });
    expect(created.status).toBe(202);
    const prompt = await runTurn(workspaceId, created.body.id);
    const agentAt = prompt.indexOf("Explain invoices plainly.");
    const chatAt = prompt.indexOf("Answer in French.");
    expect(agentAt).toBeGreaterThan(-1);
    expect(chatAt).toBeGreaterThan(agentAt);
  }, 180_000);

  test("agentOverrides: reject refuses a changed setting; allow records it", async () => {
    await publishedAgent("strict", "Stay on topic.");
    const refused = await call("POST", sessions(), {
      initialMessage: "Hello",
      agent: "strict",
      model: "gpt-5.6-luna",
      agentOverrides: "reject",
    });
    expect([refused.status, refused.body.code]).toEqual([422, "agent_override_rejected"]);
    const allowed = await call("POST", sessions(), {
      initialMessage: "Hello",
      agent: { ref: "strict" },
      model: "gpt-5.6-luna",
      agentOverrides: "allow",
    });
    expect(allowed.status).toBe(202);
    expect(allowed.body.orgAgent.overrides).toEqual({
      model: { agent: "scripted-model", chat: "gpt-5.6-luna" },
    });
    const unchanged = await call("POST", sessions(), {
      initialMessage: "Hello",
      agent: { ref: "strict" },
      agentOverrides: "reject",
    });
    expect(unchanged.status).toBe(202);
    expect(await runTurn(workspaceId, unchanged.body.id)).toContain("Stay on topic.");
  }, 180_000);

  test("a Console test chat runs the draft in the test workspace", async () => {
    const { agentId, rowVersion } = await publishedAgent("drafted", "Published rules.");
    const draft = await call("PUT", `${agents()}/${agentId}/draft`, {
      name: "drafted",
      instructions: "Draft rules.",
      expectedVersion: rowVersion,
    });
    expect(draft.status).toBe(201);
    const chat = await call("POST", `${agents()}/${agentId}/test-chats`, {
      version: 2,
      message: "Try it",
    });
    expect({ status: chat.status, error: chat.status === 201 ? null : chat.body }).toEqual({
      status: 201,
      error: null,
    });
    const prompt = await runTurn(chat.body.workspaceId, chat.body.sessionId);
    expect(prompt).toContain("Draft rules.");
    expect(prompt).not.toContain("Published rules.");
  }, 180_000);
});
