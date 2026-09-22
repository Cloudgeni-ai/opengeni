import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniClient } from "@opengeni/sdk";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createWorkspace,
  createOrganizationApiKey,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  type DbClient,
} from "@opengeni/db";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerConnectionRoutes } from "../src/routes/connections";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-default-connector-accounts");
  if (!acquired) throw new Error("Workspace-default connector admission requires PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

// A `workspace_default` session tracks the current workspace defaults at run
// time; its stored tool column is only the snapshot taken at creation. The
// composer projects the current expansion and submits account selections for
// it, so a follow-up must freeze accounts against that expansion rather than
// the stale stored column.
test("a follow-up on a workspace-default session freezes the selected default connector account", async () => {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Workspace default connector admission') returning id`;
  const accountId = account!.id as string;
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, 'workspace-default-test')`;
  const workspace = await createWorkspace(db.db, {
    accountId,
    name: "Default connectors",
    externalSource: "instance:default-connectors",
    externalId: "customer",
  });
  const server = {
    id: "example-tools",
    url: "https://tools.example/mcp",
    connectionRef: {
      providerDomain: "tools.example",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    },
  };
  const permissions = organizationApiKeyPermissionsForAccess("full");
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Default connector fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
  });
  const identity = await ensureExternalIdentity(db.db, {
    accountId,
    externalId: "alice",
  });
  await grantWorkspaceAccess(db.db, {
    accountId,
    workspaceId: workspace.id,
    subjectId: identity.subjectId,
    permissions,
  });
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    sandboxBackend: "none",
    productAccessMode: "configured",
    delegationSecret: "workspace-default-connector-test-secret",
    environmentsEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
    mcpServers: [server],
  });
  const noop = async () => undefined;
  const deps = {
    db: db.db,
    settings,
    bus: new MemoryEventBus(),
    objectStorage: null,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
    },
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  registerSessionRoutes(app, deps);
  registerConnectionRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  const service = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: (input, init) => app.request(input, init),
  });
  const alice = service.asUser("alice");
  const connection = await alice.createConnection(workspace.id, {
    providerDomain: "tools.example",
    kind: "oauth2",
    ownership: "personal",
    credential: { access_token: "synthetic-alice", token_type: "Bearer" },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operationId: crypto.randomUUID(),
  });
  expect(connection.subjectId).toBe(identity.subjectId);
  const selection = [{ serverId: server.id, connectionId: connection.id }];

  const session = await alice.createSession(workspace.id, {
    startMode: "realtime",
    visibility: "workspace",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(session.toolPolicy.mode).toBe("workspace_default");
  // A connector that becomes a workspace default after the session was created
  // never enters the stored column: a workspace-default session tracks the
  // current defaults at run time, and the stored snapshot stays as it was.
  const configured = await alice.updateWorkspaceSettings(workspace.id, {
    sessionToolDefaults: { mcpServerIds: [server.id] },
  });
  expect(configured.settings.sessionToolDefaults).toEqual({
    mcpServerIds: [server.id],
  });
  const [stored] = await shared.admin`select tools from sessions where id = ${session.id}`;
  expect((stored!.tools as { id: string }[]).map((tool) => tool.id)).not.toContain(server.id);
  expect(
    (await alice.getSession(workspace.id, session.id)).effectiveToolPolicy?.effectiveIds,
  ).toContain(server.id);

  const turns = () =>
    shared.admin`select personal_connection_delegations, mcp_account_bindings
      from session_turns where session_id = ${session.id} order by created_at, id`;

  await alice.sendMessage(workspace.id, session.id, {
    text: "Read my account",
    connectionAccounts: selection,
  });
  const [accepted] = await turns();
  expect(accepted?.personal_connection_delegations).toMatchObject([
    { connectionId: connection.id, ownerSubjectId: identity.subjectId },
  ]);
  expect(accepted?.mcp_account_bindings).toMatchObject([
    { canonicalServerId: server.id, connectionId: connection.id },
  ]);
  expect(await turns()).toHaveLength(1);
}, 120_000);
