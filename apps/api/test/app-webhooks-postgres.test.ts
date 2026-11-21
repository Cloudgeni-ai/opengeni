import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccessGrant } from "@opengeni/contracts";
import {
  signTimestampedHmac,
  type ObjectStorageDependency,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  setMemberNotificationsAllowed,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

// Webhooks into apps and notifications from apps, against PostgreSQL as the
// restricted application role: real routes, Site Data writes, activity
// events and inbox delivery (the owner-internal trigger).
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("app-webhooks");
  if (!acquired) throw new Error("App webhook tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const managerPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "artifacts:read",
  "artifacts:publish",
] as const;
const viewerPermissions = ["workspace:read", "sessions:read", "artifacts:read"] as const;

function memoryObjectStorage(): ObjectStorageDependency {
  const objects = new Map<string, Uint8Array>();
  return {
    maxSinglePutSizeBytes: 5_000_000_000,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
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
    createGetUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
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
  } as unknown as ObjectStorageDependency;
}

type Who = { subjectId: string; headers: Record<string, string> };

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('App webhook fixture') returning id`;
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
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: memoryObjectStorage(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
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
    expect(added.status, await added.clone().text()).toBe(200);
    return {
      subjectId: identity.subjectId,
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
  const owner = await person(managerPermissions);
  const alice = await person(viewerPermissions);
  const bob = await person(viewerPermissions);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'app-webhooks-test')`;
  const base = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const parse = async (response: Response) => {
    const text = await response.text();
    try {
      return { status: response.status, json: JSON.parse(text) as any };
    } catch {
      return { status: response.status, json: text as any };
    }
  };
  const request = async (
    who: Who,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    await parse(
      await app.request(`${base}${path}`, {
        method,
        headers: { ...who.headers, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const deliver = async (url: string, body: string, headers: Record<string, string>) =>
    await parse(
      await app.request(new URL(url).pathname, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
  const published = await request(owner, "POST", "", {
    title: "Orders",
    html: "<!doctype html><h1>Orders</h1>",
    idempotencyKey: crypto.randomUUID(),
    visibility: "workspace",
  });
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  return {
    accountId,
    workspace,
    owner,
    alice,
    bob,
    siteId: String(published.json.artifact.id),
    versionId: String(published.json.version.id),
    request,
    deliver,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function records(f: Fixture, collection: string) {
  const read = await f.request(f.alice, "POST", `/${f.siteId}/data/query`, { collection });
  expect(read.status, JSON.stringify(read.json)).toBe(200);
  return (read.json.records as Array<{ key: string | null; data: unknown }>).map((record) => ({
    key: record.key,
    data: record.data,
  }));
}

test("a webhook delivery writes app data with a bearer or a signature and fires change events", async () => {
  const f = await fixture();
  expect(
    (
      await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
        accessMode: "shared_read",
      })
    ).status,
  ).toBe(201);
  // Someone listens for app changes (a workspace webhook), so they're recorded.
  await shared.admin`insert into workspace_webhooks (account_id, workspace_id, url, secret_encrypted, event_types)
    values (${f.accountId}, ${f.workspace.id}, 'https://example.test', 'sealed', array['app.record.added', 'app.record.changed'])`;
  const created = await f.request(f.owner, "POST", `/${f.siteId}/webhooks`, {
    name: "Shop",
    collection: "orders",
    recordsPath: "data.items",
    key: "id",
    fields: ["id", "total"],
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const secret = String(created.json.secret);
  const url = String(created.json.webhook.url);
  expect(secret).toStartWith("ogwh_");
  expect(url).toContain(`/v1/webhooks/apps/${f.workspace.id}/${created.json.webhook.id}`);

  // The secret is shown once; listing never returns it. Viewers can't manage.
  const listed = await f.request(f.owner, "GET", `/${f.siteId}/webhooks`);
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.json)).not.toContain(secret);
  expect((await f.request(f.alice, "GET", `/${f.siteId}/webhooks`)).status).toBe(403);
  // Not from inside the app's frame.
  const framed = await f.request(f.owner, "GET", `/${f.siteId}/webhooks`, undefined, {
    "x-opengeni-site-frame": "1",
  });
  // (The app-session path allowlist refuses it before the route does.)
  expect([403, 404], JSON.stringify(framed.json)).toContain(framed.status);

  const bearer = await f.deliver(
    url,
    JSON.stringify({ data: { items: [{ id: "o-1", total: 10, secret: "drop" }, { total: 1 }] } }),
    { authorization: `Bearer ${secret}` },
  );
  expect(bearer.status, JSON.stringify(bearer.json)).toBe(200);
  expect(bearer.json).toMatchObject({ written: 1, skipped: 1 });

  const body = JSON.stringify({ data: { items: [{ id: "o-1", total: 42 }] } });
  const signed = await f.deliver(url, body, {
    "x-opengeni-signature": signTimestampedHmac({ secret, body }),
  });
  expect(signed.status, JSON.stringify(signed.json)).toBe(200);
  expect(await records(f, "orders")).toEqual([{ key: "o-1", data: { id: "o-1", total: 42 } }]);

  // The app's normal change events, as the webhook's own principal, depth 1.
  const events = await shared.admin<{ type: string; chain_depth: number; subject_id: string }[]>`
    select type, chain_depth, subject_id from workspace_activity_events
    where workspace_id = ${f.workspace.id} and type like 'app.record.%'
    order by created_at, id`;
  expect(events.map((event) => event.type)).toEqual(["app.record.added", "app.record.changed"]);
  expect(events.every((event) => Number(event.chain_depth) === 1)).toBe(true);

  // Bad secrets, stale signatures and missing auth are refused.
  expect((await f.deliver(url, body, { authorization: "Bearer ogwh_nope" })).status).toBe(401);
  expect(
    (
      await f.deliver(url, body, {
        "x-opengeni-signature": signTimestampedHmac({
          secret,
          body,
          timestampSeconds: Math.floor(Date.now() / 1000) - 3600,
        }),
      })
    ).status,
  ).toBe(401);
  expect((await f.deliver(url, body, {})).status).toBe(401);
  expect(
    (
      await f.deliver(url, "<xml/>", {
        authorization: `Bearer ${secret}`,
        "content-type": "text/xml",
      })
    ).status,
  ).toBe(415);
  expect((await f.deliver(url, "{nope", { authorization: `Bearer ${secret}` })).status).toBe(400);

  // Rotating replaces the secret; paused webhooks refuse deliveries.
  const rotated = await f.request(
    f.owner,
    "PATCH",
    `/${f.siteId}/webhooks/${created.json.webhook.id}`,
    {
      rotateSecret: true,
    },
  );
  expect(rotated.status, JSON.stringify(rotated.json)).toBe(200);
  const next = String(rotated.json.secret);
  expect(next).not.toBe(secret);
  expect((await f.deliver(url, body, { authorization: `Bearer ${secret}` })).status).toBe(401);
  expect((await f.deliver(url, body, { authorization: `Bearer ${next}` })).status).toBe(200);
  expect(
    (
      await f.request(f.owner, "PATCH", `/${f.siteId}/webhooks/${created.json.webhook.id}`, {
        status: "paused",
      })
    ).status,
  ).toBe(200);
  expect((await f.deliver(url, body, { authorization: `Bearer ${next}` })).status).toBe(409);
  const last = await f.request(f.owner, "GET", `/${f.siteId}/webhooks`);
  expect(last.json.webhooks[0]).toMatchObject({ status: "paused", lastStatus: "rejected" });

  // Deleting stops deliveries.
  expect(
    (await f.request(f.owner, "DELETE", `/${f.siteId}/webhooks/${created.json.webhook.id}`)).status,
  ).toBe(200);
  expect((await f.deliver(url, body, { authorization: `Bearer ${next}` })).status).toBe(404);
});

test("keyless deliveries insert once per delivery id; per-viewer targets and archived apps are refused", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/events`, {
    accessMode: "shared_read",
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
  });
  const refused = await f.request(f.owner, "POST", `/${f.siteId}/webhooks`, {
    name: "Mine",
    collection: "mine",
  });
  expect(refused.status, JSON.stringify(refused.json)).toBeGreaterThanOrEqual(400);
  const created = await f.request(f.owner, "POST", `/${f.siteId}/webhooks`, {
    name: "Events",
    collection: "events",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const auth = { authorization: `Bearer ${created.json.secret}`, "webhook-id": "delivery-1" };
  const url = String(created.json.webhook.url);
  expect((await f.deliver(url, JSON.stringify({ kind: "paid" }), auth)).status).toBe(200);
  expect((await f.deliver(url, JSON.stringify({ kind: "paid" }), auth)).status).toBe(200);
  expect(await records(f, "events")).toHaveLength(1);

  const archived = await f.request(f.owner, "PATCH", `/${f.siteId}/status`, {
    status: "archived",
    expectedCurrentVersionId: f.versionId,
    reason: "done",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(archived.status, JSON.stringify(archived.json)).toBe(200);
  expect(
    (await f.deliver(url, JSON.stringify({ kind: "x" }), { authorization: auth.authorization }))
      .status,
  ).toBe(403);
});

async function inbox(f: Fixture, subjectId: string) {
  return await shared.admin<
    { title: string; subtitle: string | null; session_id: string | null; link: any }[]
  >`select title, subtitle, session_id, link from opengeni_private.inbox_items
    where workspace_id = ${f.workspace.id} and recipient_subject_id = ${subjectId}`;
}

const deliverNotice = "opengeni_private.deliver_app_notification_v1(uuid)";

test("site.notify is refused, storing nothing, until the runtime may deliver it", async () => {
  // The runtime role's EXECUTE on delivery is withheld for one release (1524).
  const f = await fixture();
  const sent = await f.request(f.alice, "POST", `/${f.siteId}/notify`, { title: "Saved" });
  expect(sent.status, JSON.stringify(sent.json)).toBe(403);
  expect(sent.json.error.details.reason).toBe("notify_not_available");
  const [stored] = await shared.admin<{ count: string }[]>`
    select count(*)::text as count from app_notifications where site_id = ${f.siteId}`;
  expect(stored!.count).toBe("0");
});

test("site.notify reaches the viewer, permitted members and, for managers, the workspace", async () => {
  await shared.admin.unsafe(`grant execute on function ${deliverNotice} to opengeni_app`);
  try {
    await notifyCases();
  } finally {
    await shared.admin.unsafe(`revoke execute on function ${deliverNotice} from opengeni_app`);
  }
});

async function notifyCases() {
  const f = await fixture();
  const notify = async (who: Who, body: unknown) =>
    await f.request(who, "POST", `/${f.siteId}/notify`, body);

  const self = await notify(f.alice, { title: "Saved", key: "k1", path: "/orders/1" });
  expect(self.status, JSON.stringify(self.json)).toBe(200);
  expect(self.json).toMatchObject({ key: "k1", delivered: 1, skipped: 0 });
  expect(await notify(f.alice, { title: "Saved again", key: "k1" })).toMatchObject({ status: 200 });
  const mine = await inbox(f, f.alice.subjectId);
  expect(mine).toHaveLength(1);
  expect(mine[0]!).toMatchObject({ title: "Saved again", subtitle: "Orders", session_id: null });
  expect(mine[0]!.link.url).toBe(`/workspaces/${f.workspace.id}/sites/${f.siteId}`);

  // An earlier send is never delivered again by calling delivery directly.
  const [earlier] = await shared.admin<{ id: string }[]>`
    select id from app_notifications where site_id = ${f.siteId} limit 1`;
  const [again] = await shared.admin<{ delivered: number }[]>`
    select opengeni_private.deliver_app_notification_v1(${earlier!.id}::uuid) as delivered`;
  expect(again!.delivered).toBe(0);

  // Another member only when they allow it.
  const toBob = await notify(f.alice, { title: "Hi", to: f.bob.subjectId });
  expect(toBob.status, JSON.stringify(toBob.json)).toBe(403);
  await setMemberNotificationsAllowed(db.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    subjectId: f.bob.subjectId,
    allowed: true,
  });
  expect((await notify(f.alice, { title: "Hi", to: f.bob.subjectId })).status).toBe(200);
  expect(await inbox(f, f.bob.subjectId)).toHaveLength(1);

  // "workspace" is for the app's managers only.
  expect((await notify(f.alice, { title: "All", to: "workspace" })).status).toBe(403);
  const all = await notify(f.owner, { title: "All", to: "workspace" });
  expect(all.status, JSON.stringify(all.json)).toBe(200);
  expect(all.json).toMatchObject({ delivered: 1, skipped: 1 });

  // Bounded sends per sender and app.
  let limited = 0;
  for (let index = 0; index < 32; index += 1) {
    const sent = await notify(f.bob, { title: `n${index}` });
    if (sent.status === 429) limited += 1;
  }
  expect(limited).toBeGreaterThan(0);
}
