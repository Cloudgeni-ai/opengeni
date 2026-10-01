import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { OpenGeni } from "../../../packages/sdk/src/chat";
import { uuidV5 } from "../../../packages/sdk/src/chat/ids";
import { OpenGeniClient } from "../../../packages/sdk/src/client";
import { OpenGeniEmbeddingClient } from "../../../packages/sdk/src/embedding-client";
import { OpenGeniApiError, OpenGeniSetupError } from "../../../packages/sdk/src/errors";
import { createSessionProxyHandler } from "../../../packages/sdk/src/session-proxy";
import { createApp, type AppDependencies } from "../src/app";

let shared: SharedTestDatabase;
let db: DbClient;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_APP_URL;
  if ((adminUrl === undefined) !== (appUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL and OPENGENI_ORG_TENANCY_POSTGRES_APP_URL",
    );
  }
  if (adminUrl && appUrl) {
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => await admin.end(),
    };
  } else {
    const acquired = await acquireSharedTestDatabase("session-proxy-chats");
    if (!acquired) throw new Error("Session proxy chats tests require real PostgreSQL");
    shared = acquired;
  }
  db = createDb(shared.appUrl, { max: 4 });
  const probe = postgres(shared.appUrl, { max: 1 });
  try {
    const [role] = await probe<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  } finally {
    await probe.end();
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
  await shared?.release();
}, 60_000);

const noop = async () => undefined;
const productUrl = "https://product.example.test/api/opengeni";

async function fixture(privateSessionsEnabled: boolean) {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('SDK chats proxy fixture') returning id`;
  const accountId = account!.id;
  const workspace = await createWorkspace(db.db, { accountId, name: "Customer workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "SDK chats organization key",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "members:manage",
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "account:admin",
      "workspace:create",
      "files:upload",
      "files:read",
      "mcp_servers:attach",
    ],
  });
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      sandboxBackend: "none",
    }),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const fetch: typeof globalThis.fetch = async (input, init) =>
    await app.fetch(new Request(input, init));
  const service = new OpenGeniEmbeddingClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch,
  });
  const source = "sdk-chats:instance";
  const owner = await ensureExternalIdentity(db.db, {
    accountId,
    source,
    externalId: crypto.randomUUID(),
  });
  const other = await ensureExternalIdentity(db.db, {
    accountId,
    source,
    externalId: crypto.randomUUID(),
  });
  for (const identity of [owner, other]) {
    await service.addExternalWorkspaceMember(workspace.id, {
      identity: { externalId: identity.externalId, source },
      permissions: ["workspace:read", "sessions:read", "sessions:create", "sessions:control"],
      operationId: crypto.randomUUID(),
    });
  }
  // Operator readiness and the owner/admin product setting are separate gates.
  // Keep readiness present in both fixtures so the denial specifically tests
  // the organization setting, not a database activation failure.
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'session-proxy-chats-test')`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${accountId}, ${privateSessionsEnabled}, 1, null)
    on conflict (account_id) do update set enabled = excluded.enabled`;

  const handler = createSessionProxyHandler(service, {
    chats: "private",
    resolve: () => ({ workspaceId: workspace.id, user: owner.externalId, source }),
    createSession: (input) => ({ ...input, model: "scripted-model" }),
  });
  const browser = new OpenGeniClient({
    baseUrl: productUrl,
    fetch: async (input, init) => await handler(new Request(input, init)),
  });
  const endpoint = `${productUrl}/v1/workspaces/${workspace.id}/sessions`;
  const facadeOptions = {
    apiKey: token,
    organizationId: accountId,
    source,
    baseUrl: "http://fixture",
    fetch,
  };
  return {
    accountId,
    workspace,
    service,
    source,
    owner,
    other,
    handler,
    browser,
    endpoint,
    facadeOptions,
  };
}

test("isolated users can create, read and send with a host per-session MCP server, never administer", async () => {
  const f = await fixture(true);
  const og = new OpenGeni(f.facadeOptions);
  const tenant = crypto.randomUUID();
  const workspaceId = await og.workspaceIdFor(
    { tenant, user: f.owner.externalId },
    { isolation: "user" },
  );
  const server = { id: "host-tools", url: "https://product.example.test/mcp" };
  const handler = createSessionProxyHandler(og, {
    chats: "isolated",
    resolve: () => ({ tenant, user: f.owner.externalId }),
    createSession: (input) => ({ ...input, model: "scripted-model", mcpServers: [server] }),
  });
  const browser = new OpenGeniClient({
    baseUrl: productUrl,
    fetch: async (input, init) => await handler(new Request(input, init)),
  });
  const session = await browser.createSession(workspaceId, {
    initialMessage: "Use the host's tools",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(await browser.getSession(workspaceId, session.id)).toMatchObject({
    id: session.id,
    mcpServers: [server],
    tools: [{ kind: "mcp", id: server.id }],
    tenancy: { visibility: "private", ownedByCurrentUser: true },
  });
  const [stored] = await shared.admin`
    select server_id, url from session_mcp_servers
    where workspace_id = ${workspaceId} and session_id = ${session.id}`;
  expect(stored).toEqual({ server_id: server.id, url: server.url });
  expect(await browser.sendMessage(workspaceId, session.id, "Read my app data")).toMatchObject({
    type: "user.message",
  });
  await expect(
    og.client.asUser(f.owner.externalId, { source: f.source }).listApiKeys(workspaceId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    og.client.asUser(f.other.externalId, { source: f.source }).getSession(workspaceId, session.id),
  ).rejects.toMatchObject({ status: 403 });
}, 60_000);

test("custom isolated member permissions can deny MCP attachment without denying ordinary chat", async () => {
  const f = await fixture(true);
  const og = new OpenGeni({
    ...f.facadeOptions,
    memberPermissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
  });
  const workspaceId = await og.workspaceIdFor(
    { tenant: crypto.randomUUID(), user: f.owner.externalId },
    { isolation: "user" },
  );
  const actor = og.client.asUser(f.owner.externalId, { source: f.source });
  await expect(
    actor.createSession(workspaceId, {
      initialMessage: "Tools are disabled for this user",
      model: "scripted-model",
      mcpServers: [{ id: "host-tools", url: "https://product.example.test/mcp" }],
    }),
  ).rejects.toMatchObject({ status: 403 });
  const session = await actor.createSession(workspaceId, {
    initialMessage: "Ordinary chat is allowed",
    model: "scripted-model",
  });
  expect(await actor.getSession(workspaceId, session.id)).toMatchObject({ id: session.id });
}, 60_000);

/** Seed persisted withdrawal/cancellation, not the separate revoke lifecycle.
 * Keep its immutable grant receipt and native RLS/triggers intact. */
async function seedGrantCancellation(
  f: Awaited<ReturnType<typeof fixture>>,
  workspaceId: string,
  grantOperationId: string,
) {
  const operationId = crypto.randomUUID();
  const command = {
    organizationId: f.accountId,
    workspaceId,
    membershipId: f.owner.organizationMembershipId,
    action: "revoke",
    operationId,
    cancelGrantOperationId: grantOperationId,
  };
  await shared.admin.begin(async (tx) => {
    const removed = await tx`delete from workspace_memberships
      where account_id = ${f.accountId} and workspace_id = ${workspaceId}
        and subject_id = ${f.owner.subjectId} returning id`;
    await tx`insert into organization_workspace_operation_receipts
      (account_id, operation_id, action, input_hash, result)
      values (${f.accountId}, ${operationId}, 'revoke',
        encode(sha256(convert_to(${tx.json(command)}::jsonb::text, 'UTF8')), 'hex'),
        ${tx.json({ workspaceId, removed: removed.length > 0, replay: false, fencedGrantOperationId: grantOperationId })})`;
  });
}

test.each([
  [
    "old defaults",
    [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "files:upload",
      "files:read",
    ],
  ],
  [
    "custom permissions",
    ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
  ],
] as const)(
  "changed onboarding options preserve %s, including persisted reduction and withdrawal",
  async (_label, permissions) => {
    const f = await fixture(true);
    const target = { tenant: crypto.randomUUID(), user: f.owner.externalId };
    const original = new OpenGeni({ ...f.facadeOptions, memberPermissions: permissions });
    const workspaceId = await original.workspaceIdFor(target, { isolation: "user" });
    const resolveAgain = () =>
      new OpenGeni(f.facadeOptions).workspaceIdFor(target, { isolation: "user" });
    expect(await resolveAgain()).toBe(workspaceId);
    const members = () => f.service.listWorkspaceMembers(workspaceId);
    expect((await members()).map((member) => member.permissions)).toEqual([
      [...permissions].sort(),
    ]);
    await f.service.updateExternalWorkspaceMember(
      f.accountId,
      workspaceId,
      f.owner.organizationMembershipId,
      {
        permissions: ["workspace:read"],
        operationId: crypto.randomUUID(),
      },
    );
    expect(await resolveAgain()).toBe(workspaceId);
    expect((await members()).map((member) => member.permissions)).toEqual([["workspace:read"]]);
    const actor = f.service.asUser(f.owner.externalId, { source: f.source });
    await expect(
      actor.createSession(workspaceId, {
        initialMessage: "No longer allowed",
        model: "scripted-model",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const grantOperationId = await uuidV5(
      JSON.stringify(["member", workspaceId, f.source, target.user]),
      "fc398712-b4db-5b0b-8842-57cb4f2a65f9",
    );
    await seedGrantCancellation(f, workspaceId, grantOperationId);
    expect(await resolveAgain()).toBe(workspaceId);
    expect(await members()).toEqual([]);
    await expect(actor.getWorkspace(workspaceId)).rejects.toMatchObject({ status: 403 });
  },
  60_000,
);

test("a persisted cancellation before the first isolated grant remains fenced after permission changes", async () => {
  const f = await fixture(true);
  const target = { tenant: crypto.randomUUID(), user: f.owner.externalId };
  const namespace = "fc398712-b4db-5b0b-8842-57cb4f2a65f9";
  const key = JSON.stringify(["user", f.source, f.source, target.tenant, target.user]);
  const { workspace } = await f.service.ensureWorkspace({
    accountId: f.accountId,
    externalSource: `opengeni-sdk:user-isolation:${await uuidV5(f.source, namespace)}`,
    externalId: await uuidV5(key, namespace),
    name: target.tenant,
  });
  await seedGrantCancellation(
    f,
    workspace.id,
    await uuidV5(JSON.stringify(["member", workspace.id, f.source, target.user]), namespace),
  );
  const og = new OpenGeni(f.facadeOptions);
  expect(await og.workspaceIdFor(target, { isolation: "user" })).toBe(workspace.id);
  expect(await f.service.listWorkspaceMembers(workspace.id)).toEqual([]);
  await expect(
    og.client.asUser(target.user, { source: f.source }).createSession(workspace.id, {
      initialMessage: "The cancelled user is still denied",
      model: "scripted-model",
    }),
  ).rejects.toMatchObject({ status: 403 });
}, 60_000);

test("chats: private creates an external asUser-owned user_private session through the proxy", async () => {
  const f = await fixture(true);
  const response = await f.handler(
    new Request(f.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "Private SDK chat",
        idempotencyKey: crypto.randomUUID(),
      }),
    }),
  );
  expect(response.status).toBe(200);
  const created = (await response.json()) as { id: string };
  const [stored] = await shared.admin`
    select visibility, owner_subject_id, owner_organization_membership_id,
      created_by_kind, created_by_subject_id, agent_access, memory_scope
    from sessions where account_id = ${f.accountId} and workspace_id = ${f.workspace.id}
      and id = ${created.id}`;
  expect(stored).toMatchObject({
    visibility: "user_private",
    owner_subject_id: f.owner.subjectId,
    owner_organization_membership_id: f.owner.organizationMembershipId,
    created_by_kind: "subject",
    created_by_subject_id: f.owner.subjectId,
    agent_access: "session",
    memory_scope: "user",
  });
  expect(await f.browser.getSession(f.workspace.id, created.id)).toMatchObject({
    id: created.id,
    tenancy: { visibility: "private", ownedByCurrentUser: true },
  });
  await expect(
    f.service
      .asUser(f.other.externalId, { source: f.source })
      .getSession(f.workspace.id, created.id),
  ).rejects.toMatchObject({ status: 404 });
}, 60_000);

test("a disabled organization private-chat setting returns actionable OpenGeniSetupError JSON", async () => {
  const f = await fixture(false);
  const response = await f.handler(
    new Request(f.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "Private SDK chat requires setup",
        idempotencyKey: crypto.randomUUID(),
      }),
    }),
  );
  expect(response.status).toBe(409);
  expect(response.headers.get("content-type")).toContain("application/json");
  const payload = (await response.json()) as { error: { code: string; message: string } };
  expect(payload.error.code).toBe("OPENGENI_SETUP_REQUIRED");
  expect(payload.error.message).toMatch(/setting[\s\S]*enabled|enable[\s\S]*setting/i);
  expect(payload.error.message).toMatch(/owner or admin/i);
  expect(payload.error.message).toContain("PATCH /v1/organizations");
  expect(payload.error.message).toContain("@opengeni/sdk/");
  expect(payload.error.message).toMatch(/web app/i);

  let failure: unknown;
  try {
    await f.browser.createSession(f.workspace.id, {
      initialMessage: "Private SDK chat requires setup",
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OpenGeniSetupError);
  expect(failure).toBeInstanceOf(OpenGeniApiError);
  expect(failure).toMatchObject({
    status: 409,
    code: "OPENGENI_SETUP_REQUIRED",
    retryable: false,
  });
  for (const guidance of [
    "organization_private_session_settings.enabled",
    "owner or admin",
    "PATCH /v1/organizations",
    "@opengeni/sdk/",
    "web app",
  ]) {
    expect((failure as Error).message).toContain(guidance);
  }
  const [count] = await shared.admin`
    select count(*)::int as sessions from sessions where workspace_id = ${f.workspace.id}`;
  expect(count).toEqual({ sessions: 0 });
}, 60_000);
