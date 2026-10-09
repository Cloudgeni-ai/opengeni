import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { organizationAccessPresetPermissions } from "@opengeni/contracts";
import { stampDelegatedHumanAuthorization } from "@opengeni/core";
import {
  createDb,
  createManagedOrganization,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";

import { createApp } from "../src/app";
import { callOrganizationAction } from "../src/organization-mcp";

/* End to end through the real app and PostgreSQL: an owner allows admin
   access for agent sessions, gives it to their own session in the browser,
   an agent acting as them can't give it, and the organization turning it off
   ends it. */

const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-admin-access-e2e");
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

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

describe("session admin access end to end", () => {
  test("allow, give in person, refuse agents and other sessions, turn off", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "session-admin-access-e2e-secret-32-bytes",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });

    const email = `admin-access-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Maja Berg", email, password }),
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
    const subjectId = `user:${authUser!.id}`;
    await createManagedOrganization(client.db, {
      subjectId,
      subjectLabel: email,
      name: "Acme Robotics",
      operationId: crypto.randomUUID(),
    });
    const access = (await (await app.request("/v1/access/me", { headers: { cookie } })).json()) as {
      accountGrants: Array<{ accountId: string }>;
      workspaceGrants: Array<{ workspaceId: string }>;
    };
    const organizationId = access.accountGrants[0]!.accountId;
    const workspaceId = access.workspaceGrants[0]!.workspaceId;

    const session = async (createdBySubjectId: string) => {
      const id = crypto.randomUUID();
      await withWorkspaceSessionActivityRls(client.db, workspaceId, async (scoped) => {
        await scoped.execute(sql`
          insert into sessions (id, account_id, workspace_id, initial_message, model,
            reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
            root_session_id, status, created_by_kind, created_by_subject_id)
          values (${id}, ${organizationId}, ${workspaceId}, 'fixture', 'test-model', 'medium',
            'standard', 'none', ${id},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null), ${id}, 'idle',
            'subject', ${createdBySubjectId})`);
      });
      return id;
    };
    const own = await session(subjectId);
    const someoneElses = await session(`user:${crypto.randomUUID()}`);
    const setting = `/v1/organizations/${organizationId}/agent-admin-access`;
    const sessionAccess = (id: string) =>
      `/v1/workspaces/${workspaceId}/sessions/${id}/admin-access`;

    // Off by default: nothing can be given.
    expect(await (await app.request(setting, { headers: { cookie } })).json()).toMatchObject({
      sessionAdminAccessAllowed: false,
    });
    expect(
      await (await app.request(sessionAccess(own), { headers: { cookie } })).json(),
    ).toMatchObject({ active: false, allowed: false, canGrant: false });
    expect(
      (
        await app.request(sessionAccess(own), {
          method: "PUT",
          headers: browser(cookie),
          body: "{}",
        })
      ).status,
    ).toBe(409);

    // Allowing it is a browser step.
    expect(
      (
        await app.request(setting, {
          method: "PATCH",
          headers: { ...browser(cookie), origin: "https://evil.example" },
          body: JSON.stringify({ sessionAdminAccessAllowed: true }),
        })
      ).status,
    ).toBe(403);
    const allowed = await app.request(setting, {
      method: "PATCH",
      headers: browser(cookie),
      body: JSON.stringify({ sessionAdminAccessAllowed: true }),
    });
    expect(allowed.status).toBe(200);
    expect(
      await (await app.request(sessionAccess(own), { headers: { cookie } })).json(),
    ).toMatchObject({ active: false, allowed: true, canGrant: true });

    // An agent acting as the person can read it, never give it.
    const asAgent = new Request(new URL(sessionAccess(own), origin), {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: "{}",
    });
    stampDelegatedHumanAuthorization(asAgent, {
      organizationId,
      subjectId,
      permissions: organizationAccessPresetPermissions("full"),
      workspaceScope: { kind: "all" },
    });
    expect((await app.fetch(asAgent)).status).toBe(403);

    // Only your own session.
    expect(
      (
        await app.request(sessionAccess(someoneElses), {
          method: "PUT",
          headers: browser(cookie),
          body: "{}",
        })
      ).status,
    ).toBe(403);

    const granted = await app.request(sessionAccess(own), {
      method: "PUT",
      headers: browser(cookie),
      body: "{}",
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({
      active: true,
      grantedBy: { subjectId, name: "Maja Berg" },
      canRevoke: true,
    });

    // The admin actions run as the person who gave access.
    const listed = await callOrganizationAction(
      {
        caller: {
          kind: "person",
          accountId: organizationId,
          subjectId,
          access: {
            preset: "full",
            permissions: organizationAccessPresetPermissions("full"),
            workspaceScope: { kind: "all" },
          },
        },
        origin,
        dispatch: async (request) => await app.fetch(request),
      },
      {
        id: "GET /v1/workspaces/:workspaceId/sessions/:sessionId/admin-access",
        pathParameters: { workspaceId, sessionId: own },
        query: {},
      },
    );
    expect(listed.isError).toBeUndefined();
    expect(JSON.parse((listed.content[0] as { text: string }).text)).toMatchObject({
      status: 200,
      body: { active: true },
    });

    // Turning the organization setting off ends it.
    expect(
      (
        await app.request(setting, {
          method: "PATCH",
          headers: browser(cookie),
          body: JSON.stringify({ sessionAdminAccessAllowed: false }),
        })
      ).status,
    ).toBe(200);
    expect(
      await (await app.request(sessionAccess(own), { headers: { cookie } })).json(),
    ).toMatchObject({ active: false, allowed: false, canRevoke: false });
  }, 120_000);
});
