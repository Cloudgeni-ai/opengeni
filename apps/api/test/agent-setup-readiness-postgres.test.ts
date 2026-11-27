import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// A ready-made agent's triggers stay off until its required connections are
// on (real PostgreSQL, the real capability catalog): creating an active one,
// turning one on and resuming one are refused with the reason and what is
// missing, through the API, Opengeni's own tools and an admin's resume. A
// paused one can be added, and an agent without a template is never held back.

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("agent-setup-readiness");
  if (!acquired) throw new Error("Agent setup readiness tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "scheduled_tasks:run",
  "scheduled_tasks:manage",
];

type Json = Record<string, any>;

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Agent setup readiness') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [...memberPermissions, "workspace:admin", "members:manage", "account:admin"],
  });
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
    workflowClient,
    objectStorage: null,
    managedAuth: null,
    githubStateSecret: "agent-setup-readiness-state",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are not used here");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById is not used here");
    },
  };
  const app = createApp(deps as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const identity = await ensureExternalIdentity(db.db, {
    accountId,
    source,
    externalId: crypto.randomUUID(),
  });
  const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({
      identity: { source, externalId: identity.externalId },
      permissions: memberPermissions,
      operationId: crypto.randomUUID(),
    }),
  });
  expect(added.status).toBe(200);
  const owner = {
    subjectId: identity.subjectId,
    headers: {
      ...service,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({ mode: "external", identity: { source, externalId: identity.externalId } }),
      ),
    },
  };
  const root = `/v1/workspaces/${workspace.id}`;
  const call = async (
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> => {
    const response = await app.request(`${root}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : {} };
  };
  const trigger = (agentId: string, status: "active" | "paused") => ({
    name: `Trigger ${crypto.randomUUID()}`,
    status,
    schedule: { type: "interval", everySeconds: 3600 },
    runMode: "new_session_per_run",
    agentConfig: {
      agentId,
      prompt: "Review the open pull requests",
      resources: [],
      tools: [],
      metadata: {},
      sandboxBackend: "none",
    },
  });
  const mcp = async () => {
    const server = buildOpenGeniMcpServer(
      deps as unknown as ApiRouteDeps,
      {
        accountId,
        workspaceId: workspace.id,
        subjectId: owner.subjectId,
        permissions: memberPermissions,
        metadata: {},
      } as never,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent-setup-readiness-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await Promise.all([client.close(), server.close()]);
      },
    };
  };
  return { accountId, workspaceId: workspace.id, owner, service, call, trigger, mcp };
}

function expectSetupIncomplete(result: { status: number; json: Json }) {
  expect(result.status, JSON.stringify(result.json)).toBe(409);
  expect(result.json.error.details).toMatchObject({
    code: "agent_setup_incomplete",
    missing: [expect.objectContaining({ kind: "connection", provider: "github.com" })],
  });
  expect(result.json.error.message).toContain("GitHub");
}

test("a ready-made agent's trigger stays off until GitHub is connected, on every path", async () => {
  const f = await fixture();
  const added = await f.call(f.owner.headers, "POST", "/agent-templates/pr-reviewer/agents", {
    editAccess: "everyone",
  });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const reviewer = added.json.agent.id as string;

  // Creating it on is refused; creating it paused is fine.
  expectSetupIncomplete(
    await f.call(f.owner.headers, "POST", "/scheduled-tasks", f.trigger(reviewer, "active")),
  );
  const paused = await f.call(
    f.owner.headers,
    "POST",
    "/scheduled-tasks",
    f.trigger(reviewer, "paused"),
  );
  expect(paused.status, JSON.stringify(paused.json)).toBe(201);
  const taskId = paused.json.id as string;

  // Turning it on, by edit or by resume, is refused.
  expectSetupIncomplete(
    await f.call(f.owner.headers, "PATCH", `/scheduled-tasks/${taskId}`, {
      expectedExecutionDigest: paused.json.executionDigest,
      status: "active",
    }),
  );
  expectSetupIncomplete(await f.call(f.owner.headers, "POST", `/scheduled-tasks/${taskId}/resume`));
  // So is an admin turning someone else's back on.
  const adminResume = await f.call(f.service, "POST", `/scheduled-tasks/${taskId}/resume`);
  expectSetupIncomplete(adminResume);
  // Checked against the owner's connections, and says so.
  expect(adminResume.json.error.message).toBe(
    "Its owner needs to connect GitHub, or an admin can connect it for the workspace.",
  );

  // Opengeni's own tools go through the same check.
  const tools = await f.mcp();
  try {
    const result = (await tools.client.callTool({
      name: "scheduled_tasks_resume",
      arguments: { id: taskId },
    })) as { isError?: boolean; content?: { text?: string }[] };
    expect(result.isError).toBe(true);
    expect((result.content ?? []).map((entry) => entry.text ?? "").join("\n")).toContain("GitHub");
  } finally {
    await tools.close();
  }
  const still = await f.call(f.owner.headers, "GET", `/scheduled-tasks/${taskId}`);
  expect(still.json.status).toBe("paused");

  // Its readiness says the same, with the reason in words.
  const readiness = await f.call(f.owner.headers, "GET", `/agents/${reviewer}/readiness`);
  expect(readiness.status).toBe(200);
  expect(readiness.json.readiness).toMatchObject({ ready: false, requiredTotal: 1 });
  const batch = await f.call(f.owner.headers, "GET", "/agents/readiness");
  expect(batch.status).toBe(200);
  expect(batch.json.agents).toContainEqual({
    agentId: reviewer,
    readiness: expect.objectContaining({ ready: false }),
  });
});

test("Opengeni's own create tool can't add an active trigger before GitHub is connected", async () => {
  const f = await fixture();
  const added = await f.call(f.owner.headers, "POST", "/agent-templates/pr-reviewer/agents", {
    editAccess: "everyone",
  });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const reviewer = added.json.agent.id as string;
  const { status: _status, ...request } = f.trigger(reviewer, "active");
  const tools = await f.mcp();
  try {
    const result = (await tools.client.callTool({
      name: "scheduled_tasks_create",
      arguments: { ...request, status: "active" },
    })) as { isError?: boolean; content?: { text?: string }[] };
    const text = (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
    expect(result.isError, text).toBe(true);
    expect(text).toMatch(/connect GitHub/i);
  } finally {
    await tools.close();
  }
  // Nothing was added.
  const listed = await f.call(f.owner.headers, "GET", "/scheduled-tasks");
  expect(JSON.stringify(listed.json)).not.toContain(reviewer);
});

test("an agent without a template is never held back", async () => {
  const f = await fixture();
  const created = await f.call(f.owner.headers, "POST", "/agents", { name: "Planner" });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const on = await f.call(
    f.owner.headers,
    "POST",
    "/scheduled-tasks",
    f.trigger(created.json.agent.id, "active"),
  );
  expect(on.status, JSON.stringify(on.json)).toBe(201);
  expect(on.json.status).toBe("active");
});

test("Ask an admin asks the workspace's admins once, in their inbox, once the database allows it", async () => {
  const f = await fixture();
  const routine =
    "opengeni_private.request_setup_connection_v1(uuid, uuid, text, text, text, text)";
  const returnPath = `/workspaces/${f.workspaceId}/enable?agent=pr-reviewer&step=connect`;
  const ask = (body: Record<string, unknown> = {}) =>
    f.call(f.owner.headers, "POST", "/setup-connection-requests", {
      provider: "github.com",
      name: "GitHub",
      returnPath,
      ...body,
    });
  const notices = async () =>
    await shared.admin<{ recipient: string; title: string; url: string; sender: string }[]>`
      select recipient_subject_id as recipient, title, link->>'url' as url,
        sender_subject_id as sender
      from opengeni_private.inbox_items
      where workspace_id = ${f.workspaceId}::uuid and source_key like 'setup-request:%'
      order by recipient_subject_id`;
  const admin = `user:${crypto.randomUUID()}`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${f.accountId}::uuid, ${f.workspaceId}::uuid, ${admin}, 'admin', '[]'::jsonb)`;
  // An organization admin with no grant in this workspace is asked too.
  const orgAdmin = `user:${crypto.randomUUID()}`;
  const [orgAdminPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${f.accountId}::uuid, 'Personal org admin') returning id`;
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${orgAdminPersonal!.id}::uuid, ${f.accountId}::uuid)`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
    values (${f.accountId}::uuid, ${orgAdmin}, 'active', 'admin', ${orgAdminPersonal!.id}::uuid)`;
  const recipients = [admin, orgAdmin].sort();

  const appRole = decodeURIComponent(new URL(shared.appUrl).username);
  try {
    // Withheld, as 1599 left it until 1679: nobody is asked, and the page shares a link.
    await shared.admin.unsafe(`revoke execute on function ${routine} from "${appRole}"`);
    const before = await ask();
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    expect(before.json).toEqual({ status: "unavailable", adminsAsked: 0 });
    expect(await notices()).toEqual([]);
    await shared.admin.unsafe(`grant execute on function ${routine} to "${appRole}"`);

    // The admins are asked, never the person asking, with the template's name
    // for it; asking again while it's open asks no one twice.
    expect((await ask({ name: "Something else" })).json).toEqual({
      status: "requested",
      adminsAsked: 2,
    });
    expect((await ask()).json).toEqual({ status: "already_asked", adminsAsked: 0 });
    expect(await notices()).toEqual(
      recipients.map((recipient) => ({
        recipient,
        title: "Connect GitHub",
        url: returnPath,
        sender: f.owner.subjectId,
      })),
    );
    // A settled notice reopens only a day after it was settled.
    await shared.admin`
      update opengeni_private.inbox_items set status = 'resolved', resolved_at = now()
      where workspace_id = ${f.workspaceId}::uuid and source_key like 'setup-request:%'`;
    expect((await ask()).json).toEqual({ status: "already_asked", adminsAsked: 0 });
    await shared.admin`
      update opengeni_private.inbox_items set resolved_at = now() - interval '2 days'
      where workspace_id = ${f.workspaceId}::uuid and source_key like 'setup-request:%'`;
    expect((await ask()).json).toEqual({ status: "requested", adminsAsked: 2 });
    // Only an Enable step in this workspace.
    const elsewhere = await ask({ returnPath: "/workspaces/other/enable?agent=pr-reviewer" });
    expect(elsewhere.status).toBe(400);
    const external = await ask({ returnPath: "https://example.test/phish" });
    expect(external.status).toBe(400);
    // Only a connection some ready-made agent needs.
    const unknown = await ask({ provider: "example.com", name: "Example" });
    expect(unknown.status).toBe(400);

    // The routine trusts only the transaction's own scope: another account or
    // workspace than the scope names, or a requester outside the workspace,
    // asks nobody (-1, "unavailable": the page shares a link). The requester is always the scope's subject.
    const direct = async (
      settings: { account: string; workspace: string; subject: string },
      target = { workspace: f.workspaceId, link: returnPath },
    ) =>
      await shared.admin.begin(async (tx) => {
        await tx.unsafe(`set local role "${appRole.replaceAll('"', '""')}"`);
        await tx`select set_config('opengeni.account_id', ${settings.account}, true),
          set_config('opengeni.workspace_id', ${settings.workspace}, true),
          set_config('opengeni.subject_id', ${settings.subject}, true)`;
        const [row] = await tx<{ asked: number }[]>`
          select opengeni_private.request_setup_connection_v1(
            ${f.accountId}::uuid, ${target.workspace}::uuid, 'Someone', 'slack.com', 'Slack',
            ${target.link}) as asked`;
        return Number(row!.asked);
      });
    const otherWorkspace = await createWorkspace(db.db, {
      accountId: f.accountId,
      name: "Other workspace",
    });
    expect(
      await direct({
        account: f.accountId,
        workspace: otherWorkspace.id,
        subject: f.owner.subjectId,
      }),
    ).toBe(-1);
    expect(
      await direct({
        account: crypto.randomUUID(),
        workspace: f.workspaceId,
        subject: f.owner.subjectId,
      }),
    ).toBe(-1);
    expect(
      await direct({
        account: f.accountId,
        workspace: f.workspaceId,
        subject: `user:${crypto.randomUUID()}`,
      }),
    ).toBe(-1);
    // A Personal workspace has no admin to ask.
    expect(
      await direct(
        { account: f.accountId, workspace: orgAdminPersonal!.id, subject: orgAdmin },
        {
          workspace: orgAdminPersonal!.id,
          link: `/workspaces/${orgAdminPersonal!.id}/enable?agent=pr-reviewer&step=connect`,
        },
      ),
    ).toBe(-1);
    expect((await notices()).filter((notice) => notice.title === "Connect Slack")).toEqual([]);

    // The same request in another workspace is its own notice; it never
    // overwrites the first one.
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${f.accountId}::uuid, ${otherWorkspace.id}::uuid, ${f.owner.subjectId})`;
    const otherLink = `/workspaces/${otherWorkspace.id}/enable?agent=pr-reviewer&step=connect`;
    const inWorkspace = (workspace: string) => ({
      account: f.accountId,
      workspace,
      subject: f.owner.subjectId,
    });
    expect(
      await direct(inWorkspace(otherWorkspace.id), {
        workspace: otherWorkspace.id,
        link: otherLink,
      }),
    ).toBe(1);
    expect(await direct(inWorkspace(f.workspaceId))).toBe(2);
    const slack = await shared.admin<{ workspace: string; url: string }[]>`
      select workspace_id::text as workspace, link->>'url' as url
      from opengeni_private.inbox_items
      where recipient_subject_id = ${orgAdmin} and title = 'Connect Slack'`;
    const byUrl = (left: { url: string }, right: { url: string }) =>
      left.url < right.url ? -1 : left.url > right.url ? 1 : 0;
    expect([...slack].sort(byUrl)).toEqual(
      [
        { workspace: otherWorkspace.id, url: otherLink },
        { workspace: f.workspaceId, url: returnPath },
      ].sort(byUrl),
    );

    // A burst is cut off: five at once per person and workspace, then one a minute.
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await ask()).status);
    expect(statuses).toContain(429);
  } finally {
    // The migrated database grants it (1679); leave it granted.
    await shared.admin.unsafe(`grant execute on function ${routine} to "${appRole}"`);
  }
});
