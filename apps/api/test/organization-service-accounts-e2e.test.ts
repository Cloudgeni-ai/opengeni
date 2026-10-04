import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, createManagedOrganization, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

/* End to end through the real app and PostgreSQL: an organization owner
   creates service accounts, gives them keys, and the role caps those keys. */

const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-service-accounts-e2e");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  return cookie.split(";", 1)[0]!;
}

describe("service accounts end to end", () => {
  test("create, hold keys, cap by role, delete", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "service-accounts-e2e-secret-32-bytes-long",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `service-accounts-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ola Owner", email, password }),
    });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const cookie = sessionCookie(
      await app.request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, rememberMe: true }),
      }),
    );
    const [authUser] = await shared.admin<
      { id: string }[]
    >`select id from auth_users where email = ${email}`;
    await createManagedOrganization(client.db, {
      subjectId: `user:${authUser!.id}`,
      subjectLabel: email,
      name: "Acme Robotics",
      operationId: crypto.randomUUID(),
    });
    const me = (await (await app.request("/v1/access/me", { headers: { cookie } })).json()) as {
      accountGrants: Array<{ accountId: string }>;
    };
    const organizationId = me.accountGrants[0]!.accountId;
    const owner = { cookie, "content-type": "application/json" };
    const base = `/v1/organizations/${organizationId}/service-accounts`;

    // The owner creates a member service account and gives it a key.
    const created = await app.request(base, {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name: "CI bot", description: "Runs the nightly evals" }),
    });
    expect(created.status).toBe(201);
    const bot = (await created.json()) as { id: string; role: string; activeKeyCount: number };
    expect(bot).toMatchObject({ role: "member", activeKeyCount: 0 });

    const keyFor = async (body: Record<string, unknown>) =>
      await app.request(`/v1/organizations/${organizationId}/api-keys`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify(body),
      });
    const tooMuch = await keyFor({
      name: "Too much",
      serviceAccountId: bot.id,
      policy: {
        preset: "custom",
        permissions: ["members:manage"],
        workspaceScope: { kind: "all" },
      },
    });
    expect(tooMuch.status).toBe(400);
    expect(await tooMuch.text()).toContain("member service account");
    const issued = await keyFor({
      name: "CI key",
      serviceAccountId: bot.id,
      policy: {
        preset: "custom",
        permissions: ["account:read", "workspace:read", "sessions:read"],
        workspaceScope: { kind: "all" },
      },
    });
    expect(issued.status).toBe(201);
    const { apiKey, token } = (await issued.json()) as {
      apiKey: { id: string; serviceAccount: { id: string; name: string; role: string } };
      token: string;
    };
    expect(apiKey.serviceAccount).toEqual({ id: bot.id, name: "CI bot", role: "member" });

    // The key works, and it can't manage service accounts.
    const asKey = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await app.request("/v1/access/me", { headers: asKey })).status).toBe(200);
    expect((await app.request(base, { headers: asKey })).status).toBe(403);

    // The owner lists it, makes it an admin, renames it.
    const listed = (await (await app.request(base, { headers: { cookie } })).json()) as {
      serviceAccounts: Array<{ id: string; activeKeyCount: number }>;
    };
    expect(listed.serviceAccounts.find((each) => each.id === bot.id)?.activeKeyCount).toBe(1);
    const promoted = await app.request(`${base}/${bot.id}`, {
      method: "PATCH",
      headers: owner,
      body: JSON.stringify({ role: "admin", name: "Release bot" }),
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ role: "admin", name: "Release bot" });

    // Deleting it revokes its key at once.
    expect(
      (await app.request(`${base}/${bot.id}`, { method: "DELETE", headers: { cookie } })).status,
    ).toBe(204);
    expect((await app.request("/v1/access/me", { headers: asKey })).status).toBe(401);
    expect((await app.request(`${base}/${bot.id}`, { headers: { cookie } })).status).toBe(404);

    // Another organization's service accounts are out of reach.
    expect(
      (
        await app.request(`/v1/organizations/${crypto.randomUUID()}/service-accounts`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
  }, 120_000);
});
