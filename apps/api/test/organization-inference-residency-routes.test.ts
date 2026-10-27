import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationApiKey,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { stampDelegatedHumanAuthorization, type ApiRouteDeps } from "@opengeni/core";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

const ORIGIN = "https://app.example.test";

let shared: SharedTestDatabase;
let db: DbClient;
const sessionsByCookie = new Map<
  string,
  { authSessionId: string; userId: string; email: string }
>();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-inference-residency-routes");
  if (!acquired) throw new Error("EU-only inference route tests require PostgreSQL");
  shared = acquired;
  await grantDeferredRuntimeAccess(shared.admin);
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

function buildApp(productAccessMode: "managed" | "local" | "configured" = "managed"): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json(
        { message: error.message, details: (error as { details?: unknown }).details ?? null },
        error.status,
      );
    throw error;
  });
  registerOrganizationMembershipRoutes(app, {
    db: db.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode,
      publicBaseUrl: ORIGIN,
    }),
    bus: new MemoryEventBus(),
    // A signed-in browser session, keyed by its cookie.
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = sessionsByCookie.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, name: "EU-only person" },
            },
          };
        },
      },
    } as never,
  } as unknown as ApiRouteDeps);
  return app;
}

/** A person signed in to the app, with their own organization. */
async function person(label: string) {
  const userId = `eu-only-${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const cookie = `session=${authSessionId}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified) values (${userId}, ${label}, ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(db.db, {
    userId,
    email,
    name: label,
    emailVerified: true,
  });
  const identity = await synchronizeCanonicalHumanLoginBindings(db.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  sessionsByCookie.set(cookie, { authSessionId, userId, email });
  return {
    subjectId: `user:${userId}`,
    email,
    cookie,
    organizationId: provisioned.organizationMemberships[0]!.organizationId,
  };
}

async function joinAsMember(
  owner: Awaited<ReturnType<typeof person>>,
  member: Awaited<ReturnType<typeof person>>,
) {
  const invitation = await createOrganizationInvitation(db.db, {
    organizationId: owner.organizationId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: member.subjectId,
    targetEmail: member.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(db.db, {
    organizationId: owner.organizationId,
    actorSubjectId: member.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
}

const endpoint = (organizationId: string) =>
  `http://x/v1/organizations/${organizationId}/inference-residency`;
const browser = (cookie: string) => ({
  cookie,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
});
const change = (euOnly: boolean, expectedVersion: number, operationId = crypto.randomUUID()) => ({
  euOnly,
  expectedVersion,
  operationId,
});

function patch(app: Hono, organizationId: string, headers: Record<string, string>, body: object) {
  return app.request(endpoint(organizationId), {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

/** An agent acting as the person, with their verified account:admin. */
function asAgent(app: Hono, organizationId: string, subjectId: string, body?: object) {
  const request = new Request(endpoint(organizationId), {
    method: body ? "PATCH" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  stampDelegatedHumanAuthorization(request, {
    organizationId,
    subjectId,
    permissions: ["account:read", "account:admin"],
    workspaceScope: { kind: "all" },
  });
  return app.fetch(request);
}

test("an agent acting as an owner turns EU-only on but never off; the owner in a browser does", async () => {
  const app = buildApp();
  const owner = await person("owner");
  const org = owner.organizationId;

  const on = await asAgent(app, org, owner.subjectId, change(true, 0));
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({
    euOnly: true,
    version: 1,
    changed: true,
    canTurnOff: false,
  });
  expect(await (await asAgent(app, org, owner.subjectId)).json()).toMatchObject({
    euOnly: true,
    canTurnOff: false,
  });

  expect((await asAgent(app, org, owner.subjectId, change(false, 1))).status).toBe(403);
  // A browser cookie with an Authorization header counts as an API key.
  expect(
    (
      await patch(
        app,
        org,
        { ...browser(owner.cookie), authorization: "Bearer not-a-key" },
        change(false, 1),
      )
    ).status,
  ).toBe(403);

  const read = await app.request(endpoint(org), { headers: { cookie: owner.cookie } });
  expect(await read.json()).toMatchObject({ euOnly: true, version: 1, canTurnOff: true });

  const off = await patch(app, org, browser(owner.cookie), change(false, 1));
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({
    euOnly: false,
    version: 2,
    changed: true,
    canTurnOff: false,
  });

  // Back on in the browser: PATCH answers canTurnOff with the same check as GET.
  const again = await patch(app, org, browser(owner.cookie), change(true, 2));
  expect(await again.json()).toMatchObject({ euOnly: true, version: 3, canTurnOff: true });

  const kinds = await shared.admin`
    select actor_kind from organization_inference_residency_events
    where account_id = ${org}::uuid order by result_version`;
  expect(kinds.map((row) => row.actor_kind)).toEqual(["agent", "browser_person", "browser_person"]);
});

test("members are refused both ways and never see canTurnOff", async () => {
  const app = buildApp();
  const owner = await person("owner");
  const member = await person("member");
  await joinAsMember(owner, member);
  const org = owner.organizationId;

  expect((await patch(app, org, browser(member.cookie), change(true, 0))).status).toBe(403);
  expect((await patch(app, org, browser(owner.cookie), change(true, 0))).status).toBe(200);
  expect((await patch(app, org, browser(member.cookie), change(false, 1))).status).toBe(403);
  const read = await app.request(endpoint(org), { headers: { cookie: member.cookie } });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ euOnly: true, canTurnOff: false });
});

test("turning EU-only off needs a sign-in from the last five minutes", async () => {
  const app = buildApp();
  const owner = await person("owner");
  const org = owner.organizationId;
  const { authSessionId } = sessionsByCookie.get(owner.cookie)!;
  await shared.admin`
    update auth_sessions set created_at = now() - interval '10 minutes'
    where id = ${authSessionId}`;

  // Turning it on doesn't need a fresh sign-in.
  expect((await patch(app, org, browser(owner.cookie), change(true, 0))).status).toBe(200);
  const stale = await patch(app, org, browser(owner.cookie), change(false, 1));
  expect(stale.status).toBe(403);
  expect(await stale.json()).toMatchObject({
    details: { code: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" },
  });

  await shared.admin`update auth_sessions set created_at = now() where id = ${authSessionId}`;
  expect((await patch(app, org, browser(owner.cookie), change(false, 1))).status).toBe(200);
});

test("an operation id replays its result and refuses a different request", async () => {
  const app = buildApp();
  const owner = await person("owner");
  const org = owner.organizationId;
  const body = change(true, 0);
  const first = await (await patch(app, org, browser(owner.cookie), body)).json();
  const replay = await patch(app, org, browser(owner.cookie), body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(first);
  expect((await patch(app, org, browser(owner.cookie), { ...body, euOnly: false })).status).toBe(
    409,
  );
  expect((await patch(app, org, browser(owner.cookie), change(false, 0))).status).toBe(409);
});

test("an organization key can turn EU-only on but never off", async () => {
  const app = buildApp();
  const owner = await person("owner");
  const org = owner.organizationId;
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId: org,
    name: "Organization administrator",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });
  const keyHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const initial = await app.request(endpoint(org), { headers: keyHeaders });
  expect(await initial.json()).toMatchObject({ euOnly: false, version: 0, canTurnOff: false });
  const on = await patch(app, org, keyHeaders, change(true, 0));
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({ euOnly: true, version: 1, canTurnOff: false });
  expect((await patch(app, org, keyHeaders, change(false, 1))).status).toBe(403);
  // Without a signed-in person, or from another site, a browser request is refused.
  const anonymous = await patch(
    app,
    org,
    { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    change(false, 1),
  );
  expect([401, 403]).toContain(anonymous.status);
  expect(
    (
      await patch(
        app,
        org,
        { ...browser(owner.cookie), origin: "https://evil.example.test" },
        change(false, 1),
      )
    ).status,
  ).toBe(403);
  expect(await (await app.request(endpoint(org), { headers: keyHeaders })).json()).toMatchObject({
    euOnly: true,
    version: 1,
  });
});

test("without Opengeni sign-in nobody could turn it off, so it can't be turned on", async () => {
  const owner = await person("owner");
  for (const mode of ["local", "configured"] as const) {
    const response = await patch(
      buildApp(mode),
      owner.organizationId,
      browser(owner.cookie),
      change(true, 0),
    );
    expect(response.status).toBe(409);
  }
});

test("until the change function is granted, changes are unavailable", async () => {
  const app = buildApp();
  const owner = await person("owner");
  await shared.admin.unsafe(
    "REVOKE EXECUTE ON FUNCTION opengeni_private.update_organization_inference_residency_v1(uuid, text, text, boolean, bigint, uuid) FROM opengeni_app",
  );
  try {
    expect(
      (await patch(app, owner.organizationId, browser(owner.cookie), change(true, 0))).status,
    ).toBe(503);
  } finally {
    await grantDeferredRuntimeAccess(shared.admin);
  }
});
