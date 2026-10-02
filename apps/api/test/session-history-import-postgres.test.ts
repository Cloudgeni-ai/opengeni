import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  AppendArchivedSessionEventsResponse,
  ImportArchivedSessionResponse,
  Permission,
  SessionEvent,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { createDb, createOrganizationApiKey, createWorkspace, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Hono } from "hono";
import { createApp } from "../src/app";

let shared: SharedTestDatabase | null;
let client: DbClient;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-history-import-api");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Session history import API tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(permissions: Permission[] = ["workspace:admin", "members:manage"]) {
  if (!shared) throw new Error("PostgreSQL unavailable");
  const [account] = await shared.admin`
    insert into managed_accounts (name) values ('History import API fixture') returning id`;
  const accountId = String(account!.id);
  const externalId = crypto.randomUUID();
  const workspace = await createWorkspace(client.db, {
    accountId,
    name: "Archived conversations",
    externalSource: "history-import-api",
    externalId,
  });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "History migration service",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
  });
  const bus = new MemoryEventBus();
  const deps = {
    db: client.db,
    bus,
    managedAuth: null,
    settings: testSettings({ productAccessMode: "managed", sandboxBackend: "none" }),
    workflowClient: new Proxy(
      {},
      {
        get() {
          throw new Error("Archive imports must not invoke Temporal");
        },
      },
    ),
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const app = createApp(deps);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `/v1/workspaces/${workspace.id}/session-imports`;
  const externalBase = `/v1/workspaces/external/history-import-api/${externalId}/session-imports`;
  return { app, accountId, workspace, headers, base, externalBase, bus };
}
function post(app: Hono, path: string, headers: Record<string, string>, body: unknown) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}
const createdAt = "2021-06-15T12:34:56.000Z";
const initialEvent = {
  type: "user.message" as const,
  createdAt,
  payload: { text: "Original question 🐾", untouched: { nested: [1, true, null] } },
};
const answerEvent = {
  type: "agent.message.completed" as const,
  createdAt: "2021-06-15T12:35:00.000Z",
  payload: { text: "Original answer", modelContext: "Source context, not runnable input" },
};

describe("archived import API with durable PostgreSQL history", () => {
  test("a create-only integration key imports without read authority but cannot append", async () => {
    if (!shared) return;
    const f = await fixture(["sessions:create"]);
    const request = { importId: "least-privilege", title: "Imported history", createdAt };
    const created = await post(f.app, f.base, f.headers, request);
    expect(created.status, await created.clone().text()).toBe(201);
    const imported = (await created.json()) as ImportArchivedSessionResponse;
    expect(imported).toMatchObject({ created: true, nextOffset: 0 });
    const appended = await post(f.app, `${f.externalBase}/least-privilege/events`, f.headers, {
      batchId: "first",
      offset: 0,
      events: [initialEvent],
    });
    expect(appended.status, await appended.clone().text()).toBe(403);
    expect(await appended.json()).toMatchObject({
      error: { status: 403, code: "forbidden", retryable: false },
    });
  }, 60_000);

  test("native/external retries share one import and append receipt; normal event GET retains source facts", async () => {
    if (!shared) return;
    const f = await fixture();
    const request = {
      importId: "source/thread",
      title: "Past conversation",
      createdAt,
      events: [initialEvent],
    };
    const first = await post(f.app, f.base, f.headers, request);
    expect(first.status, await first.clone().text()).toBe(201);
    const imported = (await first.json()) as ImportArchivedSessionResponse;
    expect(imported).toMatchObject({ importId: request.importId, created: true, nextOffset: 1 });
    expect(imported.session).toMatchObject({
      createdAt,
      importedArchive: { importId: request.importId, readOnly: true },
    });
    const replay = await post(f.app, f.externalBase, f.headers, request);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({
      session: { id: imported.session.id },
      created: false,
      nextOffset: 1,
    });
    const batch = { batchId: "batch/one", offset: 1, events: [answerEvent] };
    const suffix = `/${encodeURIComponent(request.importId)}/events`;
    const appended = await post(f.app, `${f.externalBase}${suffix}`, f.headers, batch);
    expect(appended.status, await appended.clone().text()).toBe(200);
    expect(await appended.json()).toEqual({
      sessionId: imported.session.id,
      importId: request.importId,
      nextOffset: 2,
      replayed: false,
    } satisfies AppendArchivedSessionEventsResponse);
    const appendReplay = await post(f.app, `${f.base}${suffix}`, f.headers, batch);
    expect(appendReplay.status, await appendReplay.clone().text()).toBe(200);
    expect(await appendReplay.json()).toMatchObject({ nextOffset: 2, replayed: true });
    const eventsResponse = await f.app.request(
      `/v1/workspaces/${f.workspace.id}/sessions/${imported.session.id}/events?mode=forensic&payloadMode=full`,
      { headers: f.headers },
    );
    expect(eventsResponse.status, await eventsResponse.clone().text()).toBe(200);
    const events = (await eventsResponse.json()) as SessionEvent[];
    expect(
      events.map(({ type, occurredAt: at, payload: data }) => ({
        type,
        createdAt: at,
        payload: data,
      })),
    ).toEqual([initialEvent, answerEvent]);
    expect(events.map((entry) => entry.sequence)).toEqual([1, 2]);
    const [durable] = await shared.admin`
      select created_by_subject_id, owner_organization_membership_id, visibility
      from sessions where id=${imported.session.id}`;
    expect(durable).toMatchObject({
      owner_organization_membership_id: null,
      visibility: "workspace_shared",
    });
    const [execution] = await shared.admin`
      select (select count(*)::int from session_turns where session_id=${imported.session.id}) as turns,
             (select count(*)::int from session_history_items where session_id=${imported.session.id}) as history,
             (select count(*)::int from session_workflow_wake_outbox where session_id=${imported.session.id}) as wakes`;
    expect(execution).toEqual({ turns: 0, history: 0, wakes: 0 });
  }, 60_000);

  test("asUser owns private imports; another actor cannot append or distinguish missing imports", async () => {
    if (!shared) return;
    const f = await fixture();
    await shared.admin`
      insert into session_tenancy_activations (account_id,activation_version,inventory_digest,parity_digest,activated_by)
      values (${f.accountId},1,${"1".repeat(64)},${"2".repeat(64)},'history-import-api-test')`;
    await shared.admin`
      insert into organization_private_session_settings (account_id,enabled,version)
      values (${f.accountId},true,1)`;
    const actorHeaders = async (name: string) => {
      const identity = { source: "history-import-api", externalId: name };
      const added = await post(
        f.app,
        `/v1/workspaces/${f.workspace.id}/external-members`,
        f.headers,
        {
          identity,
          permissions: ["workspace:read", "sessions:read", "sessions:create", "sessions:control"],
          operationId: crypto.randomUUID(),
        },
      );
      expect(added.status, await added.clone().text()).toBe(200);
      return {
        ...f.headers,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity }),
        ),
      };
    };
    const owner = await actorHeaders("owner");
    const other = await actorHeaders("other");
    const request = {
      importId: "private-thread",
      title: "Private history",
      createdAt,
      visibility: "user_private",
      events: [initialEvent],
    };
    const response = await post(f.app, f.externalBase, owner, request);
    expect(response.status, await response.clone().text()).toBe(201);
    const imported = (await response.json()) as ImportArchivedSessionResponse;
    const [durable] = await shared.admin`
      select s.created_by_subject_id, s.owner_organization_membership_id, s.visibility, m.subject_id
      from sessions s join organization_memberships m on m.id=s.owner_organization_membership_id
      where s.id=${imported.session.id}`;
    expect(durable!.visibility).toBe("user_private");
    expect(durable!.created_by_subject_id).toBe(durable!.subject_id);
    const append = { batchId: "private-batch", offset: 1, events: [answerEvent] };
    const known = await post(f.app, `${f.base}/private-thread/events`, other, append);
    const missing = await post(f.app, `${f.base}/missing-thread/events`, other, append);
    expect(known.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await known.json()).toEqual(await missing.json());
    expect((await post(f.app, `${f.base}/private-thread/events`, owner, append)).status).toBe(200);
    const forbiddenPrivate = await post(f.app, f.base, f.headers, {
      ...request,
      importId: "ownerless-private",
    });
    expect(forbiddenPrivate.status).toBe(403);
    const hiddenReplay = await post(f.app, f.base, other, request);
    expect(hiddenReplay.status, await hiddenReplay.clone().text()).toBe(404);
    const hiddenBody = await hiddenReplay.text();
    expect(hiddenBody).not.toContain(imported.session.id);
    expect(JSON.parse(hiddenBody)).toEqual({
      code: "SESSION_IMPORT_NOT_FOUND",
      message: "Imported session not found.",
    });
  }, 60_000);

  test("Send and Steer cannot make archived imports executable", async () => {
    if (!shared) return;
    const f = await fixture();
    const response = await post(f.app, f.base, f.headers, {
      importId: "readonly-thread",
      title: "Read only",
      createdAt,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const imported = (await response.json()) as ImportArchivedSessionResponse;
    const sessionPath = `/v1/workspaces/${f.workspace.id}/sessions/${imported.session.id}`;
    for (const [suffix, body] of [
      ["events", { type: "user.message", payload: { text: "must not execute" } }],
      ["steer", { text: "must not execute" }],
    ] as const) {
      const denied = await post(f.app, `${sessionPath}/${suffix}`, f.headers, body);
      expect(denied.status, await denied.clone().text()).toBe(409);
      expect(await denied.json()).toMatchObject({ code: "SESSION_IMPORTED_READ_ONLY" });
    }
    const [turns] =
      await shared.admin`select count(*)::int as count from session_turns where session_id=${imported.session.id}`;
    expect(turns!.count).toBe(0);
  }, 60_000);
});
