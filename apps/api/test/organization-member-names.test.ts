/**
 * Every member of an organization sees who else is in it, by name only
 * (GET /v1/organizations/:organizationId/member-names, migration 1211).
 * Owners and admins keep the full directory. No email, role or status reaches
 * a member; product users, services, suspended and revoked memberships are
 * never listed; another organization's member gets nothing. Until the
 * deployment grants the list it reports itself unavailable. Real PostgreSQL,
 * as the application role.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

setDefaultTimeout(180_000);

type Person = {
  userId: string;
  subjectId: string;
  name: string;
  email: string;
  authSessionId: string;
};

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
const people = new Map<string, Person>();
const accounts: string[] = [];

let organizationId = "";
let otherOrganizationId = "";
const membershipIds = new Map<string, string>();

async function person(name: string): Promise<Person> {
  const userId = `member-names-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${name}, ${email}, true)`;
  await shared!.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  await shared!.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const created = { userId, subjectId: `user:${userId}`, name, email, authSessionId };
  people.set(userId, created);
  return created;
}

async function organization(name: string): Promise<string> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id::text as id`;
  accounts.push(account!.id);
  return account!.id;
}

async function join(
  accountId: string,
  subjectId: string,
  role: "owner" | "admin" | "member",
  status: "active" | "suspended" | "revoked" = "active",
): Promise<string> {
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
    returning id::text as id`;
  const [membership] = await shared!.admin<{ id: string }[]>`
    insert into organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id, revoked_at
    ) values (
      ${accountId}::uuid, ${subjectId}, ${role}, ${status}, ${workspace!.id}::uuid,
      ${status === "revoked" ? new Date() : null}
    ) returning id::text as id`;
  return membership!.id;
}

/** A request from this person in their browser. */
async function namesAs(who: Person, accountId = organizationId) {
  const response = await app!.request(`http://x/v1/organizations/${accountId}/member-names`, {
    headers: { cookie: `session=${who.userId}` },
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { status: response.status, body };
}

let owner: Person;
let admin: Person;
let member: Person;
let colleague: Person;
let suspended: Person;
let revoked: Person;
let outsider: Person;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-organization-member-names");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });

  owner = await person("Olivia Owner");
  admin = await person("Adam Admin");
  member = await person("Mia Member");
  colleague = await person("Carl Colleague");
  suspended = await person("Sue Suspended");
  revoked = await person("Rob Revoked");
  outsider = await person("Otto Outsider");

  organizationId = await organization("Names organization");
  otherOrganizationId = await organization("Other organization");
  membershipIds.set("owner", await join(organizationId, owner.subjectId, "owner"));
  membershipIds.set("admin", await join(organizationId, admin.subjectId, "admin"));
  membershipIds.set("member", await join(organizationId, member.subjectId, "member"));
  membershipIds.set("colleague", await join(organizationId, colleague.subjectId, "member"));
  await join(organizationId, suspended.subjectId, "member", "suspended");
  await join(organizationId, revoked.subjectId, "member", "revoked");
  // A product's user and a service are members too, but never people here.
  await join(organizationId, `external_user:${crypto.randomUUID()}`, "member");
  await join(organizationId, `service:${crypto.randomUUID()}`, "member");
  await join(otherOrganizationId, outsider.subjectId, "owner");

  app = new Hono();
  registerOrganizationMembershipRoutes(app, {
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      publicBaseUrl: "http://opengeni.test",
      betterAuthSecret: "organization-member-names-secret-at-least-32-bytes",
    }),
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const userId = /session=([^;]+)/u.exec(headers.get("cookie") ?? "")?.[1];
          const who = userId ? people.get(userId) : undefined;
          if (!who) return null;
          return {
            headers: new Headers(),
            response: {
              session: { id: who.authSessionId },
              user: { id: who.userId, email: who.email, name: who.name, emailVerified: true },
            },
          };
        },
      },
    } as never,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (shared) {
    for (const accountId of accounts) {
      await shared.admin`delete from managed_accounts where id = ${accountId}::uuid`.catch(
        () => undefined,
      );
    }
    for (const userId of people.keys()) {
      await shared.admin`delete from auth_users where id = ${userId}`.catch(() => undefined);
    }
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("organization member names", () => {
  test("until the deployment grants the list, it reports itself unavailable", async () => {
    expect(await namesAs(member)).toEqual({
      status: 200,
      body: { available: false, members: [] },
    });
  });

  test("a member sees every active colleague by name, and nothing else", async () => {
    await grantDeferredRuntimeAccess(shared!.admin);
    const { status, body } = await namesAs(member);
    expect(status).toBe(200);
    expect(body).toEqual({
      available: true,
      members: [
        { id: membershipIds.get("admin"), name: "Adam Admin", you: false },
        { id: membershipIds.get("colleague"), name: "Carl Colleague", you: false },
        { id: membershipIds.get("member"), name: "Mia Member", you: true },
        { id: membershipIds.get("owner"), name: "Olivia Owner", you: false },
      ],
    });
    // No email, role, status or subject reaches a member.
    const text = JSON.stringify(body);
    for (const each of [owner, admin, colleague, member]) {
      expect(text).not.toContain(each.email);
      expect(text).not.toContain(each.subjectId);
    }
    for (const field of ["email", "role", "status", "subjectId", "sharedWorkspaceAccess"]) {
      expect(text).not.toContain(`"${field}"`);
    }
    expect(text).not.toContain("external_user:");
    expect(text).not.toContain("service:");
    expect(text).not.toContain("Sue Suspended");
    expect(text).not.toContain("Rob Revoked");
  });

  test("owners and admins see the same names, and keep their full directory", async () => {
    for (const who of [owner, admin]) {
      const names = await namesAs(who);
      expect(names.status).toBe(200);
      expect((names.body.members as Array<{ name: string }>).map((entry) => entry.name)).toEqual([
        "Adam Admin",
        "Carl Colleague",
        "Mia Member",
        "Olivia Owner",
      ]);
      const directory = await app!.request(`http://x/v1/organizations/${organizationId}/members`, {
        headers: { cookie: `session=${who.userId}` },
      });
      expect(directory.status).toBe(200);
      const listed = (
        (await directory.json()) as {
          members: Array<{ email: string | null; role: string }>;
        }
      ).members;
      expect(listed.map((entry) => entry.email)).toContain(member.email);
      expect(listed.map((entry) => entry.role)).toContain("owner");
    }
    // A member still can't read the administration directory.
    const refused = await app!.request(`http://x/v1/organizations/${organizationId}/members`, {
      headers: { cookie: `session=${member.userId}` },
    });
    expect(refused.status).toBe(403);
  });

  test("no one outside the organization gets its names", async () => {
    // A member of another organization, and people who are no longer active.
    for (const who of [outsider, suspended, revoked]) {
      const refused = await namesAs(who);
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain("Mia Member");
    }
    // Each organization's own names stay inside it.
    const theirs = await namesAs(outsider, otherOrganizationId);
    expect(theirs).toEqual({
      status: 200,
      body: {
        available: true,
        members: [{ id: expect.any(String), name: "Otto Outsider", you: true }],
      },
    });
    // Without a signed-in person there is no list at all.
    const anonymous = await app!.request(
      `http://x/v1/organizations/${organizationId}/member-names`,
    );
    expect(anonymous.status).toBe(401);
  });
});
