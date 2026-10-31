import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { organizationAccessPresetPermissions } from "@opengeni/contracts";
import {
  acceptOrganizationInvitation,
  createDb,
  createManagedOrganization,
  createOrganizationInvitation,
  createWorkspace,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";

/* End to end through the real app and PostgreSQL: an organization admin, like
   the owner, sees everyone's connected agents and can disconnect any of them,
   but only the person who connected an agent changes what it can do. A member
   sees only their own, and being an admin in one organization grants nothing
   in another where the same person is a member. */

const origin = "http://opengeni.test";
const redirectUri = "http://127.0.0.1:4567/callback";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-admin-connected-agents");
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

type Person = { cookie: string; email: string; subjectId: string };
type Listed = { connections: Array<{ id: string; clientName: string }>; canManageAll: boolean };

describe("organization admins and connected agents", () => {
  test("owner and admin see and disconnect everyone's agents; only the person changes its access", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "organization-admin-agents-secret-32-bytes",
        publicBaseUrl: origin,
        delegationSecret: "organization-admin-agents-delegation-secret",
        environmentsEncryptionKey: randomBytes(32).toString("base64"),
        mcpOauthEnabled: true,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });

    const signUp = async (name: string): Promise<Person> => {
      const email = `org-admin-agents-${crypto.randomUUID()}@example.test`;
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
    const organization = async (owner: Person, name: string) => {
      await createManagedOrganization(client.db, {
        subjectId: owner.subjectId,
        subjectLabel: owner.email,
        name,
        operationId: crypto.randomUUID(),
      });
      const grants = (await (
        await app.request("/v1/access/me", { headers: { cookie: owner.cookie } })
      ).json()) as { accountGrants: Array<{ accountId: string; role?: string }> };
      const accountId = grants.accountGrants.find((grant) => grant.role === "owner")!.accountId;
      await createWorkspace(client.db, { accountId, name: `${name} team` });
      return accountId;
    };
    const invite = async (
      organizationId: string,
      owner: Person,
      person: Person,
      role: "admin" | "member",
    ) => {
      const invitation = await createOrganizationInvitation(client.db, {
        organizationId,
        actorSubjectId: owner.subjectId,
        operationId: crypto.randomUUID(),
        targetSubjectId: person.subjectId,
        targetEmail: person.email,
        role,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await acceptOrganizationInvitation(client.db, {
        organizationId,
        actorSubjectId: person.subjectId,
        operationId: crypto.randomUUID(),
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      });
    };
    /** Signs an outside agent in to the organization MCP server as `person`. */
    const connectAgent = async (person: Person, organizationId: string, clientName: string) => {
      const registered = await app.request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        }),
      });
      expect(registered.status).toBe(201);
      const { client_id: clientId } = (await registered.json()) as { client_id: string };
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL("/oauth/authorize", origin);
      for (const [key, value] of Object.entries({
        response_type: "code",
        scope: "mcp:access",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource: `${origin}/v1/mcp`,
        state: "fixture-state",
      }))
        authorize.searchParams.set(key, value);
      const started = await app.request(authorize.pathname + authorize.search, {
        headers: { cookie: person.cookie },
      });
      expect(started.status).toBe(302);
      const requestToken = new URL(started.headers.get("location")!).searchParams.get("request")!;
      const approved = await app.request(`/v1/mcp-connections/requests/${requestToken}`, {
        method: "POST",
        headers: browser(person.cookie),
        body: JSON.stringify({
          decision: "approve",
          organizationId,
          access: {
            preset: "read_only",
            permissions: organizationAccessPresetPermissions("read_only"),
            workspaceScope: { kind: "all" },
          },
        }),
      });
      expect(approved.status, await approved.clone().text()).toBe(200);
      // The connected agent exists once the client trades the code for tokens.
      const code = new URL(
        ((await approved.json()) as { redirectTo: string }).redirectTo,
      ).searchParams.get("code")!;
      const tokens = await app.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: `${origin}/v1/mcp`,
        }),
      });
      expect(tokens.status).toBe(200);
    };
    const list = async (person: Person, organizationId: string) => {
      const response = await app.request(`/v1/organizations/${organizationId}/mcp-connections`, {
        headers: { cookie: person.cookie },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Listed;
    };
    const names = (listed: Listed) => listed.connections.map((each) => each.clientName).sort();

    const owner = await signUp("Maja Berg");
    const admin = await signUp("Ada Admin");
    const member = await signUp("Ola Nordmann");
    const otherMember = await signUp("Per Hansen");
    const otherOwner = await signUp("Kari Other");
    const acme = await organization(owner, "Acme Robotics");
    const other = await organization(otherOwner, "Other Org");
    await invite(acme, owner, admin, "admin");
    await invite(acme, owner, member, "member");
    await invite(acme, owner, otherMember, "member");
    // The admin of Acme is only a member of the other organization.
    await invite(other, otherOwner, admin, "member");

    await connectAgent(member, acme, "Member agent");
    await connectAgent(otherMember, acme, "Other member agent");
    await connectAgent(otherOwner, other, "Other org agent");

    // Owner and admin see everyone's; a member sees only their own.
    expect(await list(owner, acme)).toMatchObject({ canManageAll: true });
    const adminView = await list(admin, acme);
    expect(adminView.canManageAll).toBe(true);
    expect(names(adminView)).toEqual(["Member agent", "Other member agent"]);
    const memberView = await list(member, acme);
    expect(memberView.canManageAll).toBe(false);
    expect(names(memberView)).toEqual(["Member agent"]);
    // In the other organization the admin is just a member.
    const elsewhere = await list(admin, other);
    expect(elsewhere.canManageAll).toBe(false);
    expect(elsewhere.connections).toEqual([]);

    const memberAgent = adminView.connections.find((each) => each.clientName === "Member agent")!;
    const at = (connectionId: string) =>
      `/v1/organizations/${acme}/mcp-connections/${connectionId}`;

    // Only the person who connected an agent changes what it can do, even for an admin.
    const changed = await app.request(at(memberAgent.id), {
      method: "PATCH",
      headers: browser(admin.cookie),
      body: JSON.stringify({
        access: {
          preset: "full",
          permissions: organizationAccessPresetPermissions("full"),
          workspaceScope: { kind: "all" },
        },
      }),
    });
    expect(changed.status).toBe(403);

    // Another member can't disconnect it; an admin can.
    const byMember = await app.request(at(memberAgent.id), {
      method: "DELETE",
      headers: browser(otherMember.cookie),
    });
    expect(byMember.status).toBe(403);
    const byAdmin = await app.request(at(memberAgent.id), {
      method: "DELETE",
      headers: browser(admin.cookie),
    });
    expect(byAdmin.status).toBe(204);
    expect(names(await list(owner, acme))).toEqual(["Other member agent"]);
    expect(names(await list(member, acme))).toEqual([]);
  }, 120_000);
});
