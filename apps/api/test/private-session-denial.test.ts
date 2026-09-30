import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("private-session-denial");
  if (!acquired) throw new Error("Private session denial requires real PostgreSQL");
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
    await shared.admin`insert into managed_accounts (name) values ('Private session fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Customer workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "members:manage",
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "account:admin",
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
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
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
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const identity of [owner, other]) {
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions: ["workspace:read", "sessions:read", "sessions:create", "sessions:control"],
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
  }
  const asUser = (identity: { externalId: string }) => ({
    ...service,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source, externalId: identity.externalId } }),
    ),
  });
  // Test-only activation fixture (the operator path is covered elsewhere).
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'private-session-denial-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const session = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    createSession(db.db, {
      accountId,
      workspaceId: workspace.id,
      initialMessage: "Private work",
      resources: [],
      metadata: {},
      visibility: "user_private",
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      subjectId: owner.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  const sharedWork = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    createSession(db.db, {
      accountId,
      workspaceId: workspace.id,
      initialMessage: "Shared work",
      resources: [],
      metadata: {},
      visibility: "workspace_shared",
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      subjectId: owner.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  return {
    app,
    workspace,
    session,
    sharedSession: sharedWork,
    owner: asUser(owner),
    other: asUser(other),
  };
}

test("another member's private session is indistinguishable from a missing one", async () => {
  const f = await fixture();
  const missing = crypto.randomUUID();
  const routes: Array<[string, string, unknown?]> = [
    ["GET", ""],
    ["GET", "/events"],
    ["GET", "/events/stream"],
    ["GET", "/queue"],
    ["GET", "/turns"],
    ["GET", "/goal"],
    ["GET", "/lineage"],
    ["GET", "/composer-draft"],
    ["GET", "/human-input-requests"],
    ["POST", "/events", { type: "user.message", payload: { text: "hello" } }],
    ["POST", "/steer", { text: "hello" }],
    ["POST", "/control", { action: "pause", clientEventId: crypto.randomUUID() }],
    ["PUT", "/composer-draft", { text: "draft" }],
    ["GET", "/model-context"],
    ["GET", "/background-commands"],
    ["GET", "/codex-accounts"],
    ["GET", "/stream-capabilities"],
    ["GET", "/sandbox-recovery"],
    ["GET", "/goal/revisions"],
    ["POST", "/context/clear", {}],
    ["POST", "/retry", {}],
    ["PUT", "/attention", { unread: false }],
    ["PUT", "/archive", { archived: true }],
    ["POST", "/fs/list", { path: "/" }],
    ["PATCH", "", { title: "renamed" }],
    ["PUT", "/pin", { pinned: true }],
    ["DELETE", ""],
  ];
  const statuses: Record<string, [number, number]> = {};
  for (const [method, suffix, body] of routes) {
    const request = async (sessionId: string) =>
      await f.app.request(`/v1/workspaces/${f.workspace.id}/sessions/${sessionId}${suffix}`, {
        method,
        headers: f.other,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const denied = await request(f.session.id);
    const absent = await request(missing);
    statuses[`${method} ${suffix || "/"}`] = [denied.status, absent.status];
  }
  for (const [route, [denied, absent]] of Object.entries(statuses)) {
    expect({ route, denied }).toEqual({ route, denied: 404 });
    expect({ route, absent }).toEqual({ route, absent: 404 });
  }
  // The owner still reaches it, and the other member still reaches shared work.
  for (const suffix of ["", "/queue", "/composer-draft"]) {
    const own = await f.app.request(
      `/v1/workspaces/${f.workspace.id}/sessions/${f.session.id}${suffix}`,
      { headers: f.owner },
    );
    expect({ suffix, status: own.status }).toEqual({ suffix, status: 200 });
    const peer = await f.app.request(
      `/v1/workspaces/${f.workspace.id}/sessions/${f.sharedSession.id}${suffix}`,
      { headers: f.other },
    );
    expect({ suffix, status: peer.status }).toEqual({ suffix, status: 200 });
  }
});
