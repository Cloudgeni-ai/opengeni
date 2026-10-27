import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createDb, getSession, listBotTemplates, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// Bots through the API and the agent's tools (real PostgreSQL): a chat's name,
// description and avatar, and the workspace's bot templates.

const DELEGATION_SECRET = "session-bots-api-test-secret";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: ReturnType<typeof createApp>;
let deps: ApiRouteDeps;

type Workspace = { accountId: string; workspaceId: string };

class WorkflowStub implements SessionWorkflowClient {
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

async function freshWorkspace(name: string): Promise<Workspace> {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

/** A person's token by default; a service caller manages every template. */
async function bearer(
  workspace: Workspace,
  subjectId: string,
  permissions: Permission[],
  principal: "person" | "service" = "person",
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...workspace,
    subjectId,
    subjectLabel: subjectId,
    permissions,
    principalKind: principal === "service" ? "service" : "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function call(
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json", authorization: auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function agentGrant(workspace: Workspace, sessionId: string): AccessGrant {
  return {
    ...workspace,
    subjectId: "agent:bots-test",
    permissions: ["workspace:read", "sessions:read", "sessions:create", "sessions:control"],
    metadata: {
      delegated: true,
      sessionId,
      firstPartyMcpTools: ["set_session_title", "bot_template_save"],
    },
  };
}

async function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ body: any; isError: boolean }> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  try {
    const result = (await tool.handler(args, {})) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    const text = result.content?.[0]?.text ?? "null";
    return { body: JSON.parse(text), isError: result.isError === true };
  } catch (error) {
    return {
      body: { error: error instanceof Error ? error.message : String(error) },
      isError: true,
    };
  }
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-bots");
  if (!shared) return;
  client = createDb(shared.appUrl);
  deps = {
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: new WorkflowStub(),
    objectStorage: null,
    githubStateSecret: "session-bots-test-state",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are not used by bot tests");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
  app = createApp(deps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("bots through the API (real PostgreSQL)", () => {
  test("a chat starts as a bot and its profile is edited", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("bots profile");
    const auth = await bearer(workspace, "bots-person", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);
    const base = `/v1/workspaces/${workspace.workspaceId}/sessions`;
    const created = await call(auth, "POST", base, {
      initialMessage: "You own releases. Set yourself up.",
      model: "scripted-model",
      keepLive: true,
      profile: {
        title: "Release owner",
        description: "Keeps the release checklist moving",
        avatar: { kind: "emoji", emoji: "🚀", hue: 210 },
      },
    });
    expect(created.status).toBe(202);
    expect(created.json).toMatchObject({
      title: "Release owner",
      titleSource: "user",
      description: "Keeps the release checklist moving",
      avatar: { kind: "emoji", emoji: "🚀", hue: 210 },
    });
    const sessionId = created.json.id as string;

    // An avatar the chat could not show refuses the whole create.
    const refused = await call(auth, "POST", base, {
      initialMessage: "never created",
      model: "scripted-model",
      profile: { avatar: { kind: "image", artifactId: crypto.randomUUID() } },
    });
    expect(refused.status).toBe(422);

    // Only what is named changes.
    const edited = await call(auth, "PATCH", `${base}/${sessionId}`, {
      avatar: { kind: "icon", icon: "rocket", hue: 30 },
    });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({
      title: "Release owner",
      description: "Keeps the release checklist moving",
      avatar: { kind: "icon", icon: "rocket", hue: 30 },
    });
    const cleared = await call(auth, "PATCH", `${base}/${sessionId}`, {
      description: null,
    });
    expect(cleared.json).toMatchObject({ description: null, title: "Release owner" });

    // A rename alone still works as before.
    const renamed = await call(auth, "PATCH", `${base}/${sessionId}`, { title: "Release captain" });
    expect(renamed.json).toMatchObject({ title: "Release captain", titleSource: "user" });

    for (const body of [
      {},
      { avatar: { kind: "emoji", emoji: "ab", hue: 1 } },
      { avatar: { kind: "letters", letters: "ABC", hue: 1 } },
      { avatar: { kind: "icon", icon: "not-an-icon", hue: 1 } },
      { description: "x".repeat(281) },
    ]) {
      expect((await call(auth, "PATCH", `${base}/${sessionId}`, body)).status).toBe(400);
    }
    expect(
      (
        await call(auth, "PATCH", `${base}/${sessionId}`, {
          avatar: { kind: "image", artifactId: crypto.randomUUID() },
        })
      ).status,
    ).toBe(422);

    // The sidebar's compact list carries them too.
    const listed = await call(auth, "GET", `${base}?view=page&projection=summary&limit=20`);
    expect(listed.status).toBe(200);
    const entry = [...listed.json.pinned, ...listed.json.sessions].find(
      (item: { id: string }) => item.id === sessionId,
    );
    expect(entry).toMatchObject({
      title: "Release captain",
      description: null,
      avatar: { kind: "icon", icon: "rocket", hue: 30 },
    });
  }, 180_000);

  test("templates: everyone uses them, whoever saved one manages it", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("bots templates");
    const person = ["workspace:read", "sessions:create", "sessions:read"] as Permission[];
    const alice = await bearer(workspace, "user:alice", person);
    const bob = await bearer(workspace, "user:bob", person);
    const reader = await bearer(workspace, "user:reader", ["workspace:read", "sessions:read"]);
    const admin = await bearer(workspace, "user:admin", ["workspace:admin"]);
    const service = await bearer(workspace, "svc:ops", person, "service");
    const base = `/v1/workspaces/${workspace.workspaceId}/bot-templates`;

    const saved = await call(alice, "POST", base, {
      name: "  SRE bot ",
      description: "Watches production",
      avatar: { kind: "letters", letters: "SR", hue: 0 },
      setupInstructions: "Ask how they deploy today, then set up what fits.",
    });
    expect(saved.status).toBe(201);
    const template = saved.json.template;
    expect(template).toMatchObject({
      name: "SRE bot",
      createdBySubjectId: "user:alice",
      viewerAccess: "manage",
      sourceSessionId: null,
    });
    expect((await call(reader, "POST", base, { name: "x", setupInstructions: "y" })).status).toBe(
      403,
    );

    const seenByBob = await call(bob, "GET", base);
    expect(seenByBob.json.templates).toHaveLength(1);
    expect(seenByBob.json.templates[0]).toMatchObject({ id: template.id, viewerAccess: "use" });
    expect((await call(reader, "GET", `${base}/${template.id}`)).json.template.name).toBe(
      "SRE bot",
    );
    expect((await call(bob, "PATCH", `${base}/${template.id}`, { name: "Mine" })).status).toBe(403);
    expect((await call(bob, "DELETE", `${base}/${template.id}`)).status).toBe(403);

    const changed = await call(alice, "PATCH", `${base}/${template.id}`, {
      setupInstructions: "Install the on-call Skill and create the morning check.",
    });
    expect(changed.json.template).toMatchObject({
      name: "SRE bot",
      setupInstructions: "Install the on-call Skill and create the morning check.",
    });
    const byAdmin = await call(admin, "PATCH", `${base}/${template.id}`, { avatar: null });
    expect(byAdmin.json.template).toMatchObject({ avatar: null, viewerAccess: "manage" });
    // A workspace-level (service) caller saves templates nobody owns, and
    // manages every template.
    const byService = await call(service, "GET", `${base}/${template.id}`);
    expect(byService.json.template.viewerAccess).toBe("manage");

    expect((await call(alice, "GET", `${base}/not-a-uuid`)).status).toBe(404);
    expect((await call(alice, "GET", `${base}/${crypto.randomUUID()}`)).status).toBe(404);
    const other = await freshWorkspace("bots templates other");
    const outsider = await bearer(other, "user:alice", person);
    expect(
      (await call(outsider, "GET", `/v1/workspaces/${other.workspaceId}/bot-templates`)).json
        .templates,
    ).toEqual([]);

    expect((await call(alice, "DELETE", `${base}/${template.id}`)).status).toBe(200);
    expect((await call(alice, "GET", base)).json.templates).toEqual([]);
  }, 180_000);

  test("the agent edits its own profile and saves itself as a template", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("bots agent tools");
    const auth = await bearer(workspace, "bots-person", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);
    const created = await call(auth, "POST", `/v1/workspaces/${workspace.workspaceId}/sessions`, {
      initialMessage: "Be the release owner",
      model: "scripted-model",
      profile: { title: "Release owner" },
    });
    const sessionId = created.json.id as string;
    const server = buildOpenGeniMcpServer(deps, agentGrant(workspace, sessionId));

    // Description and avatar alone.
    const look = await callTool(server, "set_session_title", {
      description: "Keeps the release checklist moving",
      avatar: { kind: "emoji", emoji: "🚀", hue: 210 },
    });
    expect(look.isError).toBe(false);
    expect(look.body).toMatchObject({
      ok: true,
      updated: true,
      title: "Release owner",
      description: "Keeps the release checklist moving",
      avatar: { kind: "emoji", emoji: "🚀", hue: 210 },
    });

    // The agent's rename is a chosen name: cleaned like any model-written
    // title, then stored so automatic titling never replaces it.
    const renamed = await callTool(server, "set_session_title", { title: "  Release captain\n" });
    expect(renamed.body).toMatchObject({ updated: true, title: "Release captain" });
    expect(await getSession(client.db, workspace.workspaceId, sessionId)).toMatchObject({
      title: "Release captain",
      titleSource: "user",
      description: "Keeps the release checklist moving",
    });
    // A title that looks like a credential never reaches storage.
    const secret = await callTool(server, "set_session_title", {
      title: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(secret.body).toMatchObject({ updated: false, title: "Release captain" });

    // Clearing, and refusals that never reach storage.
    expect(
      (await callTool(server, "set_session_title", { description: "", avatar: null })).body,
    ).toMatchObject({ description: null, avatar: null });
    expect((await callTool(server, "set_session_title", {})).isError).toBe(true);
    expect(
      (await callTool(server, "set_session_title", { avatar: { kind: "emoji", hue: 3 } })).isError,
    ).toBe(true);
    expect(
      (
        await callTool(server, "set_session_title", {
          avatar: { kind: "image", artifactId: crypto.randomUUID() },
        })
      ).isError,
    ).toBe(true);

    const saved = await callTool(server, "bot_template_save", {
      name: "Release owner",
      description: "Keeps the release checklist moving",
      avatar: { kind: "icon", icon: "rocket", hue: 30 },
      setupInstructions: "You own releases. Install the release Skill and ask about their cadence.",
    });
    expect(saved.isError).toBe(false);
    expect(saved.body.template).toMatchObject({
      name: "Release owner",
      sourceSessionId: sessionId,
      avatar: { kind: "icon", icon: "rocket", hue: 30 },
    });
    const stored = await listBotTemplates(client.db, workspace.workspaceId);
    expect(stored.map((template) => template.id)).toEqual([saved.body.template.id]);
  }, 180_000);

  test("the agent suggests a bot, and only records it on the chat", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("bots suggest");
    const auth = await bearer(workspace, "bots-person", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);
    const base = `/v1/workspaces/${workspace.workspaceId}/sessions`;
    const plain = await call(auth, "POST", base, {
      initialMessage: "Check this invoice against the PO",
      model: "scripted-model",
    });
    const sessionId = plain.json.id as string;
    const existing = await call(auth, "POST", base, {
      initialMessage: "Watch production",
      model: "scripted-model",
      keepLive: true,
      profile: { title: "SRE bot", avatar: { kind: "icon", icon: "shield-check", hue: 200 } },
    });
    const botId = existing.json.id as string;
    const template = await call(
      auth,
      "POST",
      `/v1/workspaces/${workspace.workspaceId}/bot-templates`,
      {
        name: "Release owner",
        setupInstructions: "Own releases.",
      },
    );
    const templateId = template.json.template.id as string;
    const server = buildOpenGeniMcpServer(deps, {
      ...agentGrant(workspace, sessionId),
      metadata: { delegated: true, sessionId, firstPartyMcpTools: ["bot_suggest"] },
    });

    const created = await callTool(server, "bot_suggest", {
      kind: "create",
      name: "Invoice checker",
      description: "Checks supplier invoices against purchase orders",
      avatar: { kind: "emoji", emoji: "🧾", hue: 60 },
      setupInstructions: "Check each invoice against its PO and list mismatches.",
      reason: "You have asked for three invoice checks in this chat.",
    });
    expect(created.isError).toBe(false);
    expect(created.body).toMatchObject({
      type: "bot_suggestion",
      status: "suggested",
      kind: "create",
      name: "Invoice checker",
      avatar: { kind: "emoji", emoji: "🧾", hue: 60 },
    });
    // Recorded as display state only: the chat keeps its name and look.
    const after = await getSession(client.db, workspace.workspaceId, sessionId);
    expect(after?.botSuggestion).toMatchObject({ id: created.body.id, name: "Invoice checker" });
    expect(after?.avatar).toBeNull();
    expect(after?.description).toBeNull();
    expect(after?.updatedAt).toBe(plain.json.updatedAt);

    // A taken name points the agent at what already exists.
    const taken = await callTool(server, "bot_suggest", {
      kind: "create",
      name: "sre BOT",
      reason: "Production keeps coming up.",
    });
    expect(taken.body).toMatchObject({ status: "not_suggested", code: "name_taken" });
    expect(taken.body.bots).toEqual([
      expect.objectContaining({ sessionId: botId, name: "SRE bot" }),
    ]);
    expect(taken.body.templates).toEqual([
      expect.objectContaining({ templateId, name: "Release owner" }),
    ]);

    // Reuse points at a bot chat or a template, never at a plain chat.
    const reuseBot = await callTool(server, "bot_suggest", {
      kind: "reuse",
      sessionId: botId,
      reason: "The SRE bot already watches production.",
    });
    expect(reuseBot.body).toMatchObject({
      status: "suggested",
      kind: "reuse",
      sessionId: botId,
      name: "SRE bot",
      avatar: { kind: "icon", icon: "shield-check", hue: 200 },
    });
    const reuseTemplate = await callTool(server, "bot_suggest", {
      kind: "reuse",
      templateId,
      reason: "Releases have a template.",
    });
    expect(reuseTemplate.body).toMatchObject({ kind: "reuse", templateId, name: "Release owner" });
    expect((await getSession(client.db, workspace.workspaceId, sessionId))?.botSuggestion?.id).toBe(
      reuseTemplate.body.id,
    );
    expect(
      (await callTool(server, "bot_suggest", { kind: "reuse", sessionId, reason: "x" })).body,
    ).toMatchObject({ code: "already_here" });
    expect(
      (
        await callTool(server, "bot_suggest", {
          kind: "reuse",
          sessionId: botId,
          templateId,
          reason: "x",
        })
      ).body,
    ).toMatchObject({ code: "invalid_target" });

    // A chat that is already a bot is not offered one.
    const botServer = buildOpenGeniMcpServer(deps, {
      ...agentGrant(workspace, botId),
      metadata: { delegated: true, sessionId: botId, firstPartyMcpTools: ["bot_suggest"] },
    });
    expect(
      (await callTool(botServer, "bot_suggest", { kind: "create", name: "Ops", reason: "x" })).body,
    ).toMatchObject({ code: "already_a_bot" });
  }, 180_000);

  test("a bot proposes setup updates for its template, and its owner decides", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("bots template proposals");
    const person = [
      "workspace:read",
      "sessions:read",
      "sessions:create",
      "sessions:control",
    ] as Permission[];
    const alice = await bearer(workspace, "user:alice", person);
    const bob = await bearer(workspace, "user:bob", person);
    const templates = `/v1/workspaces/${workspace.workspaceId}/bot-templates`;
    const proposals = `/v1/workspaces/${workspace.workspaceId}/bot-template-proposals`;
    const sessions = `/v1/workspaces/${workspace.workspaceId}/sessions`;
    const template = (
      await call(alice, "POST", templates, {
        name: "SRE bot",
        setupInstructions: "Install the on-call Skill.",
      })
    ).json.template;

    // A chat started from the template is linked to it; an unknown one is refused.
    expect(
      (
        await call(bob, "POST", sessions, {
          initialMessage: "Install the on-call Skill.",
          model: "scripted-model",
          botTemplateId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(422);
    const bot = await call(bob, "POST", sessions, {
      initialMessage: "Install the on-call Skill.",
      model: "scripted-model",
      keepLive: true,
      botTemplateId: template.id,
      profile: { title: "SRE bot" },
    });
    expect(bot.status).toBe(202);
    expect(bot.json.botTemplateId).toBe(template.id);
    const botId = bot.json.id as string;
    expect((await getSession(client.db, workspace.workspaceId, botId))?.botTemplateId).toBe(
      template.id,
    );

    const server = buildOpenGeniMcpServer(deps, {
      ...agentGrant(workspace, botId),
      metadata: {
        delegated: true,
        sessionId: botId,
        firstPartyMcpTools: ["bot_template_propose_update"],
      },
    });
    expect((await callTool(server, "bot_template_propose_update", {})).body).toMatchObject({
      status: "current",
      templateId: template.id,
      setupInstructions: "Install the on-call Skill.",
    });
    expect(
      (
        await callTool(server, "bot_template_propose_update", {
          setupInstructions: "Install the on-call Skill.",
          reason: "Nothing new.",
        })
      ).body,
    ).toMatchObject({ status: "not_proposed", code: "unchanged" });
    const first = await callTool(server, "bot_template_propose_update", {
      setupInstructions: "Install the on-call Skill. Connect PagerDuty.",
      reason: "This bot now pages through PagerDuty.",
    });
    expect(first.body).toMatchObject({
      type: "bot_template_proposal",
      status: "proposed",
      proposal: { templateId: template.id, sessionId: botId, status: "pending" },
    });
    const second = await callTool(server, "bot_template_propose_update", {
      setupInstructions: "Install the on-call Skill. Connect PagerDuty. Check alerts every hour.",
      reason: "It now checks alerts every hour too.",
    });
    // One chat, one open proposal: the older one is superseded.
    const pending = await call(bob, "GET", `${proposals}?sessionId=${botId}`);
    expect(pending.json.proposals.map((proposal: { id: string }) => proposal.id)).toEqual([
      second.body.proposal.id,
    ]);
    const all = await call(bob, "GET", `${proposals}?templateId=${template.id}&status=all`);
    expect(
      all.json.proposals.find((proposal: { id: string }) => proposal.id === first.body.proposal.id),
    ).toMatchObject({ status: "superseded" });
    expect((await call(bob, "GET", `${proposals}?status=bogus`)).status).toBe(422);

    // Only whoever may change the template decides, against the version reviewed.
    const accept = (auth: string, expectedUpdatedAt: string) =>
      call(auth, "POST", `${proposals}/${second.body.proposal.id}/accept`, { expectedUpdatedAt });
    expect((await accept(bob, template.updatedAt)).status).toBe(403);
    expect((await accept(alice, new Date(0).toISOString())).status).toBe(409);
    const accepted = await accept(alice, template.updatedAt);
    expect(accepted.status).toBe(200);
    expect(accepted.json.template.setupInstructions).toBe(
      "Install the on-call Skill. Connect PagerDuty. Check alerts every hour.",
    );
    expect(accepted.json.proposal).toMatchObject({
      status: "accepted",
      decidedBySubjectId: "user:alice",
    });
    expect(
      (await call(alice, "POST", `${proposals}/${second.body.proposal.id}/dismiss`)).status,
    ).toBe(409);
    expect((await call(alice, "POST", `${proposals}/${crypto.randomUUID()}/dismiss`)).status).toBe(
      404,
    );

    // A chat saved as a template proposes for that one; a plain chat has none.
    const plain = await call(bob, "POST", sessions, {
      initialMessage: "Help with invoices",
      model: "scripted-model",
    });
    const plainServer = buildOpenGeniMcpServer(deps, {
      ...agentGrant(workspace, plain.json.id),
      metadata: {
        delegated: true,
        sessionId: plain.json.id,
        firstPartyMcpTools: ["bot_template_propose_update", "bot_template_save"],
      },
    });
    expect(
      (
        await callTool(plainServer, "bot_template_propose_update", {
          setupInstructions: "x",
          reason: "x",
        })
      ).body,
    ).toMatchObject({ status: "not_proposed", code: "no_template" });
    const saved = await callTool(plainServer, "bot_template_save", {
      name: "Invoice checker",
      setupInstructions: "Check invoices against POs.",
    });
    expect((await callTool(plainServer, "bot_template_propose_update", {})).body).toMatchObject({
      status: "current",
      templateId: saved.body.template.id,
    });
  }, 180_000);
});
