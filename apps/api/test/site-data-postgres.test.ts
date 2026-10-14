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
  getSiteDataAgentSession,
  SiteDataError,
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
  await withinOneMinute(async () => {
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
    expect(third.json.error.details).toMatchObject({
      code: "quota_exceeded",
      quota: "collections",
    });

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
  const grant: AccessGrant = {
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
  };
  const server = buildOpenGeniMcpServer(f.deps as unknown as ApiRouteDeps, grant);
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
  return { session, turnId: turn!.id, grant, mcp, callTool };
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
  const strings = (count: number, prefix = "p") =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`${prefix}${index}`, { type: "string" }]),
    );
  const branches = (count: number, each: () => unknown) => Array.from({ length: count }, each);
  // Wide sibling properties are cheap; fan-out on repeated values is not.
  const tooWide = { type: "object", properties: strings(1001) };
  const fanOut = {
    type: "array",
    items: { anyOf: branches(16, () => ({ anyOf: branches(6, () => ({ type: "string" })) })) },
  };
  // A thousand properties make a validator too large to run optimized: fan-out counts 4×.
  const largeFanOut = {
    type: "object",
    properties: {
      ...strings(999, "t"),
      list: {
        type: "array",
        items: { anyOf: branches(5, () => ({ anyOf: branches(4, () => ({ type: "string" })) })) },
      },
    },
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
    [tooWide, "more than 1000 properties"],
    [fanOut, "too costly to check on repeated values (cost 673"],
    [largeFanOut, "is large, so it is too costly"],
    [{ anyOf: Array.from({ length: 17 }, () => ({ type: "string" })) }, "more than 16 schemas"],
    [
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 6 }, (_, field) => [
            `f${field}`,
            { enum: Array.from({ length: 100 }, (_unused, index) => `v${index}`) },
          ]),
        ),
      },
      "more than 500 enum values",
    ],
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
  // As wide as a CSV import: 1,000 properties, and a record that fills them.
  const wide = await a.define(f.owner, "wide", {
    accessMode: "shared",
    jsonSchema: { type: "object", properties: strings(1000), required: ["p0", "p999"] },
  });
  expect(wide.status, JSON.stringify(wide.json).slice(0, 300)).toBe(201);
  const full = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`p${index}`, "v"]));
  expect((await a.write(f.owner, [{ op: "insert", collection: "wide", data: full }])).status).toBe(
    200,
  );
  expect(
    (await a.write(f.owner, [{ op: "insert", collection: "wide", data: { p0: "v" } }])).status,
  ).toBe(422);
  // The same fan-out under a small schema is allowed (cost 151).
  const { siteDataSchemaRepeatedCost } = await import("../src/site-data/service");
  const smallFanOut = { type: "object", properties: { list: largeFanOut.properties.list } };
  expect(siteDataSchemaRepeatedCost(smallFanOut)).toBe(151);
  expect(
    (await a.define(f.owner, "fan", { accessMode: "shared", jsonSchema: smallFanOut })).status,
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
  // a merged patch still is, and a changed schema is a retryable conflict.
  expect(options.validate!({ ...schema }, valid)).toBeNull();
  expect(options.validate!(schema, { name: "toolong" })).toContain("name");
  expect(() => options.validate!({ type: "object", required: ["other"] }, valid)).toThrow(
    "schema changed",
  );
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
  await withinOneMinute(async () => {
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
        (await s.write(f.member, [{ op: "insert", collection: "news", data: { i: index } }]))
          .status,
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
  await withinOneMinute(async () => {
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
});

/** The costliest schema the cost model allows: 96 failing branches on every array element. */
function costliestSchema() {
  const strings = (count: number) => Array.from({ length: count }, () => ({ type: "string" }));
  return {
    type: "object",
    properties: {
      v: {
        type: "array",
        items: {
          anyOf: [
            ...Array.from({ length: 15 }, () => ({ anyOf: strings(5) })),
            { anyOf: [...strings(4), { type: "number" }] },
          ],
        },
      },
    },
  };
}

/** The previous flat cap's costliest schema: 5 × 16 branches with 500 enum values. */
function previousCostliestSchema() {
  const branches = (set: number) => ({
    anyOf: [
      ...Array.from({ length: 15 }, (_branchSlot, branch) => ({
        enum: Array.from(
          { length: branch < 5 ? 7 : 6 },
          (_, value) => `s${set}-${branch}-${value}`,
        ),
      })),
      { type: "number" },
    ],
  });
  return {
    type: "object",
    properties: {
      v: { type: "array", items: { allOf: Array.from({ length: 5 }, (_, set) => branches(set)) } },
    },
  };
}

/**
 * Measure every compile and validation as `ms` milliseconds, whatever it
 * really takes, so budgets and charges never depend on machine speed.
 */
async function withValidationClock<T>(ms: () => number, run: () => Promise<T>): Promise<T> {
  const { siteDataValidationClock } = await import("../src/site-data/service");
  const real = siteDataValidationClock.now;
  let now = 0;
  siteDataValidationClock.now = () => (now += ms());
  try {
    return await run();
  } finally {
    siteDataValidationClock.now = real;
  }
}

/**
 * Rate windows are wall-clock minutes. Run a block that counts against them
 * (creating its own fixtures) once more if a minute boundary fell inside it,
 * whether it returned or failed, so no result depends on when it ran.
 */
async function withinOneMinute<T>(run: () => Promise<T>): Promise<T> {
  const minute = async () =>
    String((await shared.admin`select date_trunc('minute', now())::text as m`)[0]!.m);
  for (let attempt = 0; ; attempt += 1) {
    const before = await minute();
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (attempt > 0 || (await minute()) === before) throw error;
      continue;
    }
    if (attempt > 0 || (await minute()) === before) return result;
  }
}

async function rateWindows(f: Fixture, siteId: string) {
  const rows = await shared.admin<{ principal_key: string; operations: number }[]>`
    select principal_key, operations from site_data_rate_windows
    where workspace_id = ${f.workspace.id} and site_id = ${siteId}`;
  return Object.fromEntries(rows.map((row) => [row.principal_key, Number(row.operations)]));
}

/** Validation time on the workspace's window, or on one Site's. */
async function validationMicros(f: Fixture, siteId?: string) {
  const rows = siteId
    ? await shared.admin<{ validation_micros: string }[]>`
        select validation_micros from site_data_validation_windows
        where workspace_id = ${f.workspace.id} and site_id = ${siteId}`
    : await shared.admin<{ validation_micros: string }[]>`
        select validation_micros from site_data_workspace_validation_windows
        where workspace_id = ${f.workspace.id}`;
  return rows[0] ? Number(rows[0].validation_micros) : 0;
}

async function validationRows(f: Fixture) {
  const [row] = await shared.admin<{ sites: number; workspaces: number }[]>`
    select
      (select count(*)::int from site_data_validation_windows where workspace_id = ${f.workspace.id}) as sites,
      (select count(*)::int from site_data_workspace_validation_windows where workspace_id = ${f.workspace.id}) as workspaces`;
  return row!;
}

test("worst-case validation is bounded by the cost model, request size and time budget", async () => {
  const { SITE_DATA_MAX_SCHEMA_REPEATED_COST, siteDataSchemaProblem, siteDataSchemaRepeatedCost } =
    await import("../src/site-data/service");
  const schema = costliestSchema();
  expect(siteDataSchemaProblem(schema)).toBeNull();
  expect(siteDataSchemaRepeatedCost(schema)).toBe(577);
  expect(siteDataSchemaRepeatedCost(schema)).toBeLessThanOrEqual(
    SITE_DATA_MAX_SCHEMA_REPEATED_COST,
  );
  // The flat cap's costliest schema runs more checks per element and is refused now.
  expect(siteDataSchemaProblem(previousCostliestSchema())).toContain("too costly");
  const result = await withinOneMinute(async () => {
    const f = await fixture();
    const created = await f.publish("Costly");
    const s = f.site(created.id);
    // A 256 KB record of numbers: every element fails 95 branches before matching.
    const record = { v: Array.from({ length: 128 * 1024 - 10 }, () => 1) };
    let step = 0;
    return withValidationClock(
      () => step,
      async () => {
        const defined = await s.define(f.owner, "rows", {
          accessMode: "shared",
          jsonSchema: schema,
        });
        // More than 4 MB of records in one request is refused before any validation.
        const tooBig = await s.write(
          f.owner,
          Array.from({ length: 17 }, () => ({ op: "insert", collection: "rows", data: record })),
        );
        // Each compile or record takes 100 ms: compile, record 0 (200 ms), record 1
        // (300 ms), then record 2 is over the 250 ms budget and refused before it runs.
        step = 100;
        const costly = await s.write(
          f.owner,
          Array.from({ length: 16 }, () => ({ op: "insert", collection: "rows", data: record })),
        );
        const stored = (await s.query(f.owner, { collection: "rows", count: true })).json.count;
        // One record always completes, however long it takes: 1 s compile, 1 s record.
        step = 1_000;
        const one = await s.write(f.owner, [{ op: "insert", collection: "rows", data: record }]);
        step = 0;
        return {
          defined: defined.status,
          tooBig,
          costly,
          stored,
          one: one.status,
          windows: await rateWindows(f, created.id),
          micros: await validationMicros(f),
          siteMicros: await validationMicros(f, created.id),
        };
      },
    );
  });
  expect(result.defined).toBe(201);
  expect(result.tooBig.status).toBe(413);
  expect(result.tooBig.json.error.details.quota).toBe("request_bytes");
  expect(result.costly.status).toBe(422);
  expect(result.costly.json.error.details).toMatchObject({ reason: "validation_budget", index: 2 });
  expect(result.stored).toBe(0);
  expect(result.one).toBe(200);
  // Managers' window: define 1, the 17-record attempt 17, the 16-record attempt 16
  // plus 300 ms / 5 = 60, the single record 1 plus 2,000 ms / 5 = 400.
  expect(result.windows["manager:*"]).toBe(1 + 17 + 16 + 60 + 1 + 400);
  // Reservations were all replaced by the time spent: 300 ms + 2,000 ms.
  expect(result.micros).toBe(2_300_000);
  expect(result.siteMicros).toBe(2_300_000);
});

test("validation windows refuse only requests that would validate", async () => {
  const result = await withinOneMinute(async () => {
    const f = await fixture({
      siteDataViewerWritesPerMinute: 10,
      siteDataSiteValidationMsPerMinute: 1_000,
    });
    const created = await f.publish("Charged A");
    const a = f.site(created.id);
    const b = f.site((await f.publish("Charged B")).id);
    const jsonSchema = { type: "object", properties: { n: { type: "number" } } };
    let step = 0;
    return withValidationClock(
      () => step,
      async () => {
        for (const site of [a, b]) {
          await site.define(f.owner, "rows", { accessMode: "shared", jsonSchema });
          await site.define(f.owner, "plain", { accessMode: "shared" });
        }
        const insert = (collection = "rows") => [{ op: "insert", collection, data: { n: 1 } }];
        step = 100;
        // A viewer's write that spends 200 ms counts 1 + 40 operations.
        const viewer = await a.write(f.member, insert());
        const viewerAgain = await a.write(f.member, insert());
        // Another viewer has their own window (and spends nothing here).
        step = 0;
        const other = await a.write(f.third, insert());
        const keyed = await a.write(f.owner, [
          { op: "put", collection: "rows", key: "k", data: { n: 1 } },
        ]);
        // 200 ms settled so far: this write reserves within the 1 s window and spends 1.2 s.
        step = 600;
        const heavy = await a.write(f.owner, insert());
        step = 0;
        const siteMicros = await validationMicros(f, created.id);
        // The Site's window is spent: requests that would validate are refused,
        // for a viewer whose own window still has room too...
        const refused = [
          await a.write(f.owner, insert()),
          await a.write(f.third, insert()),
          await a.define(f.owner, "typed", { accessMode: "shared", jsonSchema }),
          await a.request(f.owner, "POST", "/data/collections/rows/import", {
            format: "json",
            records: [{ n: 2 }],
          }),
        ];
        // ...and everything else goes through, so a manager can remove the schema.
        const upload = await a.request(f.owner, "POST", "/files?name=a.bin", new Uint8Array(8), {
          "content-type": "application/octet-stream",
        });
        const allowed = [
          await a.write(f.owner, insert("plain")),
          await a.write(f.owner, [{ op: "delete", collection: "rows", key: "k" }]),
          upload,
          await a.request(f.owner, "DELETE", `/files/${upload.json?.file?.id ?? upload.json?.id}`),
          await a.define(f.owner, "loose", { accessMode: "shared" }),
          await a.request(f.owner, "POST", "/data/collections/plain/reset", { confirm: true }),
          await a.request(f.owner, "DELETE", "/data/collections/loose?confirm=true"),
          await a.define(f.owner, "rows", { accessMode: "shared", jsonSchema: null }),
        ];
        // Without its schema the collection takes writes again.
        allowed.push(await a.write(f.owner, insert()));
        // Another Site has its own window.
        const elsewhere = await b.write(f.owner, insert());
        return {
          viewer,
          viewerAgain,
          other,
          keyed,
          heavy,
          siteMicros,
          refused,
          allowed,
          elsewhere,
          workspaceMicros: await validationMicros(f),
          windows: await rateWindows(f, created.id),
          memberPrincipal: `user:${f.member.subjectId}`,
        };
      },
    );
  });
  expect(result.viewer.status).toBe(200);
  expect(result.viewerAgain.status).toBe(429);
  expect(result.viewerAgain.json.error.message).toContain("Too many writes");
  expect(result.windows[result.memberPrincipal]).toBe(1 + 40);
  expect(result.other.status).toBe(200);
  expect(result.keyed.status).toBe(200);
  expect(result.heavy.status).toBe(200);
  // 200 + 0 + 1,200 ms settled; every reservation was replaced by the time spent.
  expect(result.siteMicros).toBe(1_400_000);
  for (const refused of result.refused) {
    expect(refused.status, JSON.stringify(refused.json)).toBe(429);
    expect(refused.json.error.details.quota).toBe("site_validation_time");
  }
  for (const allowed of result.allowed)
    expect(allowed.status, JSON.stringify(allowed.json)).toBeLessThan(300);
  expect(result.elsewhere.status).toBe(200);
  expect(result.workspaceMicros).toBe(1_400_000);
});

test("the workspace validation window is a ceiling across its Sites", async () => {
  const result = await withinOneMinute(async () => {
    const f = await fixture({ siteDataWorkspaceValidationMsPerMinute: 1_000 });
    const a = f.site((await f.publish("Ceiling A")).id);
    const b = f.site((await f.publish("Ceiling B")).id);
    const jsonSchema = { type: "object", properties: { n: { type: "number" } } };
    let step = 0;
    return withValidationClock(
      () => step,
      async () => {
        for (const site of [a, b]) {
          await site.define(f.owner, "rows", { accessMode: "shared", jsonSchema });
          await site.define(f.owner, "plain", { accessMode: "shared" });
        }
        const insert = (collection = "rows") => [{ op: "insert", collection, data: { n: 1 } }];
        step = 600;
        const heavy = await a.write(f.owner, insert());
        step = 0;
        const refused = await b.write(f.member, insert());
        const plain = await b.write(f.member, insert("plain"));
        // Another workspace has its own ceiling.
        const g = await fixture({ siteDataWorkspaceValidationMsPerMinute: 1_000 });
        const c = g.site((await g.publish("Elsewhere")).id);
        await c.define(g.owner, "rows", { accessMode: "shared", jsonSchema });
        const elsewhere = await c.write(g.owner, insert());
        return { heavy, refused, plain, elsewhere };
      },
    );
  });
  expect(result.heavy.status).toBe(200);
  expect(result.refused.status).toBe(429);
  expect(errorCode(result.refused)).toBe("rate_limited");
  expect(result.refused.json.error.details.quota).toBe("workspace_validation_time");
  expect(result.plain.status).toBe(200);
  expect(result.elsewhere.status).toBe(200);
});

test("admission reserves time, so concurrent large requests cannot overshoot", async () => {
  const { resolveSiteDataAccess } = await import("../src/site-data/service");
  await withinOneMinute(async () => {
    const f = await fixture({ siteDataSiteValidationMsPerMinute: 1_000 });
    const created = await f.publish("Reserved");
    const s = f.site(created.id);
    await withValidationClock(
      () => 0,
      async () => {
        await s.define(f.owner, "rows", {
          accessMode: "shared",
          jsonSchema: { type: "object", properties: { n: { type: "number" } } },
        });
        await s.define(f.owner, "plain", { accessMode: "shared" });
      },
    );
    const access = await resolveSiteDataAccess(f.deps as never, f.owner.grant, created.id);
    let windowStartedAt: number | null = null;
    // Large requests reserve the whole 250 ms budget.
    const admit = (collections: string[] = ["rows"]) =>
      access.store
        .consumeRate(access.caller, "write", 1, access.limits, { collections, reserveMs: 250 })
        .then(
          (admitted) => {
            if (admitted.reservedMs > 0) windowStartedAt = admitted.windowStartedAt;
            return admitted.reservedMs;
          },
          (error: any) => error.code as string,
        );
    // Six requests in flight at once: four reservations of 250 ms fill the 1 s window.
    const results = await Promise.all(Array.from({ length: 6 }, () => admit()));
    expect(windowStartedAt).not.toBeNull();
    expect(results.filter((reserved) => reserved === 250)).toHaveLength(4);
    expect(results.filter((reserved) => reserved === "rate_limited")).toHaveLength(2);
    expect(await validationMicros(f, created.id)).toBe(1_000_000);
    // Settling charges what was spent, to the microsecond...
    await access.store.settleValidation(
      access.caller,
      { reservedMs: 250, windowStartedAt, spentMs: 0.5 },
      access.limits,
    );
    expect(await validationMicros(f, created.id)).toBe(750_500);
    // ...so 750.5 ms + another 250 ms reservation no longer fits in 1 s.
    expect(await admit()).toBe("rate_limited");
    // A request that spent nothing refunds its whole reservation.
    await access.store.settleValidation(
      access.caller,
      { reservedMs: 250, windowStartedAt, spentMs: 0 },
      access.limits,
    );
    expect(await validationMicros(f, created.id)).toBe(500_500);
    // 500.5 ms + 250 fits once; a second would reach 1,000.5 ms.
    expect(await admit()).toBe(250);
    expect(await admit()).toBe("rate_limited");
    // Collections without a schema reserve nothing.
    expect(await admit(["plain"])).toBe(0);
  });
});

test("small validating requests reserve little, so many run at once", async () => {
  const { siteDataValidationReservationMs, siteDataValidationBytes } =
    await import("../src/site-data/service");
  // 25 ms plus 1 µs per byte, capped at the 250 ms budget.
  expect(siteDataValidationReservationMs(0)).toBe(25);
  expect(siteDataValidationReservationMs(10_000)).toBe(35);
  expect(siteDataValidationReservationMs(225_000)).toBe(250);
  expect(siteDataValidationReservationMs(4 * 1024 * 1024)).toBe(250);
  expect(siteDataValidationBytes([{ n: 1 }, undefined, "ab"])).toBe(7 + 4);
  // Counting stops once the reservation reaches the budget.
  expect(siteDataValidationBytes([{ big: "x".repeat(300_000) }, { more: 1 }])).toBeLessThan(
    300_100,
  );
  // With the default limits, a page inserting 25 items at once with
  // Promise.all succeeds: a fixed 250 ms reservation would have let only 20
  // in.
  const f = await fixture();
  const s = f.site((await f.publish("Burst")).id);
  await s.define(f.owner, "items", {
    accessMode: "shared",
    jsonSchema: { type: "object", properties: { n: { type: "number" } } },
  });
  const writes = await Promise.all(
    Array.from({ length: 25 }, (_, n) =>
      s.write(f.member, [{ op: "insert", collection: "items", data: { n } }]),
    ),
  );
  expect(writes.map((write) => write.status)).toEqual(Array.from({ length: 25 }, () => 200));
  expect((await s.query(f.member, { collection: "items", limit: 100 })).json.records).toHaveLength(
    25,
  );
});

/** Shared collections `big` (two large keyed records) and `small` (25), then a schema on both. */
async function mergeFixture(overrides: Partial<Settings> = {}) {
  const f = await fixture(overrides);
  const created = await f.publish("Merges");
  const s = f.site(created.id);
  const jsonSchema = {
    type: "object",
    properties: { n: { type: "number" }, pad: { type: "string" } },
  };
  // Records go in before the schema, so creating them reserves nothing.
  for (const name of ["big", "small"]) await s.define(f.owner, name, { accessMode: "shared" });
  const big = (pad: number) => ({ n: 0, pad: "x".repeat(pad) });
  expect(
    (
      await s.write(f.owner, [
        { op: "put", collection: "big", key: "huge", data: big(255_000) },
        { op: "put", collection: "big", key: "medium", data: big(100_000) },
      ])
    ).status,
  ).toBe(200);
  expect(
    (
      await s.write(
        f.owner,
        Array.from({ length: 25 }, (_, n) => ({
          op: "put",
          collection: "small",
          key: `k${n}`,
          data: { n },
        })),
      )
    ).status,
  ).toBe(200);
  // Compiling the schema spends nothing, so every window starts empty.
  await withValidationClock(
    () => 0,
    async () => {
      for (const name of ["big", "small"])
        await s.define(f.owner, name, { accessMode: "shared", jsonSchema });
    },
  );
  const sizes = Object.fromEntries(
    (
      await shared.admin<{ record_key: string; size_bytes: number }[]>`
        select record_key, size_bytes from site_data_records
        where site_id = ${created.id} and record_key in ('huge', 'medium')`
    ).map((row) => [row.record_key, row.size_bytes]),
  ) as Record<"huge" | "medium", number>;
  return { f, s, created, sizes };
}

test("patches and increments reserve for the stored records they merge into", async () => {
  await withinOneMinute(async () => {
    const { resolveSiteDataAccess } = await import("../src/site-data/service");
    const { f, created, sizes } = await mergeFixture();
    expect(sizes.huge).toBeGreaterThan(255_000);
    expect(sizes.medium).toBeGreaterThan(100_000);
    const access = await resolveSiteDataAccess(f.deps as never, f.owner.grant, created.id);
    // What the routes send for a one-op patch or increment: 25 ms for the
    // bytes sent, plus 1 µs per stored byte, capped at 250 ms.
    const admit = (touched: { collection: string; key?: string; id?: string }[]) =>
      access.store
        .consumeRate(access.caller, "write", 1, access.limits, {
          collections: touched.map((ref) => ref.collection),
          reserveMs: 25,
          touched,
          reserveMsPerStoredByte: 0.001,
          maxReserveMs: 250,
        })
        .then(async (reservation) => {
          await access.store.settleValidation(
            access.caller,
            { ...reservation, spentMs: 0 },
            access.limits,
          );
          return reservation.reservedMs;
        });
    // A tiny patch into a 256 KB record reserves the whole budget.
    expect(await admit([{ collection: "big", key: "huge" }])).toBe(250);
    // An increment into a 100 KB record reserves for its size.
    expect(await admit([{ collection: "big", key: "medium" }])).toBeCloseTo(
      25 + sizes.medium / 1000,
      3,
    );
    // Small and missing records add little or nothing.
    expect(await admit([{ collection: "small", key: "k1" }])).toBeLessThan(25.1);
    expect(await admit([{ collection: "big", key: "missing" }])).toBe(25);
    expect(await admit([{ collection: "big", id: crypto.randomUUID() }])).toBe(25);
    // Several merges add up, still within the cap.
    expect(
      await admit([
        { collection: "big", key: "medium" },
        { collection: "big", key: "medium" },
      ]),
    ).toBeCloseTo(25 + (2 * sizes.medium) / 1000, 3);
    expect(
      await admit([
        { collection: "big", key: "medium" },
        { collection: "big", key: "huge" },
      ]),
    ).toBe(250);
    expect(await validationMicros(f, created.id)).toBe(0);
  });
});

test("the routes reserve for merged records, refusing what the window cannot take", async () => {
  await withinOneMinute(async () => {
    // A 240 ms window: a merge into the 256 KB record needs 250 ms and the
    // 100 KB one about 125 ms; small records need about 25 ms.
    const { f, s } = await mergeFixture({ siteDataSiteValidationMsPerMinute: 240 });
    let step = 0;
    await withValidationClock(
      () => step,
      async () => {
        const patchHuge = await s.write(f.member, [
          { op: "patch", collection: "big", key: "huge", data: { n: 1 } },
        ]);
        expect(patchHuge.status).toBe(429);
        expect(patchHuge.json.error.details.quota).toBe("site_validation_time");
        const bumpHuge = await s.write(f.member, [
          { op: "increment", collection: "big", key: "huge", field: "n" },
        ]);
        expect(bumpHuge.status).toBe(429);
        // An increment into the 100 KB record fits (about 125 ms); a request
        // with three (25 + 3 × 100 ms, capped at 250 ms) does not.
        const bumpMedium = await s.write(f.member, [
          { op: "increment", collection: "big", key: "medium", field: "n" },
        ]);
        expect(bumpMedium.status).toBe(200);
        const bumpThrice = await s.write(
          f.member,
          Array.from({ length: 3 }, () => ({
            op: "increment",
            collection: "big",
            key: "medium",
            field: "n",
          })),
        );
        expect(bumpThrice.status).toBe(429);
        const patchSmall = await s.write(f.member, [
          { op: "patch", collection: "small", key: "k0", data: { n: 100 } },
        ]);
        expect(patchSmall.status).toBe(200);
      },
    );
  });
});

test("concurrent tiny patches into large records stop at the window", async () => {
  const { resolveSiteDataAccess } = await import("../src/site-data/service");
  await withinOneMinute(async () => {
    // The default 5 s Site window holds 20 reservations of 250 ms.
    const { f, created } = await mergeFixture();
    const access = await resolveSiteDataAccess(f.deps as never, f.member.grant, created.id);
    // Thirty one-op patches into the 256 KB record admitted at once, held
    // open: only twenty get in, so at most 5 s is reserved, and each stops at
    // its budget plus one record.
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        access.store
          .consumeRate(access.caller, "write", 1, access.limits, {
            collections: ["big"],
            reserveMs: 25,
            touched: [{ collection: "big", key: "huge" }],
            reserveMsPerStoredByte: 0.001,
            maxReserveMs: 250,
          })
          .then(
            (reservation) => reservation.reservedMs,
            (error: any) => error.details?.quota as string,
          ),
      ),
    );
    expect(results.filter((reserved) => reserved === 250)).toHaveLength(20);
    expect(results.filter((reserved) => reserved === "site_validation_time")).toHaveLength(10);
    expect(await validationMicros(f, created.id)).toBe(5_000_000);
  });
});

test("patches admitted before a large write lands are sent again, not checked past their reservation", async () => {
  const { prevalidateSiteDataWrite, resolveSiteDataAccess } =
    await import("../src/site-data/service");
  await withinOneMinute(async () => {
    const { f, s, created } = await mergeFixture();
    const access = await resolveSiteDataAccess(f.deps as never, f.member.grant, created.id);
    const patch = { op: "patch", collection: "small", key: "k0", data: { n: 1 } };
    let checks = 0;
    await withValidationClock(
      () => {
        checks += 1;
        return 0.5;
      },
      async () => {
        // Twenty one-op patches admitted and checked while k0 is small: each
        // reserves about 25 ms.
        const admitted = [];
        for (let i = 0; i < 20; i += 1) {
          const reservation = await access.store.consumeRate(
            access.caller,
            "write",
            1,
            access.limits,
            {
              collections: ["small"],
              reserveMs: 25,
              touched: [{ collection: "small", key: "k0" }],
              reserveMsPerStoredByte: 0.001,
              maxReserveMs: 250,
            },
          );
          expect(reservation.reservedMs).toBeLessThan(25.1);
          const meter = { ms: 0 };
          const options = await prevalidateSiteDataWrite(access, [patch], {
            meter,
            reservedMs: reservation.reservedMs,
          });
          admitted.push({ reservation, meter, options });
        }
        // Then a 256 KB write to the same record lands first.
        const large = { n: 0, pad: "x".repeat(255_000) };
        expect(
          (await s.write(f.owner, [{ op: "put", collection: "small", key: "k0", data: large }]))
            .status,
        ).toBe(200);
        // Under the lock each patch would check the whole 256 KB record:
        // every one is refused before anything is checked.
        const before = checks;
        const results = await Promise.all(
          admitted.map(({ options }) =>
            access.store.write(access.caller, [patch] as never, options).then(
              () => null,
              (error: any) => error,
            ),
          ),
        );
        expect(checks).toBe(before);
        for (const error of results) {
          expect(error?.code).toBe("conflict");
          expect(error?.details).toEqual({ reason: "record_grew", retryable: true });
        }
        const { siteDataHttpError } = await import("../src/routes/site-data");
        expect(siteDataHttpError(results[0]).status).toBe(409);
        for (const { reservation, meter } of admitted)
          await access.store.settleValidation(
            access.caller,
            { ...reservation, spentMs: meter.ms },
            access.limits,
          );
        // Nothing was written, and the windows hold only what was spent.
        const stored = await s.get(f.owner, { collection: "small", key: "k0" });
        expect(stored.json.record.data.pad).toHaveLength(255_000);
        expect(stored.json.record.data.n).toBe(0);
        const spent = admitted.reduce((sum, { meter }) => sum + meter.ms, 0);
        expect(await validationMicros(f, created.id)).toBeLessThanOrEqual(
          Math.ceil((spent + 0.5 * 4) * 1000),
        );
        // A retry reserves for the record's real size and goes through.
        const retry = await s.write(f.member, [patch]);
        expect(retry.status).toBe(200);
        expect((await s.get(f.owner, { collection: "small", key: "k0" })).json.record.data.n).toBe(
          1,
        );
      },
    );
  });
});

test("a large write racing many tiny patches keeps the windows within their bound", async () => {
  await withinOneMinute(async () => {
    const { f, s, created } = await mergeFixture();
    const large = { n: 0, pad: "x".repeat(255_000) };
    const results = await withValidationClock(
      () => 1,
      () =>
        Promise.all([
          s.write(f.owner, [{ op: "put", collection: "small", key: "k1", data: large }]),
          ...Array.from({ length: 30 }, (_, n) =>
            s.write(f.member, [
              { op: "patch", collection: "small", key: "k1", data: { n: n + 1 } },
            ]),
          ),
        ]),
    );
    expect(results[0]!.status).toBe(200);
    for (const result of results.slice(1)) {
      expect([200, 409, 429]).toContain(result.status);
      if (result.status === 409)
        expect(result.json.error.details).toMatchObject({ reason: "record_grew" });
    }
    // At most the Site window, plus 25 ms of slack per request.
    expect(await validationMicros(f, created.id)).toBeLessThanOrEqual(5_000_000 + 31 * 25_000);
    expect(await validationMicros(f)).toBeLessThanOrEqual(20_000_000);
  });
});

test("concurrent increments on a large record are never refused as grown", async () => {
  await withinOneMinute(async () => {
    const { f, s } = await mergeFixture();
    await withValidationClock(
      () => 0,
      async () => {
        const record = { n: 0, pad: "x".repeat(120_000) };
        expect(
          (await s.write(f.owner, [{ op: "put", collection: "big", key: "k120", data: record }]))
            .status,
        ).toBe(200);
        // Each re-check under the lock of a record another increment changed
        // uses what its check before the lock counted: no growth, no 409.
        const bumps = await Promise.all(
          Array.from({ length: 10 }, () =>
            s.write(f.member, [{ op: "increment", collection: "big", key: "k120", field: "n" }]),
          ),
        );
        expect(bumps.map((bump) => bump.status)).toEqual(Array.from({ length: 10 }, () => 200));
        const stored = await s.get(f.owner, { collection: "big", key: "k120" });
        expect(stored.json.record.data.n).toBe(10);
      },
    );
  });
});

test("CSV imports into a collection with a schema are never refused as grown", async () => {
  await withinOneMinute(async () => {
    const f = await fixture();
    const s = f.site((await f.publish("CSV schema")).id);
    const csv = (columns: number, rows: number) => {
      const header = Array.from({ length: columns }, (_, c) => `column_${c}`).join(",");
      const body = Array.from({ length: rows }, (_row, r) =>
        Array.from({ length: columns }, (_, c) => `v${r}x${c}`).join(","),
      );
      return `${header}\n${body.join("\n")}\n`;
    };
    const jsonSchema = {
      type: "object",
      properties: { column_0: { type: "string" }, column_1: { type: "string" } },
    };
    await withValidationClock(
      () => 0,
      async () => {
        for (const [name, columns, rows] of [
          ["narrow", 8, 1_000],
          ["wide", 200, 100],
        ] as const) {
          expect((await s.define(f.owner, name, { accessMode: "shared", jsonSchema })).status).toBe(
            201,
          );
          const imported = await s.request(f.owner, "POST", `/data/collections/${name}/import`, {
            format: "csv",
            csv: csv(columns, rows),
          });
          expect(imported.status, name).toBe(200);
          expect(imported.json.imported, name).toBe(rows);
        }
      },
    );
  });
});

test("25 concurrent small patches on small records all succeed", async () => {
  const { f, s } = await mergeFixture();
  const patches = await Promise.all(
    Array.from({ length: 25 }, (_, n) =>
      s.write(f.member, [{ op: "patch", collection: "small", key: `k${n}`, data: { n: n + 1 } }]),
    ),
  );
  expect(patches.map((patch) => patch.status)).toEqual(Array.from({ length: 25 }, () => 200));
});

test("a reservation is refunded only in the minute it was taken from", async () => {
  const { resolveSiteDataAccess } = await import("../src/site-data/service");
  await withinOneMinute(async () => {
    const f = await fixture();
    const created = await f.publish("Boundary");
    const s = f.site(created.id);
    await withValidationClock(
      () => 0,
      async () =>
        s.define(f.owner, "rows", {
          accessMode: "shared",
          jsonSchema: { type: "object", properties: { n: { type: "number" } } },
        }),
    );
    const access = await resolveSiteDataAccess(f.deps as never, f.owner.grant, created.id);
    const reservation = await access.store.consumeRate(access.caller, "write", 1, access.limits, {
      collections: ["rows"],
      reserveMs: 250,
    });
    const [{ m }] = await shared.admin<{ m: string }[]>`
      select extract(epoch from date_trunc('minute', now()))::bigint::text as m`;
    expect(reservation).toEqual({ reservedMs: 250, windowStartedAt: Number(m) });
    expect(await validationMicros(f, created.id)).toBe(250_000);
    const settle = (windowStartedAt: number | null, spentMs: number) =>
      access.store.settleValidation(
        access.caller,
        { reservedMs: 250, windowStartedAt, spentMs },
        access.limits,
      );
    // Reserved in the previous minute: its refund must not come out of this one...
    await settle(reservation.windowStartedAt! - 60, 0);
    expect(await validationMicros(f, created.id)).toBe(250_000);
    // ...and only time spent beyond the reservation is charged here.
    await settle(reservation.windowStartedAt! - 60, 400);
    expect(await validationMicros(f, created.id)).toBe(400_000);
    await settle(null, 300);
    expect(await validationMicros(f, created.id)).toBe(450_000);
    // In the same minute, the whole difference applies.
    await settle(reservation.windowStartedAt, 0);
    expect(await validationMicros(f, created.id)).toBe(200_000);
  });
});

test("an import that committed batches is not retryable", async () => {
  const { siteDataImportFailure } = await import("../src/site-data/operations");
  const { siteDataHttpError } = await import("../src/routes/site-data");
  const changed = new SiteDataError(
    "conflict",
    "The collection's schema changed while this request was being checked; send it again",
    { reason: "schema_changed", retryable: true },
  );
  // Nothing imported yet: sending it again is safe.
  const before = siteDataImportFailure(changed, 0) as SiteDataError;
  expect(before.details).toEqual({ reason: "schema_changed", retryable: true, imported: 0 });
  expect(siteDataHttpError(before).retryable).toBe(true);
  // After a committed batch, a retry would duplicate it.
  const after = siteDataImportFailure(changed, 100) as SiteDataError;
  expect(after.code).toBe("conflict");
  expect(after.details).toEqual({ reason: "schema_changed", imported: 100 });
  expect(after.message).toContain("100 records were imported before this failure");
  expect(after.message).not.toContain("send it again");
  const http = siteDataHttpError(after);
  expect(http.status).toBe(409);
  expect(http.retryable).toBe(false);
  expect(siteDataImportFailure(new Error("other"), 100)).toBeInstanceOf(Error);
});

test("writes without a schema touch no validation window", async () => {
  const f = await fixture();
  const s = f.site((await f.publish("Plain")).id);
  await s.define(f.owner, "plain", { accessMode: "shared" });
  expect(
    (await s.write(f.member, [{ op: "insert", collection: "plain", data: { n: 1 } }])).status,
  ).toBe(200);
  expect(
    (await s.write(f.owner, [{ op: "put", collection: "plain", key: "k", data: { n: 2 } }])).status,
  ).toBe(200);
  const imported = await s.request(f.owner, "POST", "/data/collections/plain/import", {
    format: "csv",
    csv: "n\n3\n",
  });
  expect(imported.json).toEqual({ imported: 1 });
  expect(await validationRows(f)).toEqual({ sites: 0, workspaces: 0 });
});

test("compiles count toward the budget even when no record is checked", async () => {
  const { prevalidateSiteDataWrite, assertSiteDataSchema } =
    await import("../src/site-data/service");
  const schemaFor = (name: string) => ({ type: "object", title: name });
  const store = {
    getCollection: async (_caller: unknown, name: string) => ({ jsonSchema: schemaFor(name) }),
    // Every record is missing: nothing is validated, only compiled.
    get: async () => null,
  };
  const access = {
    store,
    caller: {},
    limits: { maxRecordBytes: 256 * 1024 },
    writeOptions: { limits: {} },
  } as never;
  const patch = (collection: string) => ({ op: "patch", collection, key: "gone", data: { a: 1 } });
  await withValidationClock(
    () => 300,
    async () => {
      const meter = { ms: 0 };
      const refused = await prevalidateSiteDataWrite(access, [patch("a"), patch("b")], {
        meter,
      }).catch((error: any) => error);
      expect(refused.details).toMatchObject({ reason: "validation_budget", index: 1 });
      // Only the first compile ran.
      expect(meter.ms).toBe(300);
    },
  );
  // Within a request, a schema that fails to compile is tried once.
  const broken = { type: "object", properties: { a: { type: "string", pattern: "^(a+)+$" } } };
  const brokenAccess = {
    ...(access as object),
    store: { getCollection: async () => ({ jsonSchema: broken }), get: async () => null },
  } as never;
  await withValidationClock(
    () => 10,
    async () => {
      const meter = { ms: 0 };
      const inserts = Array.from({ length: 3 }, () => ({
        op: "insert",
        collection: "rows",
        data: { a: "x" },
      }));
      const options = await prevalidateSiteDataWrite(brokenAccess, inserts, { meter });
      expect(meter.ms).toBe(10);
      expect(options.validate!(broken, { a: "x" })).toContain("invalid");
    },
  );
  // Across requests, the shared cache keeps the failure: the same error comes back.
  const first = (() => {
    try {
      assertSiteDataSchema({ ...broken });
    } catch (error) {
      return error;
    }
  })();
  const second = (() => {
    try {
      assertSiteDataSchema({ ...broken });
    } catch (error) {
      return error;
    }
  })();
  expect((first as any).code).toBe("validation");
  expect(second).toBe(first);
});

test("a schema that changed before the lock is a retryable conflict, never compiled there", async () => {
  const { prevalidateSiteDataWrite } = await import("../src/site-data/service");
  const before = { type: "object", properties: { n: { type: "number" } } };
  const after = { type: "object", properties: { n: { type: "string" } } };
  const access = {
    store: { getCollection: async () => ({ jsonSchema: before }), get: async () => null },
    caller: {},
    limits: { maxRecordBytes: 256 * 1024 },
    writeOptions: { limits: {} },
  } as never;
  const data = { n: 1 };
  const options = await prevalidateSiteDataWrite(access, [
    { op: "insert", collection: "rows", data },
  ]);
  // The same schema (another object with the same content) is fine.
  expect(options.validate!({ ...before }, data)).toBeNull();
  const changed = (() => {
    try {
      return options.validate!(after, data);
    } catch (error) {
      return error;
    }
  })() as any;
  expect(changed.code).toBe("conflict");
  expect(changed.details).toMatchObject({ reason: "schema_changed", retryable: true });
  // Over HTTP a conflict is a 409.
  const { siteDataHttpError } = await import("../src/routes/site-data");
  const httpError = siteDataHttpError(changed);
  expect(httpError.status).toBe(409);
  expect(httpError.retryable).toBe(true);
});

test("CSV imports count against the write window before parsing", async () => {
  // Six line breaks and an unterminated quote: parsing it would fail with 422.
  const broken = `name\n"a\nb\nc\nd\ne\n`;
  const result = await withinOneMinute(async () => {
    const f = await fixture({ siteDataManagerWritesPerMinute: 5 });
    const s = f.site((await f.publish("Import window")).id);
    await s.define(f.owner, "rows", { accessMode: "shared" });
    const importCsv = (csv: string) =>
      s.request(f.owner, "POST", "/data/collections/rows/import", { format: "csv", csv });
    const small = await importCsv("name\nx\ny");
    // 1 + 2 used; six more would pass the window of 5, so nothing is parsed.
    const limited = await importCsv(broken);
    return { small, limited };
  });
  expect(result.small.json).toEqual({ imported: 2 });
  expect(result.limited.status).toBe(429);
  expect(errorCode(result.limited)).toBe("rate_limited");
  const f = await fixture();
  const s = f.site((await f.publish("Import parse")).id);
  await s.define(f.owner, "rows", { accessMode: "shared" });
  const parsed = await s.request(f.owner, "POST", "/data/collections/rows/import", {
    format: "csv",
    csv: broken,
  });
  expect(parsed.status).toBe(422);
  expect(parsed.json.error.message).toContain("unterminated");
});

test("prevalidation checks the budget before each record after the first", async () => {
  const { prevalidateSiteDataWrite } = await import("../src/site-data/service");
  const schema = { type: "object", properties: { n: { type: "number" } } };
  const access = {
    store: { getCollection: async () => ({ jsonSchema: schema }), get: async () => null },
    caller: {},
    limits: { maxRecordBytes: 256 * 1024 },
    writeOptions: { limits: {} },
  } as never;
  const inserts = (count: number) =>
    Array.from({ length: count }, (_, n) => ({ op: "insert", collection: "rows", data: { n } }));
  await withValidationClock(
    () => 100,
    async () => {
      // Compile 100, record 0 → 200, record 1 → 300, record 2 refused before it runs.
      const meter = { ms: 0 };
      const refused = await prevalidateSiteDataWrite(access, inserts(5), { meter }).catch(
        (error: any) => error,
      );
      expect(refused.details).toMatchObject({ reason: "validation_budget", index: 2 });
      expect(meter.ms).toBe(300);
      // One record completes even with no budget at all.
      const single = { ms: 0 };
      const options = await prevalidateSiteDataWrite(access, inserts(1), {
        budgetMs: -1,
        meter: single,
      });
      expect(single.ms).toBe(200);
      // Inside the write, a record that changed is checked again on the same meter,
      // and the same compiled validator is reused without compiling again.
      expect(options.validate!({ ...schema }, { n: "changed" })).toContain("number");
      expect(single.ms).toBe(300);
      // A batch over budget refuses further checks inside the write.
      const batch = await prevalidateSiteDataWrite(access, inserts(2), { budgetMs: 150 }).catch(
        (error: any) => error,
      );
      expect(batch.details).toMatchObject({ reason: "validation_budget", index: 1 });
    },
  );
});

test("patch and increment results are checked before the lock, on the same budget", async () => {
  const { prevalidateSiteDataWrite } = await import("../src/site-data/service");
  const schema = {
    type: "object",
    properties: { name: { type: "string", maxLength: 3 }, n: { type: "number", maximum: 5 } },
  };
  const twoInserts = [
    { op: "insert", collection: "rows", data: { name: "a" } },
    { op: "insert", collection: "rows", data: { name: "b" } },
  ];
  const stored = { name: "ab", n: 1 };
  const reads: unknown[] = [];
  const store = {
    getCollection: async () => ({ jsonSchema: schema }),
    get: async (_caller: unknown, _name: string, ref: unknown) => {
      reads.push(ref);
      return { data: { ...stored } };
    },
  };
  const access = {
    store,
    caller: {},
    limits: { maxRecordBytes: 256 * 1024 },
    writeOptions: { limits: {} },
  } as never;
  const options = await prevalidateSiteDataWrite(access, [
    { op: "patch", collection: "rows", key: "a", data: { name: "abc" } },
    { op: "increment", collection: "rows", id: "r1", field: "n", by: 2 },
  ]);
  expect(reads).toEqual([{ key: "a" }, { id: "r1" }]);
  // The write finds the same merged records already checked.
  expect(options.validate!(schema, { name: "abc", n: 1 })).toBeNull();
  expect(options.validate!(schema, { name: "ab", n: 3 })).toBeNull();
  // A record that changed before the lock is checked again.
  expect(options.validate!(schema, { name: "abcd", n: 1 })).toContain("name");
  // A spent budget refuses every record after the first.
  const spent = await prevalidateSiteDataWrite(access, twoInserts, { budgetMs: -1 }).catch(
    (error: any) => error,
  );
  expect(spent.code).toBe("validation");
  expect(spent.details).toMatchObject({ reason: "validation_budget", index: 1 });
});

test("a record that grew past the request's reservation is refused before it is checked", async () => {
  const { prevalidateSiteDataWrite } = await import("../src/site-data/service");
  const schema = { type: "object", properties: { pad: { type: "string" } } };
  // Stored records are about 20 KB unless a test says otherwise.
  let stored: Record<string, unknown> = { pad: "x".repeat(20_000) };
  const store = {
    getCollection: async () => ({ jsonSchema: schema }),
    get: async () => ({ data: { ...stored } }),
  };
  const access = {
    store,
    caller: {},
    limits: { maxRecordBytes: 256 * 1024 },
    writeOptions: { limits: {} },
  } as never;
  const pad = (bytes: number) => ({ pad: "y".repeat(bytes) });
  const refusal = (run: () => unknown) => {
    try {
      run();
      return null;
    } catch (error) {
      return error as any;
    }
  };
  let checks = 0;
  await withValidationClock(
    () => {
      checks += 1;
      return 0;
    },
    async () => {
      // A patch that reserved 25 ms: a 100 KB record under the lock needs
      // about 100 ms, more than 25 ms past its reservation.
      const small = await prevalidateSiteDataWrite(
        access,
        [{ op: "patch", collection: "rows", key: "a", data: { n: 1 } }],
        { reservedMs: 25 },
      );
      const before = checks;
      const grew = refusal(() => small.validate!(schema, pad(100_000)));
      expect(checks).toBe(before);
      expect(grew.code).toBe("conflict");
      expect(grew.details).toEqual({ reason: "record_grew", retryable: true });
      const { siteDataHttpError } = await import("../src/routes/site-data");
      const httpError = siteDataHttpError(grew);
      expect(httpError.status).toBe(409);
      expect(httpError.retryable).toBe(true);
      // Re-checking the merge counted before the lock uses that count first:
      // a record that changed but did not grow is not refused, while new
      // records add up (20 + 20 ms fit 25 + 25 ms; a third 20 KB does not).
      const many = await prevalidateSiteDataWrite(
        access,
        [{ op: "patch", collection: "rows", key: "a", data: { n: 1 } }],
        { reservedMs: 25 },
      );
      expect(many.validate!(schema, pad(20_001))).toBeNull();
      expect(many.validate!(schema, pad(20_002))).toBeNull();
      expect(refusal(() => many.validate!(schema, pad(20_003))).details.reason).toBe("record_grew");
      // A 40 KB record re-checked twice under the lock after one check
      // before it (credit 40 ms, then 40 ms more) fits 40 + 25 + 25 ms.
      stored = pad(40_000);
      const twice = await prevalidateSiteDataWrite(
        access,
        [{ op: "patch", collection: "rows", key: "a", data: { n: 1 } }],
        { reservedMs: 65 },
      );
      expect(twice.validate!(schema, pad(40_001))).toBeNull();
      expect(twice.validate!(schema, pad(40_002))).toBeNull();
      stored = pad(20_000);
      // A reservation at the budget cannot grow on a retry: the time budget applies.
      const full = await prevalidateSiteDataWrite(
        access,
        [{ op: "patch", collection: "rows", key: "a", data: { n: 1 } }],
        { reservedMs: 250 },
      );
      expect(full.validate!(schema, pad(200_000))).toBeNull();
      // Without a reservation (no admission), nothing is refused.
      const none = await prevalidateSiteDataWrite(access, [
        { op: "patch", collection: "rows", key: "a", data: { n: 1 } },
      ]);
      expect(none.validate!(schema, pad(200_000))).toBeNull();
      // Inserts and puts are known at admission and stay on the time budget:
      // a 100 KB insert on a 25 ms reservation is checked, and leaves the
      // merge's room untouched.
      const inserted = await prevalidateSiteDataWrite(
        access,
        [
          { op: "insert", collection: "rows", data: pad(100_000) },
          { op: "patch", collection: "rows", key: "a", data: { n: 1 } },
        ],
        { reservedMs: 25 },
      );
      expect(inserted.validate!(schema, pad(20_001))).toBeNull();
      // A record that grew before the request checked it is refused there.
      stored = pad(200_000);
      const early = await prevalidateSiteDataWrite(
        access,
        [{ op: "patch", collection: "rows", key: "a", data: { n: 1 } }],
        { reservedMs: 25 },
      ).catch((error: any) => error);
      expect(early.details).toEqual({ reason: "record_grew", retryable: true });
    },
  );
});

test("managers share a per-Site write window counted before any work", async () => {
  await withinOneMinute(async () => {
    const f = await fixture({
      siteDataManagerWritesPerMinute: 3,
      siteDataViewerWritesPerMinute: 50,
    });
    const created = await f.publish("Busy");
    const s = f.site(created.id);
    expect((await s.define(f.owner, "rows", { accessMode: "shared" })).status).toBe(201);
    expect(
      (await s.write(f.owner, [{ op: "insert", collection: "rows", data: { i: 1 } }])).status,
    ).toBe(200);
    // A refused attempt counts too.
    expect((await s.write(f.owner, [{ op: "insert", collection: "nope", data: {} }])).status).toBe(
      404,
    );
    const limited = await s.write(f.admin, [{ op: "insert", collection: "rows", data: { i: 2 } }]);
    expect(limited.status).toBe(429);
    expect(errorCode(limited)).toBe("rate_limited");
    // Viewers keep their own windows.
    expect(
      (await s.write(f.member, [{ op: "insert", collection: "rows", data: { i: 3 } }])).status,
    ).toBe(200);
  });
});

test("an unreadable agent lineage fails closed", async () => {
  const f = await fixture();
  const created = await f.publish("Deep");
  const s = f.site(created.id);
  await s.define(f.owner, "habits", { accessMode: "per_viewer" });
  await s.write(f.member, [{ op: "insert", collection: "habits", data: { who: "member" } }]);
  await s.write(f.owner, [{ op: "insert", collection: "habits", data: { who: "owner" } }]);
  // A chain of nested workers deeper than the lineage walk reads.
  let parent: string | undefined;
  let root: string | undefined;
  for (let depth = 0; depth < 34; depth += 1) {
    const session = await createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      initialMessage: `level ${depth}`,
      resources: [],
      tools: [],
      metadata: {},
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    if (parent)
      await shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`UPDATE sessions SET parent_session_id = ${parent!}, root_session_id = ${root!}
          WHERE id = ${session.id}`;
      });
    root ??= session.id;
    parent = session.id;
  }
  const deep = await agentTools(f, { parentSessionId: parent! });
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`UPDATE sessions SET root_session_id = ${root!} WHERE id = ${deep.session.id}`;
  });
  const other = await f.publish("Elsewhere");
  try {
    // No known Site origin: an incomplete lineage reaches no Site Data at all.
    for (const [name, args] of [
      ["site_data_define_collection", { siteId: created.id, name: "x", accessMode: "shared" }],
      ["site_data_query", { siteId: created.id, collection: "habits" }],
    ] as const) {
      const denied = await deep.callTool(name, args);
      expect(denied.isError, JSON.stringify(denied.value)).toBe(true);
      expect(denied.value.error.code).toBe("forbidden");
    }
    // The root session's Site origin is read directly, past the walk's depth cap:
    // viewer reach on that one Site, and no management.
    await shared.admin`UPDATE sessions SET metadata = jsonb_build_object(
        '_opengeniSiteOrigin', jsonb_build_object('siteId', ${created.id}::text, 'title', 'Deep'))
      WHERE id = ${root!}`;
    const define = await deep.callTool("site_data_define_collection", {
      siteId: created.id,
      name: "x",
      accessMode: "shared",
    });
    expect(define.isError).toBe(true);
    expect(define.value.error.code).toBe("forbidden");
    const own = await deep.callTool("site_data_query", {
      siteId: created.id,
      collection: "habits",
    });
    expect(own.isError, JSON.stringify(own.value)).toBe(false);
    expect(own.value.records.map((record: any) => record.data.who)).toEqual(["owner"]);
    const elsewhere = await deep.callTool("site_data_query", {
      siteId: other.id,
      collection: "habits",
    });
    expect(elsewhere.value.error.code).toBe("forbidden");
  } finally {
    await deep.mcp.close();
  }
  // A shallower worker of the same kind keeps manager reach: the walk reads its whole lineage.
  const shallow = await agentTools(f, { parentSessionId: (await agentTools(f)).session.id });
  try {
    const all = await shallow.callTool("site_data_query", {
      siteId: created.id,
      collection: "habits",
      scope: "all",
    });
    expect(all.isError, JSON.stringify(all.value)).toBe(false);
    expect(all.value.records).toHaveLength(2);
  } finally {
    await shallow.mcp.close();
  }
  // A delegated credential naming a session that does not exist is not trusted to manage.
  const { resolveSiteDataAccess } = await import("../src/site-data/service");
  const delegated = (sessionId?: string): AccessGrant => ({
    ...f.owner.grant,
    metadata: { delegated: true, ...(sessionId ? { sessionId } : {}) },
  });
  const deps = f.deps as never;
  const manager = await resolveSiteDataAccess(deps, delegated(), created.id, { management: true });
  expect(manager.caller.role).toBe("manager");
  const missing = await resolveSiteDataAccess(deps, delegated(crypto.randomUUID()), created.id, {
    management: true,
  }).catch((error: any) => error);
  expect(missing.code).toBe("forbidden");
  // Without a readable session there is no known Site, so no Site Data at all.
  const unknown = await resolveSiteDataAccess(
    deps,
    delegated(crypto.randomUUID()),
    created.id,
  ).catch((error: any) => error);
  expect(unknown.code).toBe("forbidden");
});

test("an agent's lineage is read under the production session RLS context", async () => {
  const { withAccessGrantSessionRlsContext } = await import("../src/access-grant-rls");
  const f = await fixture();
  const created = await f.publish("Private agent");
  const s = f.site(created.id);
  await s.define(f.owner, "habits", { accessMode: "per_viewer" });
  await s.write(f.member, [{ op: "insert", collection: "habits", data: { who: "member" } }]);
  await s.write(f.owner, [{ op: "insert", collection: "habits", data: { who: "owner" } }]);
  const membership = async (subjectId: string) => {
    const [row] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${f.accountId} and subject_id = ${subjectId} limit 1`;
    if (row) return row.id;
    const id = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into organization_memberships(
          id, account_id, subject_id, role, status, personal_workspace_id)
        values (${id}, ${f.accountId}, ${subjectId}, 'member', 'active', ${f.workspace.id})`;
    });
    return id;
  };
  const makePrivate = async (sessionId: string, subjectId: string) => {
    const membershipId = await membership(subjectId);
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set visibility = 'user_private', owner_subject_id = ${subjectId},
          owner_organization_membership_id = ${membershipId}
        where id = ${sessionId}`;
    });
  };
  // Each call runs the way the production MCP route runs it: inside the agent
  // attempt's session RLS context, where private sessions are visible only to
  // their owner.
  const call = (
    tools: Awaited<ReturnType<typeof agentTools>>,
    name: string,
    args: Record<string, unknown>,
  ) =>
    withAccessGrantSessionRlsContext(f.deps as never, tools.grant, () =>
      tools.callTool(name, args),
    );
  // The owner's own Only me session reads its lineage in full: manager reach.
  const own = await agentTools(f);
  await makePrivate(own.session.id, f.owner.subjectId);
  try {
    const all = await call(own, "site_data_query", {
      siteId: created.id,
      collection: "habits",
      scope: "all",
    });
    expect(all.isError, JSON.stringify(all.value)).toBe(false);
    expect(all.value.records).toHaveLength(2);
  } finally {
    await own.mcp.close();
  }
  // An Only me session started from the Site keeps the Site clamp under RLS.
  const fromSite = await agentTools(f, {
    metadata: { _opengeniSiteOrigin: { siteId: created.id, title: "Private agent" } },
  });
  await makePrivate(fromSite.session.id, f.owner.subjectId);
  try {
    const clamped = await call(fromSite, "site_data_query", {
      siteId: created.id,
      collection: "habits",
    });
    expect(clamped.isError, JSON.stringify(clamped.value)).toBe(false);
    expect(clamped.value.records.map((record: any) => record.data.who)).toEqual(["owner"]);
    const define = await call(fromSite, "site_data_define_collection", {
      siteId: created.id,
      name: "x",
      accessMode: "shared",
    });
    expect(define.value.error.code).toBe("forbidden");
  } finally {
    await fromSite.mcp.close();
  }
  // A parent session the agent's person cannot see makes the lineage unreadable
  // under RLS, so it fails closed instead of granting manager reach.
  const hidden = await agentTools(f, { initiatorSubjectId: f.member.subjectId });
  await makePrivate(hidden.session.id, f.member.subjectId);
  const child = await agentTools(f, { parentSessionId: hidden.session.id });
  try {
    // The same read outside the RLS context sees the whole lineage.
    const scope = { accountId: f.accountId, workspaceId: f.workspace.id };
    const lineage = () => getSiteDataAgentSession(db.db, scope, child.session.id, child.turnId);
    expect((await lineage()).complete).toBe(true);
    expect(
      (await withAccessGrantSessionRlsContext(f.deps as never, child.grant, lineage)).complete,
    ).toBe(false);
    const denied = await call(child, "site_data_query", {
      siteId: created.id,
      collection: "habits",
      scope: "all",
    });
    expect(denied.isError, JSON.stringify(denied.value)).toBe(true);
    expect(denied.value.error.code).toBe("forbidden");
  } finally {
    await child.mcp.close();
    await hidden.mcp.close();
  }
});
