// Stated membership: an organization key acting as an external user
// (`asUser`) can state the user's workspace permissions on each request. The
// user's grant in the request's shared workspace becomes exactly those
// permissions before the request is authorized, under the same authority and
// refusals as the external-members endpoints.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";
import {
  requireAccessContext,
  requireAccessGrant,
  requireFreshAccessGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  applyStatedExternalWorkspaceMembership,
  createDb,
  createWorkspace,
  createOrganizationApiKey,
  ensureExternalIdentity,
  getWorkspaceGrant,
  migrate,
  provisionRoles,
  STATED_EXTERNAL_MEMBERSHIP_REASON,
  withAccountRls,
  readExternalWorkspaceRevocationWatermark,
  lockExternalWorkspaceMembershipLifecycle,
  type DbClient,
} from "@opengeni/db";
import { normalizeOrganizationAccessPolicy, type Permission } from "@opengeni/contracts";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

const CHAT = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "mcp_servers:attach",
] as const satisfies readonly Permission[];
const READ_ONLY: Permission[] = ["workspace:read", "sessions:read"];
const WITH_TASKS: Permission[] = [...CHAT, "scheduled_tasks:manage"];
const KEY: Permission[] = ["members:manage", ...CHAT, "scheduled_tasks:manage"];

let shared: OwnerMigratedTestDatabase;
let db: DbClient;
const appRole = `stated_member_app_${crypto.randomUUID().replaceAll("-", "")}`;
const appPassword = crypto.randomUUID();
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("external-stated-membership");
  if (!acquired) throw new Error("Stated membership requires real PostgreSQL");
  shared = acquired;
  await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  await provisionRoles(shared.adminUrl, {
    appRole,
    appPassword,
    rlsStrategy: "force",
    artifactOutboxDispatcherPassword: "",
    artifactMaterializerPassword: "",
    hostExportPassword: "",
    temporalPassword: "",
    temporalDatabases: [],
  });
  const appUrl = new URL(shared.adminUrl);
  appUrl.username = appRole;
  appUrl.password = appPassword;
  db = createDb(appUrl.toString());
}, 180_000);
afterAll(async () => {
  try {
    await db?.close();
  } finally {
    if (shared) {
      try {
        if ((await shared.admin`select 1 from pg_roles where rolname = ${appRole}`).length) {
          await shared.admin`DROP OWNED BY ${shared.admin(appRole)}`;
          await shared.admin`DROP ROLE ${shared.admin(appRole)}`;
        }
      } finally {
        await shared.release();
      }
    }
  }
}, 60_000);

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
  throw error;
});
let routesRegistered = false;
// A request that has authenticated and is still in flight when its grant is
// resolved: the test holds it between the two steps.
const inflight = new Map<string, { authenticated: () => void; release: Promise<void> }>();

function registerRoutes() {
  if (routesRegistered) return;
  const deps = {
    db: db.db,
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
    bus: new MemoryEventBus(),
  } as unknown as ApiRouteDeps;
  registerWorkspaceRoutes(app, deps);
  registerOrganizationMembershipRoutes(app, deps);
  app.get("/test/grant/:workspaceId/:permission", async (c) =>
    c.json(
      await requireAccessGrant(
        c,
        deps,
        c.req.param("workspaceId"),
        c.req.param("permission") as Permission,
      ),
    ),
  );
  // A long-lived connection's re-check (e.g. an open SSE stream).
  app.get("/test/fresh/:workspaceId", async (c) =>
    c.json(await requireFreshAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:read")),
  );
  app.get("/test/inflight/:workspaceId/:tag", async (c) => {
    await requireAccessContext(c, deps);
    const hold = inflight.get(c.req.param("tag"))!;
    hold.authenticated();
    await hold.release;
    return c.json(await requireAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:read"));
  });
  routesRegistered = true;
}

async function organization(permissions: Permission[] = KEY, options: { custom?: boolean } = {}) {
  registerRoutes();
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Stated membership fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Tenant workspace" });
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(db.db, {
    accountId,
    name: "Embedding key",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
    ...(options.custom
      ? {
          policy: normalizeOrganizationAccessPolicy({
            preset: "custom",
            permissions,
            workspaceScope: { kind: "all" },
          }),
        }
      : {}),
  });
  const service = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: async (input, init) => await app.request(input, init),
  });
  const header = (externalId: string, membership?: Permission[]) =>
    encodeURIComponent(
      JSON.stringify({
        mode: "external",
        identity: { externalId, source: "product" },
        ...(membership ? { membership: { permissions: membership } } : {}),
      }),
    );
  /** One workspace-scoped request as `externalId`, optionally stating a membership. */
  const request = (
    externalId: string,
    membership: Permission[] | undefined,
    path = `/test/grant/${workspace.id}/workspace:read`,
  ) =>
    app.request(path, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-opengeni-external-actor": header(externalId, membership),
      },
    });
  const identity = (externalId: string) =>
    ensureExternalIdentity(db.db, { accountId, source: "product", externalId });
  const revoke = async (externalId: string, workspaceId = workspace.id) => {
    const member = await identity(externalId);
    return await service.cancelExternalWorkspaceMemberGrant(
      accountId,
      workspaceId,
      member.organizationMembershipId,
      { operationId: crypto.randomUUID(), cancelGrantOperationId: crypto.randomUUID() },
    );
  };
  return { accountId, workspace, service, key, token, header, request, identity, revoke };
}

async function stored(workspaceId: string, subjectId: string): Promise<string[] | null> {
  const rows = await shared.admin<{ permissions: string[] }[]>`
    select permissions from workspace_memberships
    where workspace_id = ${workspaceId}::uuid and subject_id = ${subjectId}`;
  return rows[0] ? [...rows[0].permissions].sort() : null;
}

async function events(workspaceId: string) {
  return await shared.admin<{ actor_service_subject: string | null; kind: string }[]>`
    select actor_service_subject, kind from organization_workspace_lifecycle_events
    where workspace_id = ${workspaceId}::uuid order by created_at`;
}

async function receipts(accountId: string, workspaceId: string) {
  return await shared.admin<{ action: string; reason: string | null }[]>`
    select action, result ->> 'reason' as reason from organization_workspace_operation_receipts
    where account_id = ${accountId}::uuid and result ->> 'workspaceId' = ${workspaceId}
    order by action`;
}

async function errorOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenGeniApiError)
      return { status: error.status, message: JSON.parse(error.body).message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const sorted = (permissions: readonly string[]) => [...permissions].sort();

describe("stated membership", () => {
  test("the first request creates the member with exactly the stated permissions", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    const client = org.service.asUser(externalId, {
      source: "product",
      membership: { permissions: READ_ONLY },
    });
    expect((await client.getWorkspace(org.workspace.id)).id).toBe(org.workspace.id);
    const { subjectId } = await org.identity(externalId);
    expect(await stored(org.workspace.id, subjectId)).toEqual(sorted(READ_ONLY));
    // Not the first-use conversation defaults: a stated read-only member cannot chat.
    expect(
      (await org.request(externalId, READ_ONLY, `/test/grant/${org.workspace.id}/sessions:create`))
        .status,
    ).toBe(403);
    expect(await events(org.workspace.id)).toEqual([
      { actor_service_subject: `api_key:${org.key.id}`, kind: "grant" },
    ]);
    expect(await receipts(org.accountId, org.workspace.id)).toEqual([
      { action: "grant", reason: STATED_EXTERNAL_MEMBERSHIP_REASON },
    ]);
  });

  test("an equal statement writes nothing", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    expect((await org.request(externalId, CHAT)).status).toBe(200);
    const { subjectId } = await org.identity(externalId);
    const [before] = await shared.admin<{ xmin: string; updated_at: Date }[]>`
      select xmin::text, updated_at from workspace_memberships
      where workspace_id = ${org.workspace.id}::uuid and subject_id = ${subjectId}`;
    for (let index = 0; index < 5; index += 1)
      expect((await org.request(externalId, [...CHAT].reverse())).status).toBe(200);
    const [after] = await shared.admin<{ xmin: string; updated_at: Date }[]>`
      select xmin::text, updated_at from workspace_memberships
      where workspace_id = ${org.workspace.id}::uuid and subject_id = ${subjectId}`;
    expect(after).toEqual(before!);
    expect(await events(org.workspace.id)).toHaveLength(1);
  });

  test("a narrower statement downgrades the grant and advances the authorization revision", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    expect((await org.request(externalId, WITH_TASKS)).status).toBe(200);
    const before = await org.identity(externalId);
    const tasks = `/test/grant/${org.workspace.id}/scheduled_tasks:manage`;
    expect((await org.request(externalId, WITH_TASKS, tasks)).status).toBe(200);
    // The app downgrades the user: the same request is now refused.
    expect((await org.request(externalId, [...CHAT], tasks)).status).toBe(403);
    expect(await stored(org.workspace.id, before.subjectId)).toEqual(sorted(CHAT));
    const after = await org.identity(externalId);
    expect(after.authorizationRevision).toBe(before.authorizationRevision + 1);
    // Widening again is a plain update without a revision advance.
    expect((await org.request(externalId, WITH_TASKS, tasks)).status).toBe(200);
    expect((await org.identity(externalId)).authorizationRevision).toBe(
      after.authorizationRevision,
    );
    expect((await events(org.workspace.id)).map((event) => event.kind)).toEqual([
      "grant",
      "update",
      "update",
    ]);
    expect((await receipts(org.accountId, org.workspace.id)).map((row) => row.reason)).toEqual([
      STATED_EXTERNAL_MEMBERSHIP_REASON,
      STATED_EXTERNAL_MEMBERSHIP_REASON,
      STATED_EXTERNAL_MEMBERSHIP_REASON,
    ]);
  });

  test("escalation is refused with the external-members endpoint's own errors", async () => {
    const org = await organization();
    const member = crypto.randomUUID();
    expect((await org.request(member, CHAT)).status).toBe(200);
    const { subjectId, organizationMembershipId } = await org.identity(member);
    const patch = (permissions: Permission[]) =>
      errorOf(
        org.service.updateExternalWorkspaceMember(
          org.accountId,
          org.workspace.id,
          organizationMembershipId,
          { permissions, operationId: crypto.randomUUID() },
        ),
      );
    for (const escalation of [
      [...CHAT, "secrets:read"],
      [...CHAT, "workspace:admin"],
      [...CHAT, "members:manage", "api_keys:manage"],
    ] as Permission[][]) {
      const stated = org.service.asUser(member, {
        source: "product",
        membership: { permissions: escalation },
      });
      const refusal = await errorOf(stated.getWorkspace(org.workspace.id));
      expect(refusal.status).toBe(403);
      expect(refusal).toEqual(await patch(escalation));
      // A fresh user is not admitted either.
      expect((await org.request(crypto.randomUUID(), escalation)).status).toBe(403);
    }
    expect(
      (
        await errorOf(
          org.service
            .asUser(member, {
              source: "product",
              membership: { permissions: [...CHAT, "secrets:read"] },
            })
            .getWorkspace(org.workspace.id),
        )
      ).message,
    ).toBe(
      "External membership operation is not available: external grant exceeds service authority",
    );
    expect(await stored(org.workspace.id, subjectId)).toEqual(sorted(CHAT));
    expect(await events(org.workspace.id)).toHaveLength(1);
  });

  test("a custom policy key cannot state a permission outside its policy", async () => {
    const org = await organization(KEY, { custom: true });
    const member = crypto.randomUUID();
    expect((await org.request(member, CHAT)).status).toBe(200);
    const { organizationMembershipId } = await org.identity(member);
    const outside: Permission[] = [...CHAT, "files:write"];
    const stated = await errorOf(
      org.service
        .asUser(member, { source: "product", membership: { permissions: outside } })
        .getWorkspace(org.workspace.id),
    );
    expect(stated).toEqual({
      status: 403,
      message: "cannot delegate a permission outside the organization key policy",
    });
    expect(stated).toEqual(
      await errorOf(
        org.service.updateExternalWorkspaceMember(
          org.accountId,
          org.workspace.id,
          organizationMembershipId,
          {
            permissions: outside,
            operationId: crypto.randomUUID(),
          },
        ),
      ),
    );
  });

  test("a custom policy key names the canonical permission for a stated deprecated alias", async () => {
    const org = await organization([...KEY, "secrets:list", "secrets:use"], { custom: true });
    const member = crypto.randomUUID();
    const deprecated = await errorOf(
      org.service
        .asUser(member, {
          source: "product",
          membership: { permissions: [...CHAT, "variable-sets:use"] },
        })
        .getWorkspace(org.workspace.id),
    );
    expect(deprecated).toEqual({
      status: 403,
      message: "variable-sets:use is a deprecated permission name; state secrets:use instead",
    });
    expect(
      (
        await org.service
          .asUser(member, {
            source: "product",
            membership: { permissions: [...CHAT, "secrets:use"] },
          })
          .getWorkspace(org.workspace.id)
      ).id,
    ).toBe(org.workspace.id);
  });

  test("a key that cannot manage members cannot state a membership", async () => {
    const org = await organization([...CHAT]);
    const response = await org.request(crypto.randomUUID(), [...CHAT]);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toBe(
      "External membership operation requires an organization service key",
    );
  });

  test("concurrent requests converge without lost or duplicate writes", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    const first = await Promise.all(
      Array.from({ length: 8 }, () => org.request(externalId, WITH_TASKS)),
    );
    expect(first.map((response) => response.status)).toEqual(Array(8).fill(200));
    const { subjectId } = await org.identity(externalId);
    expect(await stored(org.workspace.id, subjectId)).toEqual(sorted(WITH_TASKS));
    expect(await events(org.workspace.id)).toHaveLength(1);
    // Competing statements serialize: every write is a whole set and the row
    // ends equal to one of them, with one receipt per real change.
    const competing = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        org.request(externalId, index % 2 === 0 ? [...CHAT] : WITH_TASKS),
      ),
    );
    expect(competing.map((response) => response.status)).toEqual(Array(8).fill(200));
    const final = await stored(org.workspace.id, subjectId);
    expect([sorted(CHAT), sorted(WITH_TASKS)]).toContainEqual(final);
    const kinds = (await events(org.workspace.id)).map((event) => event.kind);
    expect(kinds[0]).toBe("grant");
    expect(kinds.slice(1).every((kind) => kind === "update")).toBe(true);
    expect(kinds.length).toBeLessThanOrEqual(9);
    expect(await receipts(org.accountId, org.workspace.id)).toHaveLength(kinds.length);
  });

  test("a revoke wins over a request that authenticated before it", async () => {
    const org = await organization();
    const hold = (tag: string) => {
      let authenticated!: () => void;
      let release!: () => void;
      const seen = new Promise<void>((resolve) => (authenticated = resolve));
      inflight.set(tag, {
        authenticated,
        release: new Promise<void>((resolve) => (release = resolve)),
      });
      return { seen, release };
    };
    // An existing member whose stated change is in flight when the app revokes.
    const existing = crypto.randomUUID();
    expect((await org.request(existing, CHAT)).status).toBe(200);
    const existingSubject = (await org.identity(existing)).subjectId;
    const one = hold("existing");
    const pendingOne = org.request(
      existing,
      WITH_TASKS,
      `/test/inflight/${org.workspace.id}/existing`,
    );
    await one.seen;
    expect((await org.revoke(existing)).removed).toBe(true);
    one.release();
    expect((await pendingOne).status).toBe(403);
    expect(await stored(org.workspace.id, existingSubject)).toBeNull();

    // A user who was not a member when the request authenticated, admitted by
    // a newer request and then revoked: the older request must not recreate it.
    const fresh = crypto.randomUUID();
    const two = hold("fresh");
    const pendingTwo = org.request(fresh, CHAT, `/test/inflight/${org.workspace.id}/fresh`);
    await two.seen;
    expect((await org.request(fresh, CHAT)).status).toBe(200);
    expect((await org.revoke(fresh)).removed).toBe(true);
    two.release();
    expect((await pendingTwo).status).toBe(403);
    const freshSubject = (await org.identity(fresh)).subjectId;
    expect(await stored(org.workspace.id, freshSubject)).toBeNull();

    // A request the app sends after the revoke is a new statement.
    expect((await org.request(fresh, CHAT)).status).toBe(200);
    expect(await stored(org.workspace.id, freshSubject)).toEqual(sorted(CHAT));
  });

  test("removing the member through the workspace members route also wins over an in-flight request", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    expect((await org.request(externalId, CHAT)).status).toBe(200);
    const subjectId = (await org.identity(externalId)).subjectId;
    let authenticated!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => (authenticated = resolve));
    inflight.set("removed", {
      authenticated,
      release: new Promise<void>((resolve) => (release = resolve)),
    });
    const pending = org.request(
      externalId,
      WITH_TASKS,
      `/test/inflight/${org.workspace.id}/removed`,
    );
    await seen;
    await org.service.removeWorkspaceMember(org.workspace.id, subjectId);
    release();
    expect((await pending).status).toBe(403);
    expect(await stored(org.workspace.id, subjectId)).toBeNull();
  });

  test("a request without a statement in flight during a revoke does not re-create the member", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    expect((await org.request(externalId, CHAT)).status).toBe(200);
    const subjectId = (await org.identity(externalId)).subjectId;
    let authenticated!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => (authenticated = resolve));
    inflight.set("unstated", {
      authenticated,
      release: new Promise<void>((resolve) => (release = resolve)),
    });
    // No membership field: this request would admit the user on first use.
    const pending = org.request(
      externalId,
      undefined,
      `/test/inflight/${org.workspace.id}/unstated`,
    );
    await seen;
    expect((await org.revoke(externalId)).removed).toBe(true);
    release();
    expect((await pending).status).toBe(403);
    expect(await stored(org.workspace.id, subjectId)).toBeNull();
    // A request that authenticates after the revoke admits the user again.
    expect((await org.request(externalId, undefined)).status).toBe(200);
    expect(await stored(org.workspace.id, subjectId)).not.toBeNull();
  });

  test("the database refuses a statement older than a revoke", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    const identity = await org.identity(externalId);
    const watermark = await withAccountRls(db.db, org.accountId, async (tx) => {
      await lockExternalWorkspaceMembershipLifecycle(tx, org.accountId);
      return await readExternalWorkspaceRevocationWatermark(tx);
    });
    await org.revoke(externalId);
    const scope = {
      organizationId: org.accountId,
      workspaceId: org.workspace.id,
      actorSubjectId: `api_key:${org.key.id}`,
    };
    expect(
      await applyStatedExternalWorkspaceMembership(db.db, scope, {
        identity,
        permissions: CHAT,
        revocationWatermark: watermark,
      }),
    ).toBe("superseded");
    expect(await stored(org.workspace.id, identity.subjectId)).toBeNull();
    const later = await withAccountRls(db.db, org.accountId, async (tx) => {
      await lockExternalWorkspaceMembershipLifecycle(tx, org.accountId);
      return await readExternalWorkspaceRevocationWatermark(tx);
    });
    expect(BigInt(later)).toBeGreaterThan(BigInt(watermark));
    expect(
      await applyStatedExternalWorkspaceMembership(db.db, scope, {
        identity,
        permissions: CHAT,
        revocationWatermark: later,
      }),
    ).toBe("created");
  });

  test("without a membership the stored grant applies exactly as before", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    expect((await org.request(externalId, READ_ONLY)).status).toBe(200);
    const { subjectId } = await org.identity(externalId);
    // No statement: the stored read-only grant applies and nothing is written.
    expect((await org.request(externalId, undefined)).status).toBe(200);
    expect(
      (await org.request(externalId, undefined, `/test/grant/${org.workspace.id}/sessions:create`))
        .status,
    ).toBe(403);
    expect(await stored(org.workspace.id, subjectId)).toEqual(sorted(READ_ONLY));
    expect(await events(org.workspace.id)).toHaveLength(1);
    // A new user without a statement still gets the first-use conversation defaults.
    const newcomer = crypto.randomUUID();
    expect((await org.request(newcomer, undefined)).status).toBe(200);
    expect(await stored(org.workspace.id, (await org.identity(newcomer)).subjectId)).toEqual(
      sorted(CHAT),
    );
  });

  test("work that runs later uses the last stated grant", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    expect((await org.request(externalId, WITH_TASKS)).status).toBe(200);
    expect((await org.request(externalId, [...CHAT])).status).toBe(200);
    const { subjectId } = await org.identity(externalId);
    // Automations and other work without a request read the stored grant.
    const grant = await getWorkspaceGrant(db.db, subjectId, org.workspace.id, {
      principalKind: "human_session",
    });
    expect(sorted(grant!.permissions)).toEqual(sorted(CHAT));
    // A live connection's re-check never applies a statement, even a new one.
    const fresh = await org.request(externalId, WITH_TASKS, `/test/fresh/${org.workspace.id}`);
    expect(fresh.status).toBe(200);
    expect(sorted(((await fresh.json()) as { permissions: string[] }).permissions)).toEqual(
      sorted(CHAT),
    );
    expect(await stored(org.workspace.id, subjectId)).toEqual(sorted(CHAT));
  });

  test("the last administering member is never narrowed", async () => {
    const org = await organization(["workspace:admin"]);
    const admin = crypto.randomUUID();
    const adminSet: Permission[] = ["workspace:admin"];
    expect((await org.request(admin, adminSet)).status).toBe(200);
    const refused = await org.request(admin, READ_ONLY);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toBe(
      "the workspace must keep at least one administrator",
    );
    const { subjectId } = await org.identity(admin);
    expect(await stored(org.workspace.id, subjectId)).toEqual(adminSet);
    // With a second administering member the narrowing applies.
    expect((await org.request(crypto.randomUUID(), adminSet)).status).toBe(200);
    expect((await org.request(admin, READ_ONLY)).status).toBe(200);
    expect(await stored(org.workspace.id, subjectId)).toEqual(sorted(READ_ONLY));
  });

  test("Personal workspaces keep their own grant and linked identities cannot state one", async () => {
    const org = await organization();
    const externalId = crypto.randomUUID();
    const { personalWorkspaceId, subjectId } = await org.identity(externalId);
    expect(
      (
        await org.request(
          externalId,
          READ_ONLY,
          `/test/grant/${personalWorkspaceId}/workspace:read`,
        )
      ).status,
    ).toBe(200);
    expect(await stored(personalWorkspaceId, subjectId)).toBeNull();
    const linked = await app.request(`/test/grant/${org.workspace.id}/workspace:read`, {
      headers: {
        authorization: `Bearer ${org.token}`,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "linked_native",
            identity: { externalId, source: "product" },
            linkId: crypto.randomUUID(),
            expectedLinkRevision: 1,
            membership: { permissions: READ_ONLY },
          }),
        ),
      },
    });
    expect(linked.status).toBe(400);
  });
});
