import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Permission, Session } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  getSession,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

let shared: SharedTestDatabase | null;
let client: DbClient;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-retention-api");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Session retention API tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(
  permissions: Permission[] = [
    "workspace:read",
    "sessions:read",
    "sessions:control",
    "sessions:create",
  ],
) {
  if (!shared) throw new Error("PostgreSQL unavailable");
  const [account] = await shared.admin`
    insert into managed_accounts (name) values ('Retention API fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(client.db, {
    accountId,
    name: "Retention",
    externalSource: "retention-api",
    externalId: crypto.randomUUID(),
  });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Retention service",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
  });
  const deps = {
    db: client.db,
    bus: new MemoryEventBus(),
    managedAuth: null,
    settings: testSettings({ productAccessMode: "managed", sandboxBackend: "none" }),
    workflowClient: new Proxy(
      {},
      {
        get() {
          throw new Error("Retention changes must not invoke Temporal");
        },
      },
    ),
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspace.id,
    initialMessage: "persistent agent",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  return {
    app: createApp(deps),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    sessionPath: `/v1/workspaces/${workspace.id}/sessions/${session.id}`,
    sessionId: session.id,
    workspaceId: workspace.id,
  };
}

describe("session retention API", () => {
  test("keep-live is a workspace session setting visible on the session", async () => {
    if (!shared) return;
    const f = await fixture();
    const kept = await f.app.request(`${f.sessionPath}/retention`, {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify({ keepLive: true }),
    });
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect(((await kept.json()) as Session).retention).toEqual({ keepLive: true, archive: null });

    const [stored] = await shared.admin`select keep_live from sessions where id = ${f.sessionId}`;
    expect(stored!.keep_live).toBe(true);
    const cleared = await f.app.request(`${f.sessionPath}/retention`, {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify({ keepLive: false }),
    });
    expect(((await cleared.json()) as Session).retention).toEqual({
      keepLive: false,
      archive: null,
    });

    const invalid = await f.app.request(`${f.sessionPath}/retention`, {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify({ keepLive: "yes" }),
    });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.status).toBeLessThan(500);
  }, 60_000);

  test("changing keep-live requires session control", async () => {
    if (!shared) return;
    const f = await fixture(["workspace:read", "sessions:read"]);
    const denied = await f.app.request(`${f.sessionPath}/retention`, {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify({ keepLive: true }),
    });
    expect(denied.status).toBe(403);
  }, 60_000);

  test("an archived session is read-only: sends and retention changes return 409", async () => {
    if (!shared) return;
    const f = await fixture();
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set content_archive_state = 'archived',
          content_archive_started_at = now(), content_archived_at = now(),
          content_archive = ${sql.json({ sha256: "a".repeat(64), objectKeys: [] })}
        where id = ${f.sessionId}`;
    });
    const session = await getSession(client.db, String(f.workspaceId), f.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");

    const retention = await f.app.request(`${f.sessionPath}/retention`, {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify({ keepLive: true }),
    });
    expect(retention.status).toBe(409);
    expect(await retention.json()).toMatchObject({ code: "SESSION_ARCHIVED_READ_ONLY" });

    for (const [suffix, body] of [
      ["events", { type: "user.message", payload: { text: "are you there?" } }],
      ["steer", { text: "are you there?" }],
    ] as const) {
      const denied = await f.app.request(`${f.sessionPath}/${suffix}`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify(body),
      });
      expect(denied.status, await denied.clone().text()).toBe(409);
      expect(await denied.json()).toMatchObject({ code: "SESSION_ARCHIVED_READ_ONLY" });
    }
  }, 60_000);
});
