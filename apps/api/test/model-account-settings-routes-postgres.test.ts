import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { ApiHttpError } from "../src/http/api-error";
import { registerModelAccountSettingsRoutes } from "../src/routes/model-account-settings";

// Model-account settings routes (SUB-SET-01..05) over real PostgreSQL as the
// application role, signed in through managed browser sessions: the
// organization owner, and a member who administers one shared workspace.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "http://opengeni.test";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  betterAuthSecret: "model-account-settings-route-secret-at-least-32-bytes",
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type Human = { userId: string; subjectId: string; app: Hono; defaultWorkspaceId: string; accountId: string };

async function human(label: string): Promise<Human> {
  const userId = `model-account-settings-${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const sessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  const access = await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId,
    email,
    name: label,
    emailVerified: true,
  });
  await shared!.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const app = new Hono();
  app.onError((error, c) => {
    const status = (error as { status?: number }).status ?? 500;
    const details = error instanceof ApiHttpError ? error.details : undefined;
    return c.json({ message: error.message, details }, status as 403);
  });
  registerModelAccountSettingsRoutes(app, {
    db: client!.db,
    settings,
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: sessionId },
            user: { id: userId, email, name: label, emailVerified: true },
          },
        }),
      },
    } as never,
  } as ApiRouteDeps);
  const grant = access.accessContext.workspaceGrants[0]!;
  return {
    userId,
    subjectId: `user:${userId}`,
    app,
    defaultWorkspaceId: grant.workspaceId,
    accountId: grant.accountId,
  };
}

async function call(
  who: Human,
  method: "GET" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await who.app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: "session=present",
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

let owner: Human;
let member: Human;
let alphaId = "";
let betaId = "";

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-model-account-settings");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
  owner = await human("owner");
  member = await human("member");
  for (const name of ["Alpha", "Beta"]) {
    const [row] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${owner.accountId}::uuid, ${name})
      returning id::text as id`;
    if (name === "Alpha") alphaId = row!.id;
    else betaId = row!.id;
  }
  // The member joins the owner's organization as an ordinary member and
  // administers Alpha only.
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${owner.accountId}::uuid, 'Personal')
    returning id::text as id`;
  await shared.admin`insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, role
    ) values (${owner.accountId}::uuid, ${member.subjectId}, 'active', ${personal!.id}::uuid, 'member')`;
  await shared.admin`insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values
      (${owner.accountId}::uuid, ${alphaId}::uuid, ${member.subjectId}, 'admin',
        ${shared.admin.json(["workspace:read", "workspace:admin"])}::jsonb),
      (${owner.accountId}::uuid, ${betaId}::uuid, ${member.subjectId}, 'member',
        ${shared.admin.json(["workspace:read"])}::jsonb),
      (${owner.accountId}::uuid, ${alphaId}::uuid, ${owner.subjectId}, 'admin',
        ${shared.admin.json(["workspace:read", "workspace:admin"])}::jsonb)`;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe.skipIf(!realDb)("model-account settings routes", () => {
  test("SUB-SET-01: organization administrators read and change settings and locks; others are refused", async () => {
    const organizationPath = `/v1/organizations/${owner.accountId}/model-account-settings`;
    const read = await call(owner, "GET", organizationPath);
    expect(read.status).toBe(200);
    expect(read.json.locked).toEqual([]);
    const version = read.json.version as number;

    const changed = await call(owner, "PATCH", organizationPath, {
      crossProviderFailover: true,
      fallbackOrder: { "codex/a": ["claude/b"] },
      expectedVersion: version,
    });
    expect(changed.status).toBe(200);
    expect((changed.json.values as Record<string, unknown>).crossProviderFailover).toBe(true);

    const stale = await call(owner, "PATCH", organizationPath, {
      personalFallbackAllowed: true,
      expectedVersion: version,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.details).toMatchObject({ reason: "version_conflict" });

    expect((await call(owner, "PATCH", organizationPath, { locked: ["models"] })).status).toBe(422);
    expect(
      (await call(owner, "PATCH", organizationPath, { fallbackOrder: { "codex/a": ["codex/a"] } }))
        .status,
    ).toBe(422);
    // Rotation only for providers whose accounts run on the shared core.
    expect(
      (await call(owner, "PATCH", organizationPath, { rotation: { xai: { mode: "spread" } } }))
        .status,
    ).toBe(422);

    // A member (even a workspace administrator) is not an organization administrator.
    expect((await call(member, "GET", organizationPath)).status).toBe(403);
    expect((await call(member, "PATCH", organizationPath, { locked: [] })).status).toBe(403);
    expect((await call(member, "GET", `${organizationPath}/overview`)).status).toBe(403);
  });

  test("SUB-SET-02: workspace overrides, locks and the overview with sources", async () => {
    const organizationPath = `/v1/organizations/${owner.accountId}/model-account-settings`;
    const alphaPath = `/v1/workspaces/${alphaId}/model-account-settings`;
    const betaPath = `/v1/workspaces/${betaId}/model-account-settings`;
    await call(owner, "PATCH", organizationPath, { locked: [] });

    const overridden = await call(member, "PATCH", alphaPath, { personalConnectionsAllowed: false });
    expect(overridden.status).toBe(200);
    expect((overridden.json.sources as Record<string, string>).personalConnectionsAllowed).toBe(
      "workspace",
    );
    expect(overridden.json.canEdit).toBe(true);

    // Beta: the member reads but does not administer it.
    const betaRead = await call(member, "GET", betaPath);
    expect(betaRead.status).toBe(200);
    expect(betaRead.json.canEdit).toBe(false);
    expect((await call(member, "PATCH", betaPath, { personalConnectionsAllowed: false })).status).toBe(
      403,
    );

    // Locking clears Alpha's override; setting it again is refused with the lock named.
    const locked = await call(owner, "PATCH", organizationPath, {
      locked: ["personalConnectionsAllowed"],
    });
    expect(locked.status).toBe(200);
    const afterLock = await call(member, "GET", alphaPath);
    expect((afterLock.json.overrides as Record<string, unknown>).personalConnectionsAllowed).toBeNull();
    expect((afterLock.json.sources as Record<string, string>).personalConnectionsAllowed).toBe("locked");
    const refused = await call(member, "PATCH", alphaPath, { personalConnectionsAllowed: false });
    expect(refused.status).toBe(409);
    expect(refused.json.details).toEqual({
      reason: "setting_locked",
      settings: ["personalConnectionsAllowed"],
    });
    // Organization administrators cannot override a lock in a workspace either.
    expect((await call(owner, "PATCH", alphaPath, { personalConnectionsAllowed: false })).status).toBe(
      409,
    );
    // Unlocked settings stay editable.
    expect((await call(member, "PATCH", alphaPath, { personalFallbackAllowed: true })).status).toBe(200);

    const overview = await call(owner, "GET", `${organizationPath}/overview?limit=500`);
    expect(overview.status).toBe(200);
    const rows = overview.json.workspaces as {
      workspaceId: string;
      name: string;
      sources: Record<string, string>;
    }[];
    expect(rows.map((row) => row.name).sort()).toEqual(["Alpha", "Beta", "Default workspace"].sort());
    const alpha = rows.find((row) => row.workspaceId === alphaId)!;
    expect(alpha.sources).toMatchObject({
      personalConnectionsAllowed: "locked",
      personalFallbackAllowed: "workspace",
      crossProviderFailover: "organization",
    });
    expect((await call(owner, "GET", `${organizationPath}/overview?limit=0`)).status).toBe(422);
    expect((await call(owner, "GET", `${organizationPath}/overview?after=nope`)).status).toBe(422);
  });

  test("strict bodies and unknown ids", async () => {
    const alphaPath = `/v1/workspaces/${alphaId}/model-account-settings`;
    expect((await call(member, "PATCH", alphaPath, { locked: ["rotation"] })).status).toBe(422);
    expect((await call(member, "PATCH", alphaPath, { unknown: true })).status).toBe(422);
    expect((await call(owner, "GET", "/v1/organizations/not-a-uuid/model-account-settings")).status).toBe(
      404,
    );
  });
});
