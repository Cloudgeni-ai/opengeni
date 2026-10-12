import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  withSessionRlsActorContext,
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
import { registerModelAccountChoiceRoutes } from "../src/routes/model-account-choice";

// Explicit model-account choice and personal preference routes over real
// PostgreSQL as the application role, signed in through managed browser
// sessions. Which account a session may use is enforced by the database and
// covered by the shared subscription-core conformance suites; these cases
// cover the HTTP translation, scoping and validation.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "http://opengeni.test";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  betterAuthSecret: "model-account-choice-route-secret-at-least-32-bytes",
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type Human = {
  userId: string;
  subjectId: string;
  app: Hono;
  defaultWorkspaceId: string;
  accountId: string;
};

async function human(label: string): Promise<Human> {
  const userId = `model-account-choice-${label}-${crypto.randomUUID()}`;
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
  registerModelAccountChoiceRoutes(app, {
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
  method: "GET" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
  origin: string = ORIGIN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await who.app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: "session=present",
      "content-type": "application/json",
      origin,
      "sec-fetch-site": origin === ORIGIN ? "same-origin" : "cross-site",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

let owner: Human;
let stranger: Human;
let sessionId = "";

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-model-account-choice");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
  owner = await human("owner");
  stranger = await human("stranger");
  const session = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    createSession(client!.db, {
      accountId: owner.accountId,
      workspaceId: owner.defaultWorkspaceId,
      initialMessage: "model account choice routes",
      resources: [],
      metadata: {},
      model: "gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: "user_private",
      subjectId: owner.subjectId,
      createdBy: { kind: "subject" as const, subjectId: owner.subjectId },
      createdByContext: {},
    }),
  );
  sessionId = session.id;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe.skipIf(!realDb)("model-account choice routes", () => {
  test("SUB-SEL-02: the owner reads the picker for their session; others cannot", async () => {
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    const read = await call(owner, "GET", path);
    expect(read.status).toBe(200);
    expect(read.json.binding).toBeNull();
    expect(read.json.accounts).toEqual([]);
    expect(read.json.personal).toMatchObject({ fallbackOptIn: false });

    // A person outside the organization has no grant on the workspace.
    expect([403, 404]).toContain((await call(stranger, "GET", path)).status);
    // An unknown session or a malformed id is not found.
    expect(
      (
        await call(
          owner,
          "GET",
          `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${crypto.randomUUID()}/model-account`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call(owner, "GET", `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/x/model-account`))
        .status,
    ).toBe(404);
  });

  test("SUB-SEL-04: choosing validates the body, refuses unknown accounts and returns to automatic idempotently", async () => {
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    expect((await call(owner, "PUT", path, { connectionId: "nope" })).status).toBe(422);
    expect((await call(owner, "PUT", path, { connectionId: null, extra: 1 })).status).toBe(422);
    expect((await call(owner, "PUT", path, {})).status).toBe(422);
    expect((await call(owner, "PUT", path, { connectionId: crypto.randomUUID() })).status).toBe(
      404,
    );
    const automatic = await call(owner, "PUT", path, { connectionId: null });
    expect(automatic.status).toBe(200);
    expect(automatic.json).toMatchObject({ changed: false, choice: "automatic" });
    expect([403, 404]).toContain(
      (await call(stranger, "PUT", path, { connectionId: null })).status,
    );
  });

  test("SUB-SEL-02: a person reads and changes only their own personal-fallback opt-in", async () => {
    const path = `/v1/organizations/${owner.accountId}/me/model-account-preferences`;
    const initial = await call(owner, "GET", path);
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({ personalFallbackOptIn: false, version: 0 });

    const on = await call(owner, "PATCH", path, { personalFallbackOptIn: true, expectedVersion: 0 });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ personalFallbackOptIn: true, version: 1 });

    const stale = await call(owner, "PATCH", path, {
      personalFallbackOptIn: false,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.details).toMatchObject({ reason: "version_conflict", currentVersion: 1 });

    expect((await call(owner, "PATCH", path, { personalFallbackOptIn: "yes" })).status).toBe(422);
    // A cross-site browser write is refused before anything is read.
    expect(
      (await call(owner, "PATCH", path, { personalFallbackOptIn: false }, "http://evil.test"))
        .status,
    ).toBe(403);

    // Another organization's member neither reads nor writes this person's row.
    expect((await call(stranger, "GET", path)).status).toBe(404);
    expect((await call(stranger, "PATCH", path, { personalFallbackOptIn: true })).status).toBe(
      404,
    );
    const after = await call(owner, "GET", path);
    expect(after.json).toMatchObject({ personalFallbackOptIn: true, version: 1 });
    // The stranger's own preferences in their own organization are independent.
    const theirs = await call(
      stranger,
      "GET",
      `/v1/organizations/${stranger.accountId}/me/model-account-preferences`,
    );
    expect(theirs.json).toMatchObject({ personalFallbackOptIn: false, version: 0 });
  });
});
