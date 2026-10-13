import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// Site Data runs the real routes against PostgreSQL as the restricted
// application role: tenant isolation is RLS, access rules are the API's.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("site-data");
  if (!acquired) throw new Error("Site Data tests require real PostgreSQL");
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
  "artifacts:read",
  "artifacts:publish",
] as const;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function memoryObjectStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    maxSinglePutSizeBytes: 5_000_000_000,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
    },
    getObjectRange: async (input: { key: string; start: number; endInclusive: number }) => {
      const bytes = objects.get(input.key);
      return bytes
        ? { bytes: bytes.slice(input.start, input.endInclusive + 1), versionToken: "v" }
        : null;
    },
    putObject: async (input: { key: string; body: Uint8Array }) => {
      objects.set(input.key, input.body.slice());
    },
    putObjectStreamIfAbsent: async (input: { key: string; chunks: AsyncIterable<Uint8Array> }) => {
      if (objects.has(input.key)) return false;
      const parts: Uint8Array[] = [];
      for await (const part of input.chunks) parts.push(part);
      objects.set(input.key, Buffer.concat(parts));
      return true;
    },
    getObjectBytes: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "text/html" } : null;
    },
    createGetUrl: async (input: { key: string; responseContentDisposition?: string }) => ({
      url: `https://storage.example.test/${input.key}${input.responseContentDisposition ? "?download=1" : ""}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createPutUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
      requiredHeaders: {},
    }),
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  };
  return { storage: storage as unknown as ObjectStorageDependency, objects };
}

type Who = { subjectId: string; grant: AccessGrant; headers: Record<string, string> };

async function fixture(overrides: Partial<Settings> = {}) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Site data fixture') returning id`;
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
      "members:manage",
      "sessions:read",
      "sessions:create",
      "artifacts:read",
      "artifacts:publish",
      "account:admin",
    ],
  });
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    ...overrides,
  });
  const { storage, objects } = memoryObjectStorage();
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: storage,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies;
  const app = createApp(deps);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async (permissions: readonly string[]): Promise<Who> => {
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
        permissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      grant: {
        accountId,
        workspaceId: workspace.id,
        subjectId: identity.subjectId,
        permissions: [...permissions] as AccessGrant["permissions"],
        principalKind: "human_session",
      },
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person(memberPermissions);
  const member = await person(memberPermissions);
  const third = await person(memberPermissions);
  const admin = await person([...memberPermissions, "workspace:admin"]);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'site-data-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const base = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const call = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${base}${path}`, {
      method,
      headers: { ...who.headers, ...headers },
      ...(body === undefined
        ? {}
        : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    });
  const publish = async (title: string, visibility?: "private" | "workspace") => {
    const response = await call(owner, "POST", "", {
      title,
      html: `<!doctype html><h1>${title}</h1>`,
      idempotencyKey: crypto.randomUUID(),
      ...(visibility ? { visibility } : {}),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as {
      artifact: { id: string };
      version: { id: string };
    };
    return { id: created.artifact.id, versionId: created.version.id };
  };
  const site = (siteId: string) => {
    const request = async (
      who: Who,
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      const response = await call(who, method, `/${siteId}${path}`, body, headers);
      const text = await response.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json, headers: response.headers };
    };
    return {
      request,
      define: (who: Who, name: string, definition: Record<string, unknown>) =>
        request(who, "PUT", `/data/collections/${name}`, definition),
      write: (who: Who, operations: unknown[], headers?: Record<string, string>) =>
        request(who, "POST", "/data/write", { operations }, headers),
      query: (who: Who, query: Record<string, unknown>, headers?: Record<string, string>) =>
        request(who, "POST", "/data/query", query, headers),
      get: (who: Who, query: Record<string, unknown>) => request(who, "POST", "/data/get", query),
      describe: (who: Who) => request(who, "GET", "/data"),
    };
  };
  return {
    app,
    deps,
    settings,
    accountId,
    workspace,
    owner,
    member,
    third,
    admin,
    objects,
    call,
    publish,
    site,
  };
}

const errorCode = (result: { json: any }) => result.json?.error?.details?.code;
const ids = (result: { json: any }) =>
  (result.json.records as Array<{ id: string }>).map((record) => record.id).sort();

test("each access mode applies to viewers and managers", async () => {
  const f = await fixture();
  const s = f.site((await f.publish("Team CRM")).id);

  // Only managers define collections; members are viewers of the owner's Site.
  const denied = await s.define(f.member, "contacts", { accessMode: "shared" });
  expect(denied.status).toBe(403);
  for (const [name, definition] of [
    ["contacts", { accessMode: "shared", uniqueFields: [["email"]] }],
    ["companies", { accessMode: "shared_read" }],
    ["tracker", { accessMode: "per_viewer" }],
    ["diary", { accessMode: "per_viewer", privateRecords: true }],
    ["feedback", { accessMode: "append_only" }],
  ] as const) {
    const defined = await s.define(f.owner, name, definition);
    expect({ name, status: defined.status }).toEqual({ name, status: 201 });
  }
  // A workspace admin manages any workspace Site's data.
  expect((await s.describe(f.admin)).status).toBe(200);
  expect((await s.describe(f.member)).status).toBe(403);

  // shared: members create, update and delete every record.
  const created = await s.write(f.member, [
    { op: "insert", collection: "contacts", data: { name: "Ada", email: "ada@example.com" } },
  ]);
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const contact = created.json.results[0].record;
  expect(contact.owner).toBe(`user:${f.member.subjectId}`);
  const patched = await s.write(f.third, [
    {
      op: "patch",
      collection: "contacts",
      id: contact.id,
      data: { stage: "lead" },
      expectedVersion: 1,
    },
  ]);
  expect(patched.status).toBe(200);
  expect(patched.json.results[0].record).toMatchObject({
    version: 2,
    data: { name: "Ada", email: "ada@example.com", stage: "lead" },
  });
  // A stale write is a conflict, not a lost update.
  const stale = await s.write(f.member, [
    {
      op: "patch",
      collection: "contacts",
      id: contact.id,
      data: { stage: "won" },
      expectedVersion: 1,
    },
  ]);
  expect(stale.status).toBe(409);
  expect(errorCode(stale)).toBe("conflict");
  expect(stale.json.error.details).toMatchObject({ reason: "version", currentVersion: 2 });
  // Declared unique fields are enforced.
  const duplicate = await s.write(f.third, [
    { op: "insert", collection: "contacts", data: { name: "Other Ada", email: "ada@example.com" } },
  ]);
  expect(duplicate.status).toBe(409);
  expect(duplicate.json.error.details).toMatchObject({ reason: "unique", fields: ["email"] });
  const removed = await s.write(f.third, [
    { op: "delete", collection: "contacts", id: contact.id },
  ]);
  expect(removed.json.results[0]).toEqual({ op: "delete", deleted: { id: contact.id } });

  // shared_read: members read; only managers write.
  const fed = await s.write(f.owner, [
    { op: "put", collection: "companies", key: "acme", data: { name: "Acme", score: 7 } },
  ]);
  expect(fed.status).toBe(200);
  expect((await s.query(f.member, { collection: "companies" })).json.records).toHaveLength(1);
  const readOnly = await s.write(f.member, [
    { op: "insert", collection: "companies", data: { name: "Mine" } },
  ]);
  expect(readOnly.status).toBe(403);
  expect(errorCode(readOnly)).toBe("forbidden");
  const readOnlyPatch = await s.write(f.member, [
    { op: "patch", collection: "companies", key: "acme", data: { score: 1 } },
  ]);
  expect(readOnlyPatch.status).toBe(403);

  // per_viewer: each member sees only their own; the owner sees everyone's.
  const mine = await s.write(f.member, [
    { op: "put", collection: "tracker", key: "today", data: { steps: 1200 } },
  ]);
  const theirs = await s.write(f.third, [
    { op: "put", collection: "tracker", key: "today", data: { steps: 300 } },
  ]);
  const mineId = mine.json.results[0].record.id;
  const theirsId = theirs.json.results[0].record.id;
  expect(ids(await s.query(f.member, { collection: "tracker" }))).toEqual([mineId]);
  expect(ids(await s.query(f.third, { collection: "tracker" }))).toEqual([theirsId]);
  expect(ids(await s.query(f.owner, { collection: "tracker" }))).toEqual([mineId, theirsId].sort());
  expect(ids(await s.query(f.owner, { collection: "tracker", scope: "own" }))).toEqual([]);
  expect((await s.get(f.third, { collection: "tracker", id: mineId })).json.record).toBeNull();
  const foreignPatch = await s.write(f.third, [
    { op: "patch", collection: "tracker", id: mineId, data: { steps: 0 } },
  ]);
  expect(foreignPatch.status).toBe(404);
  // Keys are per viewer, so both members own a record called "today".
  expect((await s.get(f.member, { collection: "tracker", key: "today" })).json.record.id).toBe(
    mineId,
  );

  // private per_viewer records stay hidden even from the owner.
  const secret = await s.write(f.member, [
    { op: "insert", collection: "diary", data: { text: "private" } },
  ]);
  expect(secret.status).toBe(200);
  expect((await s.query(f.owner, { collection: "diary" })).json.records).toEqual([]);
  expect((await s.query(f.admin, { collection: "diary" })).json.records).toEqual([]);
  expect((await s.query(f.member, { collection: "diary" })).json.records).toHaveLength(1);

  // append_only: members add and read their own; they cannot change them.
  const submitted = await s.write(f.member, [
    { op: "insert", collection: "feedback", data: { rating: 5 } },
  ]);
  const feedbackId = submitted.json.results[0].record.id;
  await s.write(f.third, [{ op: "insert", collection: "feedback", data: { rating: 2 } }]);
  expect(ids(await s.query(f.member, { collection: "feedback" }))).toEqual([feedbackId]);
  expect((await s.query(f.owner, { collection: "feedback" })).json.records).toHaveLength(2);
  const edit = await s.write(f.member, [
    { op: "patch", collection: "feedback", id: feedbackId, data: { rating: 1 } },
  ]);
  expect(edit.status).toBe(403);
  const erase = await s.write(f.member, [{ op: "delete", collection: "feedback", id: feedbackId }]);
  expect(erase.status).toBe(403);
  expect(
    (await s.write(f.owner, [{ op: "delete", collection: "feedback", id: feedbackId }])).status,
  ).toBe(200);

  // A collection's access mode is fixed once it has records.
  const locked = await s.define(f.owner, "tracker", { accessMode: "shared" });
  expect(locked.status).toBe(409);
});

test("Site frames get viewer reach whoever views them, and never manage", async () => {
  const f = await fixture();
  const first = await f.publish("Tracker");
  const second = await f.publish("Other");
  const s = f.site(first.id);
  await s.define(f.owner, "tracker", { accessMode: "per_viewer" });
  await s.write(f.member, [{ op: "insert", collection: "tracker", data: { steps: 1 } }]);
  const own = await s.write(f.owner, [{ op: "insert", collection: "tracker", data: { steps: 2 } }]);
  const frame = { "x-opengeni-site-id": first.id };
  // Site HTML is untrusted: even the owner's own Site page reads with viewer
  // reach, so asking for all records still returns only the owner's.
  expect(ids(await s.query(f.owner, { collection: "tracker" }, frame))).toEqual([
    own.json.results[0].record.id,
  ]);
  expect(ids(await s.query(f.owner, { collection: "tracker", scope: "all" }, frame))).toEqual([
    own.json.results[0].record.id,
  ]);
  // Outside the frame the owner manages and reads everything.
  expect(
    (await s.query(f.owner, { collection: "tracker", scope: "all" })).json.records,
  ).toHaveLength(2);
  // A frame cannot write a shared_read collection, even on the owner's behalf.
  await s.define(f.owner, "news", { accessMode: "shared_read" });
  const framedWrite = await s.write(
    f.owner,
    [{ op: "insert", collection: "news", data: { title: "x" } }],
    frame,
  );
  expect(framedWrite.status).toBe(403);
  expect(
    (await s.write(f.owner, [{ op: "insert", collection: "news", data: { title: "x" } }])).status,
  ).toBe(200);
  // Another viewer's private file stays hidden from the owner's frame.
  const privateFile = await s.request(
    f.member,
    "POST",
    "/files?name=id.pdf&scope=private",
    new TextEncoder().encode("%PDF-1.7 test"),
    { "content-type": "application/pdf", ...frame },
  );
  expect(privateFile.status).toBe(201);
  expect((await s.request(f.owner, "GET", "/files", undefined, frame)).json.files).toHaveLength(0);
  expect((await s.request(f.owner, "GET", "/files")).json.files).toHaveLength(1);
  // The host-set frame marker alone makes a request framed; without the Site id it names no Site.
  const markerOnly = await s.query(
    f.owner,
    { collection: "tracker" },
    { "x-opengeni-site-frame": "1" },
  );
  expect(markerOnly.status).toBe(403);
  // A frame cannot define, describe, export, or reach another Site.
  expect(
    (await s.request(f.owner, "PUT", "/data/collections/x", { accessMode: "shared" }, frame))
      .status,
  ).toBe(403);
  expect((await s.request(f.owner, "GET", "/data", undefined, frame)).status).not.toBe(200);
  expect(
    (await s.request(f.owner, "GET", "/data/collections/tracker/export", undefined, frame)).status,
  ).toBe(403);
  const crossSite = await f.site(second.id).query(f.owner, { collection: "tracker" }, frame);
  expect(crossSite.status).toBe(403);
});

test("data is isolated by Site, workspace and Only me audience", async () => {
  const f = await fixture();
  const a = await f.publish("A");
  const b = await f.publish("B");
  await f.site(a.id).define(f.owner, "notes", { accessMode: "shared" });
  await f.site(a.id).write(f.owner, [{ op: "insert", collection: "notes", data: { text: "a" } }]);
  // Another Site has its own collections.
  const otherSite = await f.site(b.id).query(f.owner, { collection: "notes" });
  expect(otherSite.status).toBe(404);
  expect(errorCode(otherSite)).toBe("not_found");

  // Another organization cannot see the Site at all.
  const g = await fixture();
  const crossTenant = await g.app.request(
    `/v1/workspaces/${f.workspace.id}/published-artifacts/${a.id}/data/query`,
    { method: "POST", headers: g.owner.headers, body: JSON.stringify({ collection: "notes" }) },
  );
  expect([403, 404]).toContain(crossTenant.status);
  const viaOwnWorkspace = await g.site(a.id).query(g.owner, { collection: "notes" });
  expect(viaOwnWorkspace.status).toBe(404);
  // RLS keeps tenants apart even below the API.
  const visible = await db.db.execute(
    (await import("drizzle-orm")).sql`select count(*)::int as count from site_data_records`,
  );
  expect(Number((visible as unknown as Array<{ count: number }>)[0]?.count ?? 0)).toBe(0);

  // An Only me Site's data is reachable only by its owner.
  const mine = await f.publish("Mine", "private");
  const p = f.site(mine.id);
  expect((await p.define(f.owner, "notes", { accessMode: "shared" })).status).toBe(201);
  for (const who of [f.member, f.admin]) {
    expect((await p.query(who, { collection: "notes" })).status).toBe(404);
    expect(
      (await p.write(who, [{ op: "insert", collection: "notes", data: { x: 1 } }])).status,
    ).toBe(404);
    expect((await p.describe(who)).status).toBe(404);
    expect((await p.request(who, "GET", "/files")).status).toBe(404);
  }
  expect((await p.query(f.owner, { collection: "notes" })).status).toBe(200);
});

test("archived Sites keep their data but give viewers and frames no access", async () => {
  const f = await fixture();
  const created = await f.publish("Archive me");
  const s = f.site(created.id);
  await s.define(f.owner, "notes", { accessMode: "shared" });
  await s.write(f.member, [{ op: "insert", collection: "notes", data: { text: "kept" } }]);
  const archived = await f.call(f.owner, "PATCH", `/${created.id}/status`, {
    status: "archived",
    expectedCurrentVersionId: created.versionId,
    reason: "done",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(archived.status, await archived.clone().text()).toBe(200);
  const viewer = await s.query(f.member, { collection: "notes" });
  expect(viewer.status).toBe(403);
  expect(viewer.json.error.message).toContain("archived");
  expect(
    (await s.query(f.owner, { collection: "notes" }, { "x-opengeni-site-id": created.id })).status,
  ).toBe(403);
  // Its managers still see and export the data.
  expect((await s.query(f.owner, { collection: "notes" })).json.records).toHaveLength(1);
  expect((await s.describe(f.owner)).json.usage.recordCount).toBe(1);
});

test("batches are atomic and queries filter, sort, count and page", async () => {
  const f = await fixture();
  const s = f.site((await f.publish("Board")).id);
  await s.define(f.owner, "items", {
    accessMode: "shared",
    indexedFields: ["score"],
    jsonSchema: {
      type: "object",
      properties: { score: { type: "number" }, title: { type: "string" } },
      required: ["title"],
    },
  });
  const failed = await s.write(f.member, [
    { op: "insert", collection: "items", data: { title: "kept?", score: 1 } },
    { op: "patch", collection: "items", key: "missing", data: { score: 2 } },
  ]);
  expect(failed.status).toBe(404);
  expect((await s.query(f.member, { collection: "items" })).json.records).toEqual([]);
  const invalid = await s.write(f.member, [
    { op: "insert", collection: "items", data: { score: "high" } },
  ]);
  expect(invalid.status).toBe(422);
  expect(errorCode(invalid)).toBe("validation");

  const operations = Array.from({ length: 25 }, (_, index) => ({
    op: "insert",
    collection: "items",
    key: `item-${index}`,
    data: {
      title: `Item ${index}`,
      score: index,
      tags: index % 2 ? ["odd"] : ["even"],
      meta: { group: index % 3 },
    },
  }));
  expect((await s.write(f.member, operations)).status).toBe(200);
  const filtered = await s.query(f.member, {
    collection: "items",
    where: [
      { field: "score", op: "gte", value: 10 },
      { field: "tags", op: "contains", value: "odd" },
      { field: "meta.group", op: "in", value: [0, 1] },
    ],
    sort: [{ field: "score", direction: "desc" }],
    count: true,
  });
  expect(filtered.status, JSON.stringify(filtered.json)).toBe(200);
  const scores = filtered.json.records.map((record: any) => record.data.score);
  const expected = Array.from({ length: 25 }, (_, index) => 24 - index).filter(
    (n) => n >= 10 && n % 2 === 1 && n % 3 !== 2,
  );
  expect(expected).toEqual([21, 19, 15, 13]);
  expect(scores).toEqual(expected);
  expect(filtered.json.count).toBe(scores.length);

  const seen: number[] = [];
  let cursor: string | null = null;
  do {
    const page: any = await s.query(f.member, {
      collection: "items",
      sort: [
        { field: "meta.group", direction: "asc" },
        { field: "$createdAt", direction: "desc" },
      ],
      limit: 4,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    seen.push(...page.json.records.map((record: any) => record.data.score));
    cursor = page.json.nextCursor;
  } while (cursor);
  expect(seen).toHaveLength(25);
  expect(new Set(seen).size).toBe(25);

  const counter = await s.write(f.member, [
    { op: "increment", collection: "items", key: "item-3", field: "score", by: 5 },
  ]);
  expect(counter.status, JSON.stringify(counter.json)).toBe(200);
  expect(counter.json.results[0].record.data.score).toBe(8);
  // Incrementing a missing key creates it, still subject to the schema.
  const invalidCounter = await s.write(f.member, [
    { op: "increment", collection: "items", key: "votes", field: "count" },
  ]);
  expect(invalidCounter.status).toBe(422);
  await s.define(f.owner, "counters", { accessMode: "shared" });
  const votes = await s.write(f.member, [
    { op: "increment", collection: "counters", key: "votes", field: "count" },
    { op: "increment", collection: "counters", key: "votes", field: "count", by: 2 },
  ]);
  expect(votes.status, JSON.stringify(votes.json)).toBe(200);
  expect(votes.json.results[1].record.data).toEqual({ count: 3 });
  expect(votes.json.results[1].record.version).toBe(2);
});

test("quotas and write limits are enforced", async () => {
  const f = await fixture({
    siteDataMaxRecordBytes: 200,
    // Each record is charged its JSON plus 512 bytes.
    siteDataRecordBytesPerSite: 3_000,
    siteDataMaxCollectionsPerSite: 2,
    siteDataViewerWritesPerMinute: 3,
    siteDataMaxFileBytes: 64,
    siteDataFileBytesPerSite: 100,
  });
  const s = f.site((await f.publish("Small")).id);
  await s.define(f.owner, "a", { accessMode: "shared" });
  await s.define(f.owner, "b", { accessMode: "shared" });
  const third = await s.define(f.owner, "c", { accessMode: "shared" });
  expect(third.status).toBe(413);
  expect(third.json.error.details).toMatchObject({ code: "quota_exceeded", quota: "collections" });

  const large = await s.write(f.owner, [
    { op: "insert", collection: "a", data: { text: "x".repeat(300) } },
  ]);
  expect(large.status).toBe(413);
  expect(large.json.error.details.quota).toBe("record_bytes");
  for (let index = 0; index < 4; index += 1)
    await s.write(f.owner, [{ op: "insert", collection: "a", data: { text: "y".repeat(120) } }]);
  const full = await s.write(f.owner, [
    { op: "insert", collection: "a", data: { text: "z".repeat(120) } },
  ]);
  expect(full.status).toBe(413);
  expect(full.json.error.details.quota).toBe("site_record_bytes");

  // Viewers get a per-minute write window; managers are bounded by quotas.
  const r = f.site((await f.publish("Busy")).id);
  await r.define(f.owner, "b", { accessMode: "shared" });
  const statuses: number[] = [];
  for (let index = 0; index < 4; index += 1)
    statuses.push(
      (await r.write(f.member, [{ op: "insert", collection: "b", data: { n: index } }])).status,
    );
  expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
  expect(statuses[3]).toBe(429);

  const tooBig = await s.request(f.owner, "POST", "/files?name=big.png", new Uint8Array(100), {
    "content-type": "image/png",
  });
  expect(tooBig.status).toBe(413);
  const first = await s.request(f.owner, "POST", "/files?name=a.png", PNG, {
    "content-type": "image/png",
  });
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  const blob = new Uint8Array(60);
  const second = await s.request(f.owner, "POST", "/files?name=b.bin", blob, {
    "content-type": "application/octet-stream",
  });
  expect(second.status, JSON.stringify(second.json)).toBe(201);
  const overflow = await s.request(f.owner, "POST", "/files?name=c.bin", blob, {
    "content-type": "application/octet-stream",
  });
  expect(overflow.status).toBe(413);
  expect(overflow.json.error.details.quota).toBe("site_file_bytes");
});

test("files upload, list, download and delete with shared and private scope", async () => {
  const f = await fixture();
  const created = await f.publish("Intake");
  const s = f.site(created.id);
  const frame = { "x-opengeni-site-id": created.id };
  const sharedFile = await s.request(f.member, "POST", "/files?name=photo.png", PNG, {
    "content-type": "image/png",
    ...frame,
  });
  expect(sharedFile.status, JSON.stringify(sharedFile.json)).toBe(201);
  const secret = await s.request(
    f.member,
    "POST",
    "/files?name=id.pdf&scope=private",
    new TextEncoder().encode("%PDF-1.7 test"),
    { "content-type": "application/pdf", ...frame },
  );
  expect(secret.status).toBe(201);
  const spoofed = await s.request(
    f.member,
    "POST",
    "/files?name=x.png",
    new Uint8Array([1, 2, 3]),
    {
      "content-type": "image/png",
    },
  );
  expect(spoofed.status).toBe(422);
  const html = await s.request(f.member, "POST", "/files?name=x.html", new Uint8Array([60]), {
    "content-type": "text/html",
  });
  expect(html.status).toBe(422);

  const names = (result: { json: any }) =>
    (result.json.files as Array<{ name: string }>).map((file) => file.name).sort();
  expect(names(await s.request(f.member, "GET", "/files"))).toEqual(["id.pdf", "photo.png"]);
  expect(names(await s.request(f.third, "GET", "/files"))).toEqual(["photo.png"]);
  expect(names(await s.request(f.owner, "GET", "/files"))).toEqual(["id.pdf", "photo.png"]);
  expect((await s.request(f.third, "GET", `/files/${secret.json.id}`)).status).toBe(404);
  const download = await s.request(f.third, "GET", `/files/${sharedFile.json.id}`);
  expect(download.status).toBe(200);
  expect(download.json.url).toContain(`/site-data/${created.id}/files/${sharedFile.json.id}`);
  // Only the uploader or a manager deletes a shared file.
  expect((await s.request(f.third, "DELETE", `/files/${sharedFile.json.id}`)).status).toBe(403);
  expect((await s.request(f.member, "DELETE", `/files/${sharedFile.json.id}`)).status).toBe(200);
  expect([...f.objects.keys()].some((key) => key.endsWith(sharedFile.json.id))).toBe(false);
  expect((await s.describe(f.owner)).json.usage).toMatchObject({ fileCount: 1 });
});

const SITE_DATA_TOOLS = [
  "site_data_describe",
  "site_data_define_collection",
  "site_data_query",
  "site_data_write",
  "site_data_import",
  "site_data_export",
  "site_data_reset",
  "site_files_list",
  "site_files_upload",
  "site_files_delete",
];

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A running agent turn and an MCP client for its first-party Site Data tools.
 * `initiatorSubjectId: null` makes a person-less agent.
 */
async function agentTools(
  f: Fixture,
  options: {
    initiatorSubjectId?: string | null;
    metadata?: Record<string, unknown>;
    surface?: string | null;
    parentSessionId?: string;
  } = {},
) {
  const initiator =
    options.initiatorSubjectId === undefined ? f.owner.subjectId : options.initiatorSubjectId;
  const session = await createSession(db.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Refresh research",
    resources: [],
    tools: [],
    metadata: options.metadata ?? {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [turn] = await shared.admin<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context, surface
    ) VALUES (
      ${f.accountId}, ${f.workspace.id}, ${session.id}, gen_random_uuid(),
      ${`site-data-wf-${crypto.randomUUID()}`}, 'running', 0, 'Refresh research',
      'gpt-5.6-sol', 'medium', 'none', 1, ${initiator === null ? "service" : "subject"},
      ${initiator ?? "service:site-data-test"}, '{"accepted":true}'::jsonb, ${options.surface ?? null}
    ) RETURNING id`;
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) VALUES (
        ${attemptId}, ${f.accountId}, ${f.workspace.id}, ${session.id}, ${turn!.id}, 1,
        'running', 'site-data-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  if (options.parentSessionId) {
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`UPDATE sessions SET parent_session_id = ${options.parentSessionId!}
        WHERE id = ${session.id}`;
    });
  }
  const server = buildOpenGeniMcpServer(f.deps as unknown as ApiRouteDeps, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    subjectId: "worker:first-party-mcp",
    permissions: ["artifacts:read", "artifacts:publish"],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      executionGeneration: 1,
      firstPartyMcpTools: SITE_DATA_TOOLS,
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "site-data-test", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (item) => item.type === "text",
    )?.text;
    let value: any = text ?? null;
    try {
      value = JSON.parse(text ?? "null");
    } catch {
      // Argument errors are plain text.
    }
    return { isError: result.isError === true, value };
  };
  return { session, turnId: turn!.id, mcp, callTool };
}

test("an agent defines and feeds a collection the way a schedule would", async () => {
  const f = await fixture();
  const created = await f.publish("Company research");
  const { session, mcp, callTool } = await agentTools(f);
  const tools = SITE_DATA_TOOLS;
  try {
    expect((await mcp.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      [...tools].sort(),
    );
    const defined = await callTool("site_data_define_collection", {
      siteId: created.id,
      name: "companies",
      accessMode: "shared_read",
      uniqueFields: [["domain"]],
    });
    expect(defined.isError, JSON.stringify(defined.value)).toBe(false);
    const write = () =>
      callTool("site_data_write", {
        siteId: created.id,
        operations: [
          {
            op: "put",
            collection: "companies",
            key: "acme.com",
            data: { name: "Acme", domain: "acme.com" },
          },
          {
            op: "put",
            collection: "companies",
            key: "globex.com",
            data: { name: "Globex", domain: "globex.com" },
          },
        ],
      });
    expect((await write()).isError).toBe(false);
    // A rerun replaces records instead of duplicating them.
    expect((await write()).isError).toBe(false);
    const conflict = await callTool("site_data_write", {
      siteId: created.id,
      operations: [{ op: "insert", collection: "companies", data: { domain: "acme.com" } }],
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.value.error.code).toBe("conflict");

    // The page reads it as any member would.
    const page = await f.site(created.id).query(
      f.member,
      { collection: "companies", sort: [{ field: "name" }] },
      {
        "x-opengeni-site-id": created.id,
      },
    );
    expect(page.json.records.map((record: any) => [record.data.name, record.version])).toEqual([
      ["Acme", 2],
      ["Globex", 2],
    ]);
    // The agent acts for the owner: records are owned by the person, written by the agent.
    expect(page.json.records[0]).toMatchObject({
      owner: `user:${f.owner.subjectId}`,
      updatedBy: `agent:session:${session.id}`,
    });

    const exported = await callTool("site_data_export", {
      siteId: created.id,
      collection: "companies",
      format: "csv",
    });
    expect(exported.value.records).toBe(2);
    expect(exported.value.content.split("\r\n")[0]).toBe(
      "$id,$key,$owner,$createdAt,$updatedAt,domain,name",
    );
    const imported = await callTool("site_data_import", {
      siteId: created.id,
      collection: "companies",
      format: "csv",
      csv: 'name,domain\nInitech,initech.com\n"Hooli, Inc",hooli.com\n',
      keyField: "domain",
    });
    expect(imported.value).toEqual({ imported: 2 });
    // The tools reuse the contracts: a json import needs records, keyField is a field path.
    const empty = await callTool("site_data_import", {
      siteId: created.id,
      collection: "companies",
      format: "json",
    });
    expect(empty.isError).toBe(true);
    const badKey = await callTool("site_data_import", {
      siteId: created.id,
      collection: "companies",
      format: "json",
      records: [{ domain: "x.com" }],
      keyField: "__proto__",
    });
    expect(badKey.isError).toBe(true);
    const own = await callTool("site_data_query", {
      siteId: created.id,
      collection: "companies",
      scope: "own",
      count: true,
    });
    expect(own.isError, JSON.stringify(own.value)).toBe(false);
    expect(own.value.count).toBe(4);
    const listed = (await mcp.listTools()).tools;
    const upload = listed.find((tool) => tool.name === "site_files_upload")!;
    expect(JSON.stringify(upload.inputSchema)).toContain(
      "only the uploader and the Site's managers",
    );
    expect(
      (listed.find((tool) => tool.name === "site_data_query")!.inputSchema as any).properties.scope,
    ).toBeDefined();
    const described = await callTool("site_data_describe", { siteId: created.id });
    expect(described.value.collections[0]).toMatchObject({ name: "companies", recordCount: 4 });
    const uploaded = await callTool("site_files_upload", {
      siteId: created.id,
      name: "summary.csv",
      contentType: "text/csv",
      text: "a,b\n1,2\n",
    });
    expect(uploaded.isError, JSON.stringify(uploaded.value)).toBe(false);
    const reset = await callTool("site_data_reset", {
      siteId: created.id,
      collection: "companies",
      confirm: true,
    });
    expect(reset.value).toEqual({ deletedRecords: 4 });

    // Usage is metered for the workspace in usage-only mode.
    const usage = await shared.admin<{ event_type: string; total: string }[]>`
      select event_type, sum(quantity)::text as total from usage_events
      where workspace_id = ${f.workspace.id} and source_resource_id = ${created.id}
      group by event_type order by event_type`;
    expect(usage.map((row) => row.event_type)).toEqual([
      "site_data.file_upload_bytes",
      "site_data.write",
      "site_data.write_bytes",
    ]);
  } finally {
    await mcp.close();
  }
});

test("paths that name a prototype are refused everywhere", async () => {
  const f = await fixture();
  const s = f.site((await f.publish("Pollution")).id);
  await s.define(f.owner, "rows", { accessMode: "shared" });
  const polluted = () => ({}) as Record<string, unknown>;
  for (const header of ["__proto__.x", "constructor.prototype.x", "prototype"]) {
    const imported = await s.request(f.owner, "POST", "/data/collections/rows/import", {
      format: "csv",
      csv: `${header}\nhacked\n`,
    });
    expect(imported.status, header).toBe(422);
  }
  expect(polluted().x).toBeUndefined();
  for (const field of ["constructor", "__proto__", "prototype.x", "$id2", "$toString"]) {
    const sorted = await s.query(f.owner, { collection: "rows", sort: [{ field }] });
    expect(sorted.status, field).toBe(422);
  }
  // Names an object inherits are ordinary data fields, never system sorts.
  for (const field of ["toString", "hasOwnProperty", "valueOf"]) {
    const sorted = await s.query(f.owner, { collection: "rows", sort: [{ field }] });
    expect(sorted.status, field).toBe(200);
  }
  const filtered = await s.query(f.owner, {
    collection: "rows",
    where: [{ field: "__proto__.polluted", op: "eq", value: 1 }],
  });
  expect(filtered.status).toBe(422);
  const keyed = await s.request(f.owner, "POST", "/data/collections/rows/import", {
    format: "json",
    records: [{ a: 1 }],
    keyField: "constructor",
  });
  expect(keyed.status).toBe(422);
  const increment = await s.write(f.owner, [
    { op: "increment", collection: "rows", key: "k", field: "__proto__.count" },
  ]);
  expect(increment.status).toBe(422);
  const indexed = await s.define(f.owner, "rows", {
    accessMode: "shared",
    indexedFields: ["prototype"],
  });
  expect(indexed.status).toBe(422);
  const unique = await s.define(f.owner, "rows", {
    accessMode: "shared",
    uniqueFields: [["constructor"]],
  });
  expect(unique.status).toBe(422);
  // A JSON key named __proto__ is ordinary own data, never a prototype.
  const stored = await s.write(f.owner, [
    { op: "insert", collection: "rows", key: "own", data: JSON.parse('{"__proto__":{"x":1}}') },
  ]);
  expect([200, 422]).toContain(stored.status);
  expect(polluted().x).toBeUndefined();
  // The API keeps serving.
  expect((await s.query(f.owner, { collection: "rows" })).status).toBe(200);
});

test("collection schemas use a strict keyword allowlist and stay isolated", async () => {
  const f = await fixture();
  const a = f.site((await f.publish("Schema A")).id);
  const b = f.site((await f.publish("Schema B")).id);
  const evil = { type: "string", pattern: "^(a+)+$" };
  // A diamond chain: each level refers to the next twice (exponential with $ref).
  const diamond: Record<string, unknown> = { level3: { type: "string" } };
  for (let level = 0; level < 3; level += 1)
    diamond[`level${level}`] = {
      allOf: [{ $ref: `#/$defs/level${level + 1}` }, { $ref: `#/$defs/level${level + 1}` }],
    };
  const deep = (depth: number): Record<string, unknown> =>
    depth === 0 ? { type: "string" } : { type: "object", properties: { a: deep(depth - 1) } };
  const wide = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`p${index}`, { type: "string" }]),
    ),
  };
  for (const [schema, message] of [
    // (a) a reference into data keywords that hides a regex
    [{ type: "object", examples: [evil], properties: { a: { $ref: "#/examples/0" } } }, "examples"],
    [{ type: "object", properties: { a: { $ref: "#/examples/0" } } }, "$ref"],
    [{ type: "object", default: evil }, "default"],
    // (b) a diamond $defs chain and a recursive reference inside anyOf
    [{ type: "object", $defs: diamond, allOf: [{ $ref: "#/$defs/level0" }] }, "$defs"],
    [{ type: "object", anyOf: [{ $ref: "#" }, { type: "string" }] }, "$ref"],
    // (c) uniqueItems without scalar items compares every pair of elements
    [{ type: "array", uniqueItems: true }, "uniqueItems"],
    [{ type: "array", uniqueItems: true, items: { type: "object" } }, "uniqueItems"],
    [{ type: "array", uniqueItems: true, items: { type: ["string", "array"] } }, "uniqueItems"],
    // Everything else outside the allowlist
    [{ $id: "https://example.test/x", type: "object" }, "$id"],
    [{ $schema: "https://json-schema.org/draft/2020-12/schema" }, "$schema"],
    [{ type: "object", definitions: { a: { type: "string" } } }, "definitions"],
    [{ type: "object", properties: { a: evil } }, "pattern"],
    [{ type: "object", patternProperties: { "^x": { type: "string" } } }, "patternProperties"],
    [{ type: "object", propertyNames: { maxLength: 3 } }, "propertyNames"],
    [{ type: "object", if: { required: ["a"] }, then: { required: ["b"] } }, "if"],
    [{ type: "object", not: { required: ["a"] } }, "not"],
    [{ type: "array", contains: { type: "string" } }, "contains"],
    [{ type: "object", dependentSchemas: { a: { required: ["b"] } } }, "dependentSchemas"],
    [{ type: "object", dependentRequired: { a: ["b"] } }, "dependentRequired"],
    [{ type: "object", unevaluatedProperties: false }, "unevaluatedProperties"],
    [{ type: "array", items: [{ type: "string" }] }, "not an object or boolean"],
    [{ type: "array", prefixItems: [{ type: "string" }] }, "prefixItems"],
    [{ type: "string", enum: [{ a: 1 }] }, "enum"],
    [{ type: "string", enum: Array.from({ length: 101 }, (_, index) => `v${index}`) }, "enum"],
    [{ type: "object", const: { a: 1 } }, "const"],
    [{ type: "number", multipleOf: 0 }, "multipleOf"],
    [{ type: "set" }, "type"],
    [wide, "more than 500"],
    [deep(17), "nested more than 16"],
  ] as const) {
    const defined = await a.define(f.owner, "rows", { accessMode: "shared", jsonSchema: schema });
    expect(defined.status, JSON.stringify(schema).slice(0, 200)).toBe(422);
    expect(defined.json.error.message).toContain(message);
  }
  expect(
    (
      await a.define(f.owner, "deep", {
        accessMode: "shared",
        jsonSchema: { type: "object", properties: { a: deep(15) } },
      })
    ).status,
  ).toBe(201);
  // Property names that look like keywords are fine; every allowed keyword works.
  const schema = {
    type: "object",
    title: "Rows",
    description: "A row",
    properties: {
      id: { type: "string" },
      pattern: { type: "string", format: "email" },
      name: { type: "string", minLength: 1, maxLength: 20 },
      kind: { enum: ["a", "b", null] },
      fixed: { const: 1 },
      score: { type: "number", minimum: 0, maximum: 10, multipleOf: 0.5 },
      tags: { type: "array", items: { type: "string" }, uniqueItems: true, maxItems: 5 },
      either: { anyOf: [{ type: "string" }, { type: "integer", exclusiveMinimum: 0 }] },
      meta: { type: "object", additionalProperties: { type: "string" }, maxProperties: 3 },
    },
    required: ["name"],
    additionalProperties: true,
    allOf: [{ type: "object" }],
    oneOf: [{ required: ["name"] }],
  };
  for (const site of [a, b]) {
    const defined = await site.define(f.owner, "rows", {
      accessMode: "shared",
      jsonSchema: schema,
    });
    expect(defined.status, JSON.stringify(defined.json)).toBe(201);
    // Writes keep working after the first: nothing registers globally.
    for (let index = 0; index < 2; index += 1)
      expect(
        (
          await site.write(f.owner, [
            {
              op: "insert",
              collection: "rows",
              data: { name: `n${index}`, pattern: "not an email", tags: ["x", "y"] },
            },
          ])
        ).status,
      ).toBe(200);
    const invalid = await site.write(f.owner, [
      { op: "insert", collection: "rows", data: { name: "x".repeat(30) } },
    ]);
    expect(invalid.status).toBe(422);
    expect(invalid.json.error.details.index).toBe(0);
    const duplicates = await site.write(f.owner, [
      { op: "insert", collection: "rows", data: { name: "d", tags: ["x", "x"] } },
    ]);
    expect(duplicates.status).toBe(422);
  }
  // Patches merge with the stored record, so the merged record is checked in the write.
  const inserted = await a.write(f.owner, [
    { op: "insert", collection: "rows", key: "p", data: { name: "patch me" } },
  ]);
  expect(inserted.status).toBe(200);
  const patched = await a.write(f.owner, [
    { op: "patch", collection: "rows", key: "p", data: { name: "y".repeat(30) } },
  ]);
  expect(patched.status).toBe(422);
  const { siteDataSchemaCacheSize, validateSiteDataRecord } =
    await import("../src/site-data/service");
  for (let index = 0; index < 300; index += 1)
    validateSiteDataRecord({ type: "object", maxProperties: index + 1 }, {});
  expect(siteDataSchemaCacheSize()).toBeLessThanOrEqual(128);
});

test("new records are validated before the write takes the Site's lock", async () => {
  const { prevalidateSiteDataWrite } = await import("../src/site-data/service");
  const schema = { type: "object", properties: { name: { type: "string", maxLength: 3 } } };
  const store = {
    getCollection: async () => ({ jsonSchema: schema }),
    write: async () => {
      throw new Error("the store must not be reached");
    },
  };
  const access = {
    store,
    caller: {},
    limits: { maxRecordBytes: 256 * 1024 },
    writeOptions: { limits: {} },
  } as never;
  let refused: any = null;
  try {
    await prevalidateSiteDataWrite(access, [
      { op: "insert", collection: "rows", data: { name: "ok" } },
      { op: "put", collection: "rows", key: "k", data: { name: "too long" } },
    ]);
  } catch (error) {
    refused = error;
  }
  expect(refused?.code).toBe("validation");
  expect(refused?.details?.index).toBe(1);
  const valid = { name: "ok" };
  const options = await prevalidateSiteDataWrite(access, [
    { op: "insert", collection: "rows", data: valid },
  ]);
  // In the write, the same record against the same schema is not checked again;
  // anything else (a merged patch, a changed schema) still is.
  expect(options.validate!({ ...schema }, valid)).toBeNull();
  expect(options.validate!(schema, { name: "toolong" })).toContain("name");
  expect(options.validate!({ type: "object", required: ["other"] }, valid)).toContain("other");
});

test("only personless keys and people who manage the Site are managers", async () => {
  const { siteDataRole } = await import("../src/site-data/service");
  const site = { ownerSubjectId: "owner", createdBySubjectId: "owner" };
  const grant = (principalKind: AccessGrant["principalKind"]): AccessGrant => ({
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "subject",
    permissions: ["artifacts:read", "artifacts:publish"],
    ...(principalKind ? { principalKind } : {}),
  });
  expect(siteDataRole(grant("api_key"), site, null)).toBe("manager");
  expect(siteDataRole(grant("configured_key"), site, null)).toBe("manager");
  expect(siteDataRole(grant("service"), site, null)).toBe("manager");
  expect(siteDataRole(grant("agent_attempt"), site, null)).toBe("viewer");
  expect(siteDataRole(grant("human_session"), site, null)).toBe("viewer");
  expect(siteDataRole(grant(undefined), site, null)).toBe("viewer");
  expect(siteDataRole(grant("agent_attempt"), site, "owner")).toBe("manager");
  expect(siteDataRole(grant("human_session"), site, "someone")).toBe("viewer");
});

test("counters, per-record charge, record cap, bounded filters and tampered cursors", async () => {
  const f = await fixture({ siteDataMaxRecordsPerCollection: 3 });
  const s = f.site((await f.publish("Counters")).id);
  await s.define(f.owner, "rows", { accessMode: "shared" });
  const written = await s.write(f.owner, [
    { op: "insert", collection: "rows", data: {} },
    { op: "insert", collection: "rows", data: { null: "named null", n: -5 } },
  ]);
  expect(written.status).toBe(200);
  const described = await s.describe(f.owner);
  // `{}` is 2 bytes of JSON but is charged 514.
  const sizes = written.json.results.map((item: any) => item.record.sizeBytes);
  expect(described.json.collections[0]).toMatchObject({
    recordCount: 2,
    recordBytes: sizes[0] + sizes[1] + 2 * 512,
  });
  expect(described.json.usage.recordBytes).toBe(sizes[0] + sizes[1] + 2 * 512);
  // A field literally named null is queryable.
  const byNull = await s.query(f.owner, {
    collection: "rows",
    where: [{ field: "null", op: "eq", value: "named null" }],
  });
  expect(byNull.json.records).toHaveLength(1);
  // The collection cap counts every record in the batch.
  const capped = await s.write(f.owner, [
    { op: "insert", collection: "rows", data: { a: 1 } },
    { op: "insert", collection: "rows", data: { a: 2 } },
  ]);
  expect(capped.status).toBe(413);
  expect(capped.json.error.details.quota).toBe("collection_records");
  expect((await s.describe(f.owner)).json.collections[0].recordCount).toBe(2);
  // Deleting gives the room back.
  await s.write(f.owner, [
    { op: "delete", collection: "rows", id: written.json.results[0].record.id },
  ]);
  const after = await s.describe(f.owner);
  expect(after.json.collections[0]).toMatchObject({ recordCount: 1, recordBytes: sizes[1] + 512 });
  expect((await s.query(f.owner, { collection: "rows", count: true })).json.count).toBe(1);
  // Filters are bounded.
  const long = await s.query(f.owner, {
    collection: "rows",
    where: [{ field: "a", op: "eq", value: "x".repeat(2000) }],
  });
  expect(long.status).toBe(422);
  const wide = await s.query(f.owner, {
    collection: "rows",
    where: [{ field: "a", op: "in", value: Array.from({ length: 101 }, (_, i) => i) }],
  });
  expect(wide.status).toBe(422);
  // Tampered cursors are validation errors, never server errors.
  const tamper = (value: unknown, sort: unknown[]) =>
    Buffer.from(
      JSON.stringify({
        s: JSON.stringify([...sort, (sort.at(-1) as string[] | undefined)?.[1] ?? "asc"]),
        v: [value],
        id: crypto.randomUUID(),
      }),
    ).toString("base64url");
  for (const [field, value] of [
    ["$createdAt", "not a time"],
    ["$updatedAt", 12],
    ["$version", "1; drop"],
    ["$version", 1.5],
    ["$key", 7],
  ] as const) {
    const result = await s.query(f.owner, {
      collection: "rows",
      sort: [{ field }],
      cursor: tamper(value, [[field, "asc"]]),
    });
    expect(result.status, `${field} ${String(value)}`).toBe(422);
  }
  const garbage = await s.query(f.owner, { collection: "rows", cursor: "!!!" });
  expect(garbage.status).toBe(422);
  const files = await s.request(f.owner, "GET", "/files?cursor=abc");
  expect(files.status).toBe(422);
});

test("the workspace total is shared across its Sites", async () => {
  const f = await fixture({ siteDataWorkspaceBytes: 2_000 });
  const a = f.site((await f.publish("WA")).id);
  const b = f.site((await f.publish("WB")).id);
  await a.define(f.owner, "rows", { accessMode: "shared" });
  await b.define(f.owner, "rows", { accessMode: "shared" });
  for (let index = 0; index < 3; index += 1)
    expect(
      (await a.write(f.owner, [{ op: "insert", collection: "rows", data: { i: index } }])).status,
    ).toBe(200);
  const full = await b.write(f.owner, [{ op: "insert", collection: "rows", data: { i: 9 } }]);
  expect(full.status).toBe(413);
  expect(full.json.error.details.quota).toBe("workspace_bytes");
  const file = await b.request(f.owner, "POST", "/files?name=a.bin", new Uint8Array(500), {
    "content-type": "application/octet-stream",
  });
  expect(file.status).toBe(413);
  expect(file.json.error.details.quota).toBe("workspace_bytes");
});

test("rate windows count attempts before any work, and uploads check before storing", async () => {
  const f = await fixture({
    siteDataViewerWritesPerMinute: 2,
    siteDataViewerReadsPerMinute: 2,
    siteDataFileBytesPerSite: 20,
  });
  const created = await f.publish("Limits");
  const s = f.site(created.id);
  const frame = { "x-opengeni-site-id": created.id };
  await s.define(f.owner, "news", { accessMode: "shared_read" });
  await s.define(f.owner, "notes", { accessMode: "shared" });
  // Refused writes count: two forbidden attempts use the viewer's window.
  for (let index = 0; index < 2; index += 1)
    expect(
      (await s.write(f.member, [{ op: "insert", collection: "news", data: { i: index } }])).status,
    ).toBe(403);
  const limited = await s.write(f.member, [
    { op: "insert", collection: "notes", data: { ok: true } },
  ]);
  expect(limited.status).toBe(429);
  expect(errorCode(limited)).toBe("rate_limited");
  // Another viewer has their own window.
  expect(
    (await s.write(f.third, [{ op: "insert", collection: "notes", data: { ok: true } }])).status,
  ).toBe(200);
  // An upload over the window never reaches storage.
  const before = f.objects.size;
  const throttled = await s.request(f.member, "POST", "/files?name=a.png", PNG, {
    "content-type": "image/png",
    ...frame,
  });
  expect(throttled.status).toBe(429);
  // An upload over the quota never reaches storage either.
  const tooMuch = await s.request(f.owner, "POST", "/files?name=b.bin", new Uint8Array(30), {
    "content-type": "application/octet-stream",
  });
  expect(tooMuch.status).toBe(413);
  expect(tooMuch.json.error.details.quota).toBe("site_file_bytes");
  expect(f.objects.size).toBe(before);
  // A body without Content-Length is cut off at the per-file cap while streaming.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 20; index += 1) controller.enqueue(new Uint8Array(1024 * 1024));
      controller.close();
    },
  });
  const streamed = await f.app.request(
    `/v1/workspaces/${f.workspace.id}/published-artifacts/${created.id}/files?name=big.bin`,
    {
      method: "POST",
      headers: { ...f.owner.headers, "content-type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    } as RequestInit,
  );
  expect(streamed.status).toBe(413);
  expect(f.objects.size).toBe(before);
  // Site frames get a generous read window; reads outside a frame are not windowed.
  const reads: number[] = [];
  for (let index = 0; index < 3; index += 1)
    reads.push((await s.query(f.third, { collection: "notes" }, frame)).status);
  expect(reads).toEqual([200, 200, 429]);
  expect((await s.query(f.third, { collection: "notes" })).status).toBe(200);
});

test("CSV exports neutralize formulas and cap their columns", async () => {
  const f = await fixture();
  const s = f.site((await f.publish("Export")).id);
  await s.define(f.owner, "rows", { accessMode: "shared" });
  await s.write(f.member, [
    { op: "insert", collection: "rows", data: { a: '=HYPERLINK("x")', b: -5, c: "+1", d: "@x" } },
  ]);
  const csv = await s.request(f.owner, "GET", "/data/collections/rows/export?format=csv");
  expect(csv.status).toBe(200);
  const [header, row] = (csv.json as string).split("\r\n");
  expect(header).toBe("$id,$key,$owner,$createdAt,$updatedAt,a,b,c,d");
  expect(row!.split(",").slice(-4)).toEqual(['"\'=HYPERLINK(""x"")"', "-5", "'+1", "'@x"]);
  // A viewer cannot blow up the export's width.
  const wideData = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i]));
  await s.write(f.member, [{ op: "insert", collection: "rows", data: wideData }]);
  const wide = await s.request(f.owner, "GET", "/data/collections/rows/export?format=csv");
  const [wideHeader, ...rows] = (wide.json as string).trim().split("\r\n");
  expect(wideHeader).toBe("$id,$key,$owner,$createdAt,$updatedAt,$data");
  expect(rows).toHaveLength(2);
});

test("CSV import builds each row in one pass and caps width and rows before building", async () => {
  const { siteDataCsvRecords } = await import("../src/site-data/operations");
  // 1,000 columns (half of them nested) by 1,000 rows: linear, not columns squared.
  const header = Array.from({ length: 1000 }, (_, index) =>
    index % 2 === 0 ? `c${index}` : `g${index % 50}.f${index}`,
  ).join(",");
  const row = Array.from({ length: 1000 }, () => "v").join(",");
  const csv = `${header}\n${Array.from({ length: 1000 }, () => row).join("\n")}`;
  const started = performance.now();
  const records = siteDataCsvRecords(csv);
  const elapsed = performance.now() - started;
  expect(records).toHaveLength(1000);
  expect(elapsed).toBeLessThan(5_000);
  expect(Object.getPrototypeOf(records[0])).toBeNull();
  expect(records[0]!.c0).toBe("v");
  expect((records[0]!.g1 as Record<string, unknown>).f1).toBe("v");
  expect(Object.keys(records[0]!)).toHaveLength(525);

  const f = await fixture();
  const s = f.site((await f.publish("Import limits")).id);
  await s.define(f.owner, "rows", { accessMode: "shared" });
  const importCsv = (text: string) =>
    s.request(f.owner, "POST", "/data/collections/rows/import", { format: "csv", csv: text });
  const tooWide = await importCsv(
    `${Array.from({ length: 1001 }, (_, index) => `c${index}`).join(",")}\n1\n`,
  );
  expect(tooWide.status).toBe(422);
  expect(tooWide.json.error.message).toContain("more than 1000 columns");
  // A wide data row is refused as well, even under a narrow header.
  const wideRow = await importCsv(`a\n${Array.from({ length: 1001 }, () => "1").join(",")}\n`);
  expect(wideRow.status).toBe(422);
  const tooLong = await importCsv(`a\n${Array.from({ length: 1001 }, (_, i) => i).join("\n")}\n`);
  expect(tooLong.status).toBe(422);
  expect(tooLong.json.error.message).toContain("Import at most 1000 records");
  const nested = await importCsv("name,address.city\nAda,London\n");
  expect(nested.json).toEqual({ imported: 1 });
  const stored = await s.query(f.owner, { collection: "rows" });
  expect(stored.json.records[0].data).toEqual({ name: "Ada", address: { city: "London" } });
});

test("agents started from a Site page get that page's viewer reach", async () => {
  const f = await fixture();
  const created = await f.publish("Tracker");
  const other = await f.publish("Other");
  const s = f.site(created.id);
  await s.define(f.owner, "habits", { accessMode: "per_viewer" });
  await s.define(f.owner, "shared", { accessMode: "shared" });
  await f.site(other.id).define(f.owner, "notes", { accessMode: "shared" });
  await s.write(f.member, [{ op: "insert", collection: "habits", data: { who: "member" } }]);
  await s.write(f.owner, [{ op: "insert", collection: "habits", data: { who: "owner" } }]);
  const origin = { _opengeniSiteOrigin: { siteId: created.id, title: "Tracker" } };
  const checkClamped = async (agent: Awaited<ReturnType<typeof agentTools>>) => {
    for (const [tool, args] of [
      ["site_data_describe", { siteId: created.id }],
      ["site_data_define_collection", { siteId: created.id, name: "x", accessMode: "shared" }],
      ["site_data_reset", { siteId: created.id, collection: "habits", confirm: true }],
      ["site_data_export", { siteId: created.id, collection: "habits", format: "json" }],
      [
        "site_data_import",
        { siteId: created.id, collection: "shared", format: "json", records: [{ a: 1 }] },
      ],
    ] as const) {
      const refused = await agent.callTool(tool, args);
      expect(refused.isError, tool).toBe(true);
      expect(refused.value.error.code, tool).toBe("forbidden");
    }
    // The owner's agent sees only the owner's own per-viewer records, as the page would.
    const own = await agent.callTool("site_data_query", {
      siteId: created.id,
      collection: "habits",
    });
    expect(own.isError, JSON.stringify(own.value)).toBe(false);
    expect(own.value.records.map((record: any) => record.data.who)).toEqual(["owner"]);
    const all = await agent.callTool("site_data_query", {
      siteId: created.id,
      collection: "habits",
      scope: "all",
    });
    expect(all.isError ? "forbidden" : all.value.records.length).not.toBe(2);
    // Viewer writes still work within the page's own Site.
    const wrote = await agent.callTool("site_data_write", {
      siteId: created.id,
      operations: [{ op: "insert", collection: "shared", data: { from: "agent" } }],
    });
    expect(wrote.isError, JSON.stringify(wrote.value)).toBe(false);
    // Another Site is out of reach.
    const elsewhere = await agent.callTool("site_data_query", {
      siteId: other.id,
      collection: "notes",
    });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.value.error.code).toBe("forbidden");
  };

  // A session the page created.
  const fromPage = await agentTools(f, { metadata: origin });
  try {
    await checkClamped(fromPage);
  } finally {
    await fromPage.mcp.close();
  }
  // A worker spawned by that session inherits the clamp through its lineage.
  const worker = await agentTools(f, { parentSessionId: fromPage.session.id });
  try {
    await checkClamped(worker);
  } finally {
    await worker.mcp.close();
  }
  // A message the page sent into a session without a Site origin reaches no Site Data.
  const sent = await agentTools(f, { surface: "site" });
  try {
    const refused = await sent.callTool("site_data_query", {
      siteId: created.id,
      collection: "habits",
    });
    expect(refused.isError).toBe(true);
    expect(refused.value.error.code).toBe("forbidden");
  } finally {
    await sent.mcp.close();
  }
  // The same owner's agent outside any Site keeps manager reach.
  const plain = await agentTools(f);
  try {
    const all = await plain.callTool("site_data_query", {
      siteId: created.id,
      collection: "habits",
      scope: "all",
    });
    expect(all.isError, JSON.stringify(all.value)).toBe(false);
    expect(all.value.records).toHaveLength(2);
  } finally {
    await plain.mcp.close();
  }
});

test("a person-less scheduled task keeps one principal across runs", async () => {
  const f = await fixture();
  const created = await f.publish("Digest");
  const s = f.site(created.id);
  await s.define(f.owner, "seen", { accessMode: "per_viewer" });
  const taskId = crypto.randomUUID();
  const run = async () => {
    const agent = await agentTools(f, { initiatorSubjectId: null });
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into scheduled_task_runs (task_id, trigger_type, status, account_id, workspace_id, session_id, fired_at)
        values (${taskId}, 'schedule', 'running', ${f.accountId}, ${f.workspace.id}, ${agent.session.id}, now())`;
    });
    return agent;
  };
  const first = await run();
  try {
    const wrote = await first.callTool("site_data_write", {
      siteId: created.id,
      operations: [{ op: "put", collection: "seen", key: "item-1", data: { seen: true } }],
    });
    expect(wrote.isError, JSON.stringify(wrote.value)).toBe(false);
    expect(wrote.value.results[0].record).toMatchObject({
      owner: `schedule:${taskId}`,
      updatedBy: `agent:session:${first.session.id}`,
    });
  } finally {
    await first.mcp.close();
  }
  // The next run of the same schedule sees its own records.
  const second = await run();
  try {
    const seen = await second.callTool("site_data_query", {
      siteId: created.id,
      collection: "seen",
    });
    expect(seen.value.records.map((record: any) => record.key)).toEqual(["item-1"]);
  } finally {
    await second.mcp.close();
  }
  // A person-less agent outside the schedule owns records as its own session.
  const loose = await agentTools(f, { initiatorSubjectId: null });
  try {
    const seen = await loose.callTool("site_data_query", {
      siteId: created.id,
      collection: "seen",
    });
    expect(seen.isError, JSON.stringify(seen.value)).toBe(false);
    expect(seen.value.records).toEqual([]);
  } finally {
    await loose.mcp.close();
  }
  const { siteDataPrincipal } = await import("../src/site-data/service");
  const grant = {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    subjectId: "worker",
    permissions: [],
    principalKind: "agent_attempt",
    metadata: { sessionId: "s1" },
  } as AccessGrant;
  expect(siteDataPrincipal(grant, null, "t1")).toBe("schedule:t1");
  expect(siteDataPrincipal(grant, null)).toBe("agent:session:s1");
  expect(siteDataPrincipal(grant, "person", "t1")).toBe("user:person");
});

test("uploads are refused before their body is read", async () => {
  const f = await fixture({ siteDataViewerWritesPerMinute: 1, siteDataFileBytesPerSite: 64 });
  const created = await f.publish("Intake");
  const privateSite = await f.publish("Mine", "private");
  let pulls = 0;
  const watched = () =>
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024));
          if (pulls > 1000) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
  const upload = (siteId: string, who: Who, headers: Record<string, string> = {}) =>
    f.app.request(
      `/v1/workspaces/${f.workspace.id}/published-artifacts/${siteId}/files?name=a.bin`,
      {
        method: "POST",
        headers: { ...who.headers, "content-type": "application/octet-stream", ...headers },
        body: watched(),
        duplex: "half",
      } as RequestInit,
    );
  // Not visible to the viewer (Only me Site): refused unread.
  expect((await upload(privateSite.id, f.member)).status).toBe(404);
  expect(pulls).toBe(0);
  // Over the declared quota: refused unread.
  expect((await upload(created.id, f.owner, { "content-length": "1000000" })).status).toBe(413);
  expect(pulls).toBe(0);
  // Over the viewer's write window: refused unread.
  const first = await f.site(created.id).request(f.member, "POST", "/files?name=a.png", PNG, {
    "content-type": "image/png",
  });
  expect(first.status).toBe(201);
  expect((await upload(created.id, f.member)).status).toBe(429);
  expect(pulls).toBe(0);
});
