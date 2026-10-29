import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
   the owner, manages the organization's own Knowledge, Skills, documents,
   company profile and session list; a member does not, and being an admin in
   one organization grants nothing in another where the same person is a
   member. Billing stays with the owner. */

const origin = "http://opengeni.test";
const skillMarkdown = `---
name: org-admin-fixture
description: An organization-wide procedure.
---
# Organization procedure
`;
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-admin-knowledge");
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
type Access = {
  accountGrants: Array<{ accountId: string; role?: string; permissions: string[] }>;
  workspaceGrants: Array<{ workspaceId: string; accountId: string; permissions: string[] }>;
};

describe("organization admins administer the organization", () => {
  test("owner and admin manage organization-wide resources; members and other organizations do not", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "organization-admin-knowledge-secret-32-bytes",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });

    const signUp = async (name: string): Promise<Person> => {
      const email = `org-admin-${crypto.randomUUID()}@example.test`;
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
    const access = async (person: Person): Promise<Access> =>
      (await (
        await app.request("/v1/access/me", { headers: { cookie: person.cookie } })
      ).json()) as Access;
    const organization = async (owner: Person, name: string) => {
      await createManagedOrganization(client.db, {
        subjectId: owner.subjectId,
        subjectLabel: owner.email,
        name,
        operationId: crypto.randomUUID(),
      });
      const grants = await access(owner);
      const accountId = grants.accountGrants.find((grant) => grant.role === "owner")!.accountId;
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
    const joinWorkspace = async (accountId: string, workspaceId: string, person: Person) => {
      await shared.admin`
        insert into workspace_memberships (
          account_id, workspace_id, subject_id, subject_label, role, permissions
        ) values (
          ${accountId}, ${workspaceId}, ${person.subjectId}, ${person.email}, 'member',
          ${shared.admin.json([
            "workspace:read",
            "sessions:read",
            "sessions:create",
            "documents:search",
            "documents:manage",
          ])}
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

    const adminAccess = await access(admin);
    // Admin authority is a role, not account:admin: billing and roles stay the owner's.
    expect(
      adminAccess.accountGrants.find((grant) => grant.accountId === acme.accountId),
    ).toMatchObject({ role: "admin" });
    expect(
      adminAccess.accountGrants.find((grant) => grant.accountId === acme.accountId)!.permissions,
    ).not.toContain("account:admin");

    const at = (workspaceId: string, path: string) => `/v1/workspaces/${workspaceId}${path}`;
    const status = async (person: Person, path: string, init: RequestInit = {}) =>
      (await app.request(path, { ...init, headers: browser(person.cookie) })).status;
    const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

    // The organization session list.
    const sessions = (accountId: string) => `/v1/organizations/${accountId}/sessions`;
    expect(await status(owner, sessions(acme.accountId))).toBe(200);
    expect(await status(admin, sessions(acme.accountId))).toBe(200);
    expect(await status(member, sessions(acme.accountId))).toBe(403);
    expect(await status(admin, sessions(other.accountId))).toBe(403);

    // The company profile's agent policy: the API and PostgreSQL both admit an admin.
    const policy = (workspaceId: string) => at(workspaceId, "/company-profile/agent-policy");
    const read = await app.request(policy(acme.workspaceId), {
      headers: browser(admin.cookie),
    });
    expect(read.status).toBe(200);
    const current = (await read.json()) as { version: number };
    const changed = await app.request(policy(acme.workspaceId), {
      method: "PATCH",
      headers: browser(admin.cookie),
      body: JSON.stringify({
        mode: "off",
        expectedVersion: current.version,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ mode: "off" });
    expect(await status(owner, policy(acme.workspaceId))).toBe(200);
    expect(await status(member, policy(acme.workspaceId))).toBe(403);
    expect(await status(admin, policy(other.workspaceId))).toBe(403);

    // Organization Knowledge.
    const knowledge = (person: Person, workspaceId: string) =>
      status(
        person,
        at(workspaceId, "/knowledge/entries"),
        post({
          operationId: crypto.randomUUID(),
          expectedVersion: 0,
          scope: "organization",
          entry: { title: "Org fact", kind: "fact", content: "Acme ships on Fridays." },
        }),
      );
    expect(await knowledge(admin, acme.workspaceId)).toBe(201);
    expect(await knowledge(owner, acme.workspaceId)).toBe(201);
    expect(await knowledge(member, acme.workspaceId)).toBe(403);
    expect(await knowledge(admin, other.workspaceId)).toBe(403);

    // Organization Skills (the preference registry's organization scope).
    const skill = (person: Person, workspaceId: string) => {
      const skillId = crypto.randomUUID();
      return status(
        person,
        at(workspaceId, "/skills/content/save"),
        post({
          skillId,
          operationId: crypto.randomUUID(),
          expectedRevisionId: null,
          expectedScopeVersion: 1,
          scope: "organization",
          stableKey: `org-admin-${skillId}`,
          files: [{ path: "SKILL.md", content: skillMarkdown }],
          reason: "Organization fixture",
        }),
      );
    };
    expect(await skill(member, acme.workspaceId)).toBe(403);
    expect(await skill(admin, other.workspaceId)).toBe(403);
    expect(await skill(admin, acme.workspaceId)).toBe(200);

    // Organization document backfills and their audit (PostgreSQL checks the stamp).
    const backfills = (workspaceId: string) =>
      at(workspaceId, "/document-default-collection-backfills");
    expect(await status(admin, backfills(acme.workspaceId))).toBe(200);
    expect(await status(owner, backfills(acme.workspaceId))).toBe(200);
    expect(await status(member, backfills(acme.workspaceId))).toBe(403);
    expect(await status(admin, backfills(other.workspaceId))).toBe(403);

    // An agent acting as the admin (a full-access personal key) does the same;
    // a key whose access leaves out organization administration does not.
    const personalKey = async (accountId: string, permissions: string[]) => {
      const created = await app.request(`/v1/organizations/${accountId}/personal-api-keys`, {
        method: "POST",
        headers: browser(admin.cookie),
        body: JSON.stringify({
          name: "Admin scripts",
          access: { preset: "custom", permissions, workspaceScope: { kind: "all" } },
        }),
      });
      expect(created.status).toBe(201);
      return ((await created.json()) as { token: string }).token;
    };
    const full = await personalKey(acme.accountId, organizationAccessPresetPermissions("full"));
    const limited = await personalKey(
      acme.accountId,
      organizationAccessPresetPermissions("full").filter(
        (permission) => permission !== "account:admin",
      ),
    );
    const asKey = async (token: string, path: string) =>
      (await app.request(path, { headers: { authorization: `Bearer ${token}` } })).status;
    expect(await asKey(full, sessions(acme.accountId))).toBe(200);
    expect(await asKey(limited, sessions(acme.accountId))).toBe(403);
  });
});
