import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

/* End to end through the real app and PostgreSQL: an agent's "Anyone in
   <organization>" takes organization administration, so the organization's
   admins choose it like its owner (they don't hold the owner-only
   account:admin). A member can't, and an admin of one organization can't in
   another. */

const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("agents-organization-access-admin");
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

type Person = { cookie: string; email: string; subjectId: string };

describe("Anyone in the organization (real PostgreSQL)", () => {
  test("the owner and admins choose it; members and other organizations' admins don't", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "agents-organization-access-admin-secret-32b",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });

    const signUp = async (name: string): Promise<Person> => {
      const email = `agents-org-${crypto.randomUUID()}@example.test`;
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
      const access = (await (
        await app.request("/v1/access/me", { headers: { cookie: owner.cookie } })
      ).json()) as { accountGrants: Array<{ accountId: string; role?: string }> };
      const accountId = access.accountGrants.find((grant) => grant.role === "owner")!.accountId;
      const workspace = await createWorkspace(client.db, { accountId, name: `${name} team` });
      return { accountId, workspaceId: workspace.id };
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
    // A custom workspace role, as in the report: enough to make agents, no workspace admin.
    const joinWorkspace = async (accountId: string, workspaceId: string, person: Person) => {
      await shared.admin`
        insert into workspace_memberships (
          account_id, workspace_id, subject_id, subject_label, role, permissions
        ) values (
          ${accountId}, ${workspaceId}, ${person.subjectId}, ${person.email}, 'member',
          ${shared.admin.json(["workspace:read", "sessions:read", "sessions:create"])}
        ) on conflict do nothing`;
    };

    const owner = await signUp("Maja Berg");
    const admin = await signUp("Ada Admin");
    const member = await signUp("Ola Nordmann");
    const otherOwner = await signUp("Kari Other");
    const acme = await organization(owner, "Acme Robotics");
    const other = await organization(otherOwner, "Other Org");
    await invite(acme.accountId, owner, admin, "admin");
    await invite(acme.accountId, owner, member, "member");
    // The admin of Acme is only a member of the other organization.
    await invite(other.accountId, otherOwner, admin, "member");
    for (const person of [owner, admin, member]) {
      await joinWorkspace(acme.accountId, acme.workspaceId, person);
    }
    await joinWorkspace(other.accountId, other.workspaceId, admin);

    const send = async (person: Person, method: string, path: string, body: unknown) => {
      const response = await app.request(path, {
        method,
        headers: {
          cookie: person.cookie,
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as {
          agent?: { id: string; version: number; visibility: string };
        } | null,
      };
    };
    const create = (person: Person, workspaceId: string, visibility = "organization") =>
      send(person, "POST", `/v1/workspaces/${workspaceId}/agents`, {
        name: `Desk ${crypto.randomUUID().slice(0, 8)}`,
        visibility,
      });

    expect((await create(member, acme.workspaceId)).status).toBe(403);
    expect((await create(admin, other.workspaceId)).status).toBe(403);
    const byAdmin = await create(admin, acme.workspaceId);
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.body?.agent?.visibility).toBe("organization");
    expect((await create(owner, acme.workspaceId)).status).toBe(201);

    // Widening an existing shared agent takes the same: an admin can, a member can't.
    const widen = async (person: Person) => {
      const shared = (await create(person, acme.workspaceId, "workspace")).body!.agent!;
      return send(person, "PATCH", `/v1/workspaces/${acme.workspaceId}/agents/${shared.id}`, {
        expectedVersion: shared.version,
        visibility: "organization",
      });
    };
    expect((await widen(member)).status).toBe(403);
    const widened = await widen(admin);
    expect(widened.status).toBe(200);
    expect(widened.body?.agent?.visibility).toBe("organization");
  });
});
