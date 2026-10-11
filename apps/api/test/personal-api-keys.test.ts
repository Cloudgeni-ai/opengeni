import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { organizationAccessPresetPermissions } from "@opengeni/contracts";
import {
  acceptOrganizationInvitation,
  createDb,
  createManagedOrganization,
  createOrganizationInvitation,
  updateOrganizationMember,
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

/* End to end through the real app and PostgreSQL: a personal API key acts as
   the person who made it, with their live access capped by the key. A changed
   role applies at once, suspension pauses the key, leaving revokes it, and
   nobody can see or revoke someone else's key unless they are an admin. */

const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("personal-api-keys");
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

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

type CreatedKey = {
  apiKey: {
    id: string;
    prefix: string;
    access: { preset: string; permissions: string[] };
    owner: { subjectId: string; name: string };
    expiresAt: string | null;
  };
  token: string;
};

describe("personal API keys end to end", () => {
  test("act as the person with live access, capped by the key, and stop when they leave", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "personal-api-keys-test-secret-32-bytes",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });

    const signUp = async (name: string) => {
      const email = `personal-keys-${crypto.randomUUID()}@example.test`;
      const password = "password1234";
      await app.request("/v1/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      await shared.admin`update auth_users set email_verified = true where email = ${email}`;
      const cookie = sessionCookie(
        await app.request("/v1/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, rememberMe: true }),
        }),
      );
      const [user] = await shared.admin<
        { id: string }[]
      >`select id from auth_users where email = ${email}`;
      return { cookie, email, subjectId: `user:${user!.id}` };
    };

    const owner = await signUp("Maja Berg");
    await createManagedOrganization(client.db, {
      subjectId: owner.subjectId,
      subjectLabel: owner.email,
      name: "Acme Robotics",
      operationId: crypto.randomUUID(),
    });
    const ownerAccess = (await (
      await app.request("/v1/access/me", { headers: { cookie: owner.cookie } })
    ).json()) as {
      accountGrants: Array<{ accountId: string }>;
      workspaceGrants: Array<{ workspaceId: string }>;
    };
    const organizationId = ownerAccess.accountGrants[0]!.accountId;
    const workspaceId = ownerAccess.workspaceGrants[0]!.workspaceId;

    const member = await signUp("Ola Nordmann");
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: owner.subjectId,
      operationId: crypto.randomUUID(),
      targetSubjectId: member.subjectId,
      targetEmail: member.email,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    let { membership } = await acceptOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: member.subjectId,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
    const transition = async (
      kind: "change_role" | "suspend" | "reactivate" | "offboard",
      role?: "admin" | "member",
    ) => {
      membership = await updateOrganizationMember(client.db, {
        organizationId,
        actorSubjectId: owner.subjectId,
        operationId: crypto.randomUUID(),
        membershipId: membership.id,
        transition: {
          kind,
          ...(role ? { role } : {}),
          expectedAuthorizationRevision: membership.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      });
    };

    const keys = `/v1/organizations/${organizationId}/personal-api-keys`;
    const create = async (
      headers: Record<string, string>,
      body: Record<string, unknown>,
    ): Promise<Response> =>
      await app.request(keys, { method: "POST", headers, body: JSON.stringify(body) });
    const full = {
      preset: "full",
      permissions: organizationAccessPresetPermissions("full"),
      workspaceScope: { kind: "all" },
    };

    // Made in the browser, shown once, and never listed again.
    const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const created = await create(browser(member.cookie), {
      name: "Laptop scripts",
      access: full,
      expiresAt,
    });
    expect(created.status).toBe(201);
    const laptop = (await created.json()) as CreatedKey;
    expect(laptop.token.startsWith("ogp_")).toBe(true);
    expect(laptop.token.startsWith(laptop.apiKey.prefix)).toBe(true);
    expect(laptop.apiKey).toMatchObject({
      owner: { subjectId: member.subjectId, name: "Ola Nordmann" },
      access: { preset: "full" },
    });
    const listed = await app.request(keys, { headers: { cookie: member.cookie } });
    expect(JSON.stringify(await listed.json())).not.toContain(laptop.token);

    // A key can't be made with another key's header or from another site.
    expect(
      (
        await create(
          { ...browser(member.cookie), origin: "https://evil.example" },
          { name: "x", access: full },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await create(browser(member.cookie), {
          name: "Already expired",
          access: full,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
      ).status,
    ).toBe(400);

    // The key is the person: same subject, same organization, their role.
    const me = async (token: string) =>
      await app.request("/v1/access/me", { headers: bearer(token) });
    const asMember = await me(laptop.token);
    expect(asMember.status).toBe(200);
    expect(await asMember.json()).toMatchObject({
      mode: "managed",
      subjectId: member.subjectId,
    });
    const invitations = `/v1/organizations/${organizationId}/invitations`;
    expect((await app.request(invitations, { headers: bearer(laptop.token) })).status).toBe(403);

    // Their live access applies at once: promoted, the same key can do admin
    // work; demoted again, it can't.
    await transition("change_role", "admin");
    expect((await app.request(invitations, { headers: bearer(laptop.token) })).status).toBe(200);
    await transition("change_role", "member");
    expect((await app.request(invitations, { headers: bearer(laptop.token) })).status).toBe(403);

    // A full-access key can do what the person can, including making a key;
    // a limited one can't make one, so a key never widens itself.
    const viaKey = await create(bearer(laptop.token), {
      name: "Made by a script",
      access: {
        preset: "custom",
        permissions: ["workspace:read", "sessions:read"],
        workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
      },
    });
    expect(viaKey.status).toBe(201);
    const limited = (await viaKey.json()) as CreatedKey;
    expect(limited.apiKey.expiresAt).toBeNull();
    const fromLimited = await create(bearer(limited.token), { name: "Wider", access: full });
    expect(fromLimited.status).toBe(403);

    // Capped by the key even when the person can do more.
    await transition("change_role", "admin");
    const limitedMe = (await (await me(limited.token)).json()) as {
      subjectId: string;
      accountGrants: Array<{ permissions: string[] }>;
    };
    expect(limitedMe.subjectId).toBe(member.subjectId);
    expect(limitedMe.accountGrants[0]?.permissions ?? []).not.toContain("members:manage");
    expect((await app.request(invitations, { headers: bearer(limited.token) })).status).toBe(403);
    await transition("change_role", "member");

    // Done as the person: attribution is theirs, not a key's.
    const sessionId = crypto.randomUUID();
    await withWorkspaceSessionActivityRls(client.db, workspaceId, async (scoped) => {
      await scoped.execute(sql`
        insert into sessions (id, account_id, workspace_id, initial_message, model,
          reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
          root_session_id, status, created_by_kind, created_by_subject_id)
        values (${sessionId}, ${organizationId}, ${workspaceId}, 'fixture', 'test-model', 'medium',
          'standard', 'none', ${sessionId},
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null), ${sessionId},
          'idle', 'subject', ${owner.subjectId})`);
    });
    const ownerKey = (await (
      await create(browser(owner.cookie), { name: "Owner automation", access: full })
    ).json()) as CreatedKey;
    const sessions = await app.request(`/v1/workspaces/${workspaceId}/sessions?view=page`, {
      headers: bearer(ownerKey.token),
    });
    expect(sessions.status).toBe(200);
    expect(JSON.stringify(await sessions.json())).toContain(sessionId);

    // The organization MCP server accepts the key as the person.
    const mcp = await app.request("/v1/mcp", {
      method: "POST",
      headers: { ...bearer(laptop.token), accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "opengeni_action_call", arguments: { id: "getAccessContext" } },
      }),
    });
    expect(mcp.status).toBe(200);
    const mcpBody = (await mcp.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(mcpBody.result.content[0]!.text)).toMatchObject({
      status: 200,
      body: { subjectId: member.subjectId },
    });

    // It acts only as its owner: never as a service or someone else.
    const impersonate = await app.request("/v1/access/me", {
      headers: {
        ...bearer(laptop.token),
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity: { source: "x:y", externalId: "z" } }),
        ),
      },
    });
    expect(impersonate.status).toBe(403);

    // People see and revoke only their own; admins see and revoke everyone's.
    const mine = (await (
      await app.request(keys, { headers: { cookie: member.cookie } })
    ).json()) as {
      apiKeys: Array<{ id: string }>;
      canManageAll: boolean;
    };
    expect(mine.canManageAll).toBe(false);
    expect(mine.apiKeys.map((key) => key.id).sort()).toEqual(
      [laptop.apiKey.id, limited.apiKey.id].sort(),
    );
    expect(
      (
        await app.request(`${keys}/${ownerKey.apiKey.id}`, {
          method: "DELETE",
          headers: browser(member.cookie),
        })
      ).status,
    ).toBe(404);
    const everyone = (await (
      await app.request(keys, { headers: { cookie: owner.cookie } })
    ).json()) as { apiKeys: Array<{ id: string }>; canManageAll: boolean };
    expect(everyone.canManageAll).toBe(true);
    expect(everyone.apiKeys).toHaveLength(3);
    expect(
      (
        await app.request(`${keys}/${limited.apiKey.id}`, {
          method: "DELETE",
          headers: browser(owner.cookie),
        })
      ).status,
    ).toBe(204);
    expect((await me(limited.token)).status).toBe(401);

    // An expired key stops working.
    const shortLived = (await (
      await create(browser(member.cookie), {
        name: "Short lived",
        access: full,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).json()) as CreatedKey;
    expect((await me(shortLived.token)).status).toBe(200);
    await shared.admin`update api_keys set expires_at = now() - interval '1 second'
      where id = ${shortLived.apiKey.id}`;
    expect((await me(shortLived.token)).status).toBe(401);

    // Suspended, the key pauses; reactivated, it works again.
    await transition("suspend");
    expect((await me(laptop.token)).status).not.toBe(200);
    await transition("reactivate");
    expect((await me(laptop.token)).status).toBe(200);

    // Leaving revokes every key that acts as them, for good.
    await transition("offboard");
    expect((await me(laptop.token)).status).toBe(401);
    const [remaining] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from api_keys
      where owner_subject_id = ${member.subjectId} and revoked_at is null`;
    expect(remaining!.count).toBe(0);
  }, 120_000);
});
