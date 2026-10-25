import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  organizationAccessPresetPermissions,
  type OrganizationWorkspaceScope,
  type Permission,
} from "@opengeni/contracts";
import { stampDelegatedHumanAuthorization } from "@opengeni/core";
import {
  createDb,
  createManagedOrganization,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { sql } from "drizzle-orm";

import { createApp } from "../src/app";
import { callOrganizationAction } from "../src/organization-mcp";

/* End to end through the real app and PostgreSQL: an owner allows admin
   access for agent sessions and gives it to their own session; an agent with
   their full access does what they can (giving admin access, their inbox,
   connected agents, API keys), one with less can't widen its access, and the
   organization turning it off ends it. A plain member of the workspace gives
   their own session their access too, and its agent can do what they can,
   never what only an owner or admin can. */

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
  test("allow, give, act fully as the person, refuse limited agents and other sessions, turn off", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "session-admin-access-e2e-secret-32-bytes",
        publicBaseUrl: origin,
        sandboxSelfhostedEnabled: true,
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

    const session = async (createdBySubjectId: string, metadata: Record<string, unknown> = {}) => {
      const id = crypto.randomUUID();
      await withWorkspaceSessionActivityRls(client.db, workspaceId, async (scoped) => {
        await scoped.execute(sql`
          insert into sessions (id, account_id, workspace_id, initial_message, model,
            reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
            root_session_id, status, created_by_kind, created_by_subject_id, metadata)
          values (${id}, ${organizationId}, ${workspaceId}, 'fixture', 'test-model', 'medium',
            'standard', 'none', ${id},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null), ${id}, 'idle',
            'subject', ${createdBySubjectId}, ${JSON.stringify(metadata)}::jsonb)`);
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

    // An agent acting as the person with their full access gives it as them;
    // one with less can't, so it can never widen its own access.
    const agentPut = (permissions: Permission[], workspaceScope: OrganizationWorkspaceScope) => {
      const request = new Request(new URL(sessionAccess(own), origin), {
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": "2" },
        body: "{}",
      });
      stampDelegatedHumanAuthorization(request, {
        organizationId,
        subjectId,
        permissions,
        workspaceScope,
      });
      return app.fetch(request);
    };
    const limited = await agentPut(organizationAccessPresetPermissions("full"), {
      kind: "selected",
      workspaceIds: [workspaceId],
    });
    expect(limited.status).toBe(403);
    expect(((await limited.json()) as { error: { message: string } }).error.message).toContain(
      "this agent's access is limited",
    );
    expect((await agentPut(["workspace:read"], { kind: "all" })).status).toBe(403);
    const byAgent = await agentPut(organizationAccessPresetPermissions("full"), { kind: "all" });
    expect(byAgent.status).toBe(200);
    expect(await byAgent.json()).toMatchObject({
      active: true,
      grantedBy: { subjectId },
      canGrant: true,
    });

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
    // The owner can give admin access to a Site-created chat normally.
    // Use the authenticated inline-frame route: Site provenance alone is not
    // authority to insert a shared root after the private-audience migration.
    const fromSiteResponse = await app.request(`/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      headers: {
        ...browser(cookie),
        "x-opengeni-site-frame": "1",
        "x-opengeni-site-frame-id": crypto.randomUUID(),
      },
      body: JSON.stringify({ startMode: "realtime" }),
    });
    expect(fromSiteResponse.status, await fromSiteResponse.clone().text()).toBe(202);
    const fromSite = ((await fromSiteResponse.json()) as { id: string }).id;
    const [siteAudience] = await shared.admin`
      select visibility, owner_subject_id, site_access_root_id from sessions where id = ${fromSite}`;
    expect(siteAudience).toMatchObject({
      visibility: "user_private",
      owner_subject_id: subjectId,
      site_access_root_id: fromSite,
    });
    const refusedForSite = await app.request(sessionAccess(fromSite), {
      method: "PUT",
      headers: browser(cookie),
      body: "{}",
    });
    expect(refusedForSite.status, await refusedForSite.clone().text()).toBe(200);
    expect(
      await (await app.request(sessionAccess(fromSite), { headers: { cookie } })).json(),
    ).toMatchObject({ active: true });

    const granted = await app.request(sessionAccess(own), {
      method: "PUT",
      headers: browser(cookie),
      body: "{}",
    });
    expect(granted.status).toBe(200);
    const grantedBody = (await granted.json()) as { grantedAt: string; expiresAt: string };
    expect(grantedBody).toMatchObject({
      active: true,
      grantedBy: { subjectId, name: "Maja Berg" },
      canRevoke: true,
      // The person can choose a new time limit while it is on.
      canGrant: true,
    });
    // No length given: one hour.
    expect(
      Math.abs(Date.parse(grantedBody.expiresAt) - Date.parse(grantedBody.grantedAt) - 3_600_000),
    ).toBeLessThan(5_000);

    // A chosen number of hours, or no time limit; anything else is refused.
    const choose = async (body: string) =>
      await app.request(sessionAccess(own), { method: "PUT", headers: browser(cookie), body });
    const day = await choose(JSON.stringify({ durationHours: 24 }));
    expect(day.status).toBe(200);
    const dayBody = (await day.json()) as { expiresAt: string };
    expect(Date.parse(dayBody.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    for (const bad of ['{"durationHours":0}', '{"durationHours":1.5}', '{"durationHours":"8"}']) {
      expect((await choose(bad)).status).toBe(422);
    }
    expect((await choose("not json")).status).toBe(422);
    const open = await choose(JSON.stringify({ durationHours: null }));
    expect(await open.json()).toMatchObject({ active: true, expiresAt: null });

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

    // Everything the person can do in the organization, as them.
    const asPerson = async (
      id: string,
      pathParameters: Record<string, string>,
      body?: Record<string, unknown>,
    ) => {
      const result = await callOrganizationAction(
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
        { id, pathParameters, query: {}, ...(body ? { body } : {}) },
      );
      expect(result.isError).toBeUndefined();
      return JSON.parse((result.content[0] as { text: string }).text) as {
        status: number;
        body: Record<string, unknown>;
      };
    };
    const another = await session(subjectId);
    expect(
      await asPerson(
        "grantSessionAdminAccess",
        { workspaceId, sessionId: another },
        { durationHours: 8 },
      ),
    ).toMatchObject({ status: 200, body: { active: true, grantedBy: { subjectId } } });
    expect(await asPerson("listInbox", {})).toMatchObject({ status: 200 });
    expect(await asPerson("getSessionInboxMute", { workspaceId, sessionId: own })).toMatchObject({
      status: 200,
      body: { repliesMuted: false },
    });
    expect(await asPerson("listOrganizationMcpConnections", { organizationId })).toMatchObject({
      status: 200,
      body: { connections: [], canManageAll: true },
    });
    const key = await asPerson(
      "createOrganizationApiKey",
      { organizationId },
      { name: "Made by an agent", access: "read" },
    );
    expect(key).toMatchObject({ status: 201, body: { apiKey: { name: "Made by an agent" } } });

    // Who can use a connected machine, as the person: preview, then make it
    // Only me. An agent with less than their full access is refused.
    const [machine] = (await shared.admin.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${organizationId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true)`;
      return await tx<Array<{ enrollmentId: string }>>`
        select enrollment_id as "enrollmentId"
        from finalize_scoped_enrollment(
          ${organizationId}::uuid, ${workspaceId}::uuid, 'workspace',
          ${`ed25519:admin-access-${crypto.randomUUID()}`},
          true, false, 'linux', 'x86_64', 'Build box', false
        )`;
    })) as Array<{ enrollmentId: string }>;
    const machinePath = { workspaceId, enrollmentId: machine!.enrollmentId };
    const preview = await asPerson("previewMachineAudience", machinePath, {
      audience: "only_me",
    });
    expect(preview).toMatchObject({ status: 200, body: { ready: true } });
    const audienceBody = JSON.stringify({ audience: "only_me" });
    const limitedAudience = new Request(
      new URL(
        `/v1/workspaces/${workspaceId}/machines/${machine!.enrollmentId}/audience/preview`,
        origin,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(audienceBody.length),
        },
        body: audienceBody,
      },
    );
    stampDelegatedHumanAuthorization(limitedAudience, {
      organizationId,
      subjectId,
      permissions: organizationAccessPresetPermissions("full"),
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
    });
    const refusedAudience = await app.fetch(limitedAudience);
    expect(refusedAudience.status).toBe(403);
    expect(
      ((await refusedAudience.json()) as { error: { message: string } }).error.message,
    ).toContain("this agent's access is limited");
    expect(
      await asPerson("changeMachineAudience", machinePath, {
        audience: "only_me",
        expectedGeneration: preview.body.generation,
      }),
    ).toMatchObject({ status: 200, body: { audience: "only_me" } });

    // A plain member of the workspace gives their own session their access;
    // its agent then does what they can and is refused what they can't.
    const memberEmail = `member-${crypto.randomUUID()}@example.test`;
    await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sam Rivera", email: memberEmail, password }),
    });
    await shared.admin`update auth_users set email_verified = true where email = ${memberEmail}`;
    const memberCookie = sessionCookie(
      await app.request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: memberEmail, password, rememberMe: true }),
      }),
    );
    const [memberUser] = await shared.admin<
      { id: string }[]
    >`select id from auth_users where email = ${memberEmail}`;
    const memberSubjectId = `user:${memberUser!.id}`;
    const memberPersonal = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name)
      values (${memberPersonal}, ${organizationId}, 'Personal')`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${memberPersonal}, ${organizationId})`;
    await shared.admin`
      insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      values (${organizationId}, ${memberSubjectId}, 'member', 'active', ${memberPersonal})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
      values (${organizationId}, ${workspaceId}, ${memberSubjectId}, ${memberEmail}, 'member',
        ${shared.admin.json(["workspace:read", "sessions:create", "sessions:read", "sessions:control"])})`;
    const membersOwn = await session(memberSubjectId);
    expect(
      await (
        await app.request(sessionAccess(membersOwn), { headers: { cookie: memberCookie } })
      ).json(),
    ).toMatchObject({ active: false, allowed: true, canGrant: true });
    // Not on someone else's session.
    expect(
      (
        await app.request(sessionAccess(own), {
          method: "PUT",
          headers: browser(memberCookie),
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const memberGranted = await app.request(sessionAccess(membersOwn), {
      method: "PUT",
      headers: browser(memberCookie),
      body: "{}",
    });
    expect(memberGranted.status, await memberGranted.clone().text()).toBe(200);
    expect(await memberGranted.json()).toMatchObject({
      active: true,
      grantedBy: { subjectId: memberSubjectId, name: "Sam Rivera" },
      canRevoke: true,
    });
    // The owner sees it, can end it, but can't give it on the member's behalf.
    expect(
      await (await app.request(sessionAccess(membersOwn), { headers: { cookie } })).json(),
    ).toMatchObject({ active: true, canGrant: false, canRevoke: true });
    const asMember = async (
      id: string,
      pathParameters: Record<string, string>,
      body?: Record<string, unknown>,
    ) => {
      const result = await callOrganizationAction(
        {
          caller: {
            kind: "person",
            accountId: organizationId,
            subjectId: memberSubjectId,
            access: {
              preset: "full",
              permissions: organizationAccessPresetPermissions("full"),
              workspaceScope: { kind: "all" },
            },
          },
          origin,
          dispatch: async (request) => await app.fetch(request),
        },
        { id, pathParameters, query: {}, ...(body ? { body } : {}) },
      );
      return JSON.parse((result.content[0] as { text: string }).text) as { status: number };
    };
    expect(
      await asMember("getSessionAdminAccess", { workspaceId, sessionId: membersOwn }),
    ).toMatchObject({ status: 200 });
    expect(
      (
        await asMember(
          "createOrganizationApiKey",
          { organizationId },
          { name: "Not for members", access: "read" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await asMember(
          "updateOrganizationAgentAdminAccess",
          { organizationId },
          { sessionAdminAccessAllowed: false },
        )
      ).status,
    ).toBe(403);
    // Leaving the workspace ends it.
    await shared.admin`
      delete from workspace_memberships
      where workspace_id = ${workspaceId} and subject_id = ${memberSubjectId}`;
    expect(
      await (await app.request(sessionAccess(membersOwn), { headers: { cookie } })).json(),
    ).toMatchObject({ active: false });

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
