import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission, SessionAvatar } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getSession,
  listBotTemplates,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { sessionAvatarImageUrl } from "../src/integrations/session-avatar-image";
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

const AVATAR_SIGNING_SECRET = "bots-avatar-signing-secret";

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
      slackSigningSecret: AVATAR_SIGNING_SECRET,
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

  test("templates: shared ones are everyone's to change, Only me ones stay with whoever saved them", async () => {
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
      viewerCanMakePrivate: true,
      sourceSessionId: null,
    });
    expect((await call(reader, "POST", base, { name: "x", setupInstructions: "y" })).status).toBe(
      403,
    );

    const seenByBob = await call(bob, "GET", base);
    expect(seenByBob.json.templates).toHaveLength(1);
    // A shared template is shared work: any member who starts chats changes it.
    // ...but only whoever saved it (or an admin) may make it Only me, and the
    // template says so, so the edit dialog offers only what the server allows.
    expect(seenByBob.json.templates[0]).toMatchObject({
      id: template.id,
      viewerAccess: "manage",
      viewerCanMakePrivate: false,
    });
    expect((await call(reader, "GET", base)).json.templates[0]).toMatchObject({
      id: template.id,
      viewerAccess: "use",
      viewerCanMakePrivate: false,
    });
    expect((await call(admin, "GET", `${base}/${template.id}`)).json.template).toMatchObject({
      viewerAccess: "manage",
      viewerCanMakePrivate: true,
    });
    expect((await call(reader, "GET", `${base}/${template.id}`)).json.template.name).toBe(
      "SRE bot",
    );
    expect((await call(reader, "PATCH", `${base}/${template.id}`, { name: "No" })).status).toBe(
      403,
    );
    expect((await call(reader, "DELETE", `${base}/${template.id}`)).status).toBe(403);
    const renamedByBob = await call(bob, "PATCH", `${base}/${template.id}`, { name: "SRE bot" });
    expect(renamedByBob.status).toBe(200);
    expect(renamedByBob.json.template).toMatchObject({
      createdBySubjectId: "user:alice",
      viewerAccess: "manage",
    });
    // Only whoever saved it (or an admin) can take it away from everyone.
    const hiddenByBob = await call(bob, "PATCH", `${base}/${template.id}`, {
      visibility: "private",
    });
    expect(hiddenByBob.status).toBe(403);
    expect(hiddenByBob.json.error.message).toContain("can make it Only me");

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

    // A source chat must be one in this workspace the caller can open.
    const foreignSource = await call(alice, "POST", base, {
      name: "Copied",
      setupInstructions: "Set up.",
      sourceSessionId: crypto.randomUUID(),
    });
    expect(foreignSource.status).toBe(422);
    expect(foreignSource.json.error.message).toContain("sourceSessionId");

    // Only me: nobody else sees it, not even an admin, until it is shared.
    const mine = await call(alice, "POST", base, {
      name: "My inbox bot",
      setupInstructions: "Sort my inbox.",
      visibility: "private",
    });
    expect(mine.status).toBe(201);
    expect(mine.json.template).toMatchObject({ visibility: "private", viewerAccess: "manage" });
    const mineId = mine.json.template.id as string;
    expect((await call(alice, "GET", base)).json.templates.map((row: any) => row.id)).toEqual([
      mineId,
    ]);
    for (const viewer of [bob, admin, service]) {
      expect((await call(viewer, "GET", base)).json.templates).toEqual([]);
      expect((await call(viewer, "GET", `${base}/${mineId}`)).status).toBe(404);
      expect((await call(viewer, "PATCH", `${base}/${mineId}`, { name: "Taken" })).status).toBe(
        404,
      );
      expect((await call(viewer, "DELETE", `${base}/${mineId}`)).status).toBe(404);
    }
    // Nobody to keep it for: a workspace-level caller can't save one.
    expect(
      (
        await call(service, "POST", base, {
          name: "Nobody's",
          setupInstructions: "Set up.",
          visibility: "private",
        })
      ).status,
    ).toBe(422);
    const sharedNow = await call(alice, "PATCH", `${base}/${mineId}`, { visibility: "workspace" });
    expect(sharedNow.json.template.visibility).toBe("workspace");
    expect((await call(bob, "GET", base)).json.templates.map((row: any) => row.id)).toEqual([
      mineId,
    ]);
    // Once shared, any member who starts chats may also delete it.
    expect((await call(bob, "DELETE", `${base}/${mineId}`)).status).toBe(200);
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
    expect(saved.body.template.visibility).toBe("workspace");
    const stored = await listBotTemplates(client.db, workspace.workspaceId, null);
    expect(stored.map((template) => template.id)).toEqual([saved.body.template.id]);
  }, 180_000);

  test("the agent in an Only me chat saves an Only me template", async () => {
    if (!shared) return;
    const userId = `bots-private-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Bots private owner",
    });
    const workspaceId = provisioned.accessContext.defaultWorkspaceId!;
    const accountId = provisioned.accessContext.workspaceGrants.find(
      (grant) => grant.workspaceId === workspaceId,
    )!.accountId;
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'bots-test')
      on conflict do nothing`;
    const chat = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Be my release owner",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      subjectId,
      visibility: "user_private",
    });
    const grant = { ...agentGrant({ accountId, workspaceId }, chat.id), subjectId };
    const saved = await callTool(buildOpenGeniMcpServer(deps, grant), "bot_template_save", {
      name: "My release owner",
      setupInstructions: "You own my releases.",
    });
    expect(saved.isError).toBe(false);
    expect(saved.body.template).toMatchObject({
      visibility: "private",
      createdBySubjectId: subjectId,
    });
    expect(await listBotTemplates(client.db, workspaceId, "user:someone-else")).toEqual([]);
    expect(
      (await listBotTemplates(client.db, workspaceId, subjectId)).map((row) => row.id),
    ).toEqual([saved.body.template.id]);
  }, 180_000);

  test("a bot's avatar picture is public at its signed link and nowhere else", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("bots avatar picture");
    const avatarUrl = (avatar: SessionAvatar) =>
      new URL(
        sessionAvatarImageUrl("https://app.example.test", AVATAR_SIGNING_SECRET, {
          workspaceId: workspace.workspaceId,
          avatar,
        }),
      ).pathname;
    // Slack fetches it with no credentials at all.
    const picture = await app.request(avatarUrl({ kind: "letters", letters: "RO", hue: 30 }));
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await picture.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((byte) => String.fromCharCode(byte)).join("")).toBe("PNG");

    const signed = avatarUrl({ kind: "icon", icon: "rocket", hue: 30 });
    expect((await app.request(signed.replace(/\.png$/u, "x.png"))).status).toBe(404);
    expect((await app.request(signed.replace(/\.png$/u, ""))).status).toBe(404);
    const forged = sessionAvatarImageUrl("https://app.example.test", "another-secret", {
      workspaceId: workspace.workspaceId,
      avatar: { kind: "icon", icon: "rocket", hue: 30 },
    });
    expect((await app.request(new URL(forged).pathname)).status).toBe(404);
    // An image that is not in the workspace draws nothing.
    expect(
      (await app.request(avatarUrl({ kind: "image", artifactId: crypto.randomUUID() }))).status,
    ).toBe(404);
  }, 180_000);

  test("the agent suggests a bot only after repeated work, and only records it", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("bots suggest");
    const auth = await bearer(workspace, "bots-person", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);
    const base = `/v1/workspaces/${workspace.workspaceId}/sessions`;
    /** A chat people have sent `requests` messages, and the agent's tools in it. */
    const chatWithRequests = async (requests: number, extra: Record<string, unknown> = {}) => {
      const created = await call(auth, "POST", base, {
        initialMessage: "Check this invoice against the PO",
        model: "scripted-model",
        ...extra,
      });
      expect(created.status).toBe(202);
      const id = created.json.id as string;
      for (let sent = 1; sent < requests; sent += 1) {
        const event = await call(auth, "POST", `${base}/${id}/events`, {
          type: "user.message",
          payload: { text: `Same check again, number ${sent + 1}` },
        });
        expect(event.status).toBeLessThan(300);
      }
      const server = buildOpenGeniMcpServer(deps, {
        ...agentGrant(workspace, id),
        metadata: { delegated: true, sessionId: id, firstPartyMcpTools: ["bot_suggest"] },
      });
      return { id, server };
    };
    const invoiceChecker = {
      kind: "create",
      name: "Invoice checker",
      description: "Checks supplier invoices against purchase orders",
      avatar: { kind: "emoji", emoji: "🧾", hue: 60 },
      setupInstructions: "Check each invoice against its PO and list mismatches.",
      reason: "You have asked for three invoice checks in this chat.",
    };

    // Too little repetition is refused: the agent's own count, and people's real requests.
    const early = await chatWithRequests(2);
    expect(
      (await callTool(early.server, "bot_suggest", { ...invoiceChecker, similarRequestsInARow: 3 }))
        .body,
    ).toMatchObject({ status: "not_suggested", code: "too_few_similar_requests" });
    const mixed = await chatWithRequests(5);
    expect(
      (await callTool(mixed.server, "bot_suggest", { ...invoiceChecker, similarRequestsInARow: 2 }))
        .body,
    ).toMatchObject({ status: "not_suggested", code: "too_few_similar_requests" });
    for (const chat of [early, mixed]) {
      expect(
        (await getSession(client.db, workspace.workspaceId, chat.id))?.botSuggestion,
      ).toBeUndefined();
    }

    const { id: sessionId, server } = await chatWithRequests(3);
    const before = await getSession(client.db, workspace.workspaceId, sessionId);
    const suggested = await callTool(server, "bot_suggest", {
      ...invoiceChecker,
      similarRequestsInARow: 3,
    });
    expect(suggested.isError).toBe(false);
    expect(suggested.body).toMatchObject({
      type: "bot_suggestion",
      status: "suggested",
      kind: "create",
      name: "Invoice checker",
      avatar: { kind: "emoji", emoji: "🧾", hue: 60 },
    });
    // Recorded as display state only: the chat keeps its name, look and activity time.
    const after = await getSession(client.db, workspace.workspaceId, sessionId);
    expect(after?.botSuggestion).toMatchObject({ id: suggested.body.id, name: "Invoice checker" });
    expect(after?.avatar).toBeNull();
    expect(after?.description).toBeNull();
    expect(after?.updatedAt).toBe(before?.updatedAt);
    // Once per chat, so a dismissed card never comes back.
    expect(
      (await callTool(server, "bot_suggest", { ...invoiceChecker, similarRequestsInARow: 4 })).body,
    ).toMatchObject({ status: "not_suggested", code: "already_suggested" });

    const bot = await chatWithRequests(3, {
      keepLive: true,
      profile: { title: "SRE bot", avatar: { kind: "icon", icon: "shield-check", hue: 200 } },
    });
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

    // A taken name points the agent at what already exists.
    const taken = await callTool((await chatWithRequests(3)).server, "bot_suggest", {
      kind: "create",
      name: "sre BOT",
      similarRequestsInARow: 3,
      reason: "Production keeps coming up.",
    });
    expect(taken.body).toMatchObject({ status: "not_suggested", code: "name_taken" });
    expect(taken.body.bots).toEqual([
      expect.objectContaining({ sessionId: bot.id, name: "SRE bot" }),
    ]);
    expect(taken.body.templates).toEqual([
      expect.objectContaining({ templateId, name: "Release owner" }),
    ]);

    // Reuse points at a bot chat or a template, never at a plain chat.
    const reuseBot = await callTool((await chatWithRequests(3)).server, "bot_suggest", {
      kind: "reuse",
      sessionId: bot.id,
      similarRequestsInARow: 3,
      reason: "The SRE bot already watches production.",
    });
    expect(reuseBot.body).toMatchObject({
      status: "suggested",
      kind: "reuse",
      sessionId: bot.id,
      name: "SRE bot",
      avatar: { kind: "icon", icon: "shield-check", hue: 200 },
    });
    const reuseTemplate = await callTool((await chatWithRequests(3)).server, "bot_suggest", {
      kind: "reuse",
      templateId,
      similarRequestsInARow: 3,
      reason: "Releases have a template.",
    });
    expect(reuseTemplate.body).toMatchObject({ kind: "reuse", templateId, name: "Release owner" });
    // Someone else's Only me template is never revealed or pointed at.
    const someoneElse = await bearer(workspace, "bots-someone-else", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
    ]);
    const privateTemplate = await call(
      someoneElse,
      "POST",
      `/v1/workspaces/${workspace.workspaceId}/bot-templates`,
      { name: "Private helper", setupInstructions: "Help privately.", visibility: "private" },
    );
    expect(privateTemplate.status).toBe(201);
    expect(
      (
        await callTool((await chatWithRequests(3)).server, "bot_suggest", {
          kind: "reuse",
          templateId: privateTemplate.json.template.id,
          similarRequestsInARow: 3,
          reason: "x",
        })
      ).body,
    ).toMatchObject({ status: "not_suggested", code: "not_found" });
    const refusals = await chatWithRequests(3);
    expect(
      (
        await callTool(refusals.server, "bot_suggest", {
          kind: "reuse",
          sessionId: refusals.id,
          similarRequestsInARow: 3,
          reason: "x",
        })
      ).body,
    ).toMatchObject({ code: "already_here" });
    expect(
      (
        await callTool(refusals.server, "bot_suggest", {
          kind: "reuse",
          sessionId: bot.id,
          templateId,
          similarRequestsInARow: 3,
          reason: "x",
        })
      ).body,
    ).toMatchObject({ code: "invalid_target" });

    // A chat that is already a bot is not offered one.
    expect(
      (
        await callTool(bot.server, "bot_suggest", {
          kind: "create",
          name: "Ops",
          similarRequestsInARow: 3,
          reason: "x",
        })
      ).body,
    ).toMatchObject({ code: "already_a_bot" });
  }, 180_000);
});
