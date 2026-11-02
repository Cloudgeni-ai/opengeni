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

/* End to end through the real app and PostgreSQL: an organization admin, like
   the owner, manages the organization's vaults, Sandbox Environments and
   machines; a member does not, and being an admin in one organization grants
   nothing in another where the same person is a member. */

const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-admin-resources");
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

describe("organization admins manage organization vaults, environments and machines", () => {
  test("owner and admin manage them; members and other organizations do not", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "organization-admin-resources-secret-32-bytes",
        publicBaseUrl: origin,
        environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
        onePasswordFakeTokens: true,
        sandboxSelfhostedEnabled: true,
        selfhostedRelayUrl: "wss://relay.example",
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
            "secrets:list",
            "secrets:write",
            "connections:read",
            "connections:write",
            "rigs:use",
            "rigs:manage",
            "enrollments:read",
            "enrollments:manage",
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

    const at = (workspaceId: string, path: string) => `/v1/workspaces/${workspaceId}${path}`;
    const send = async (person: Person, path: string, method: string, body?: unknown) =>
      (
        await app.request(path, {
          method,
          headers: browser(person.cookie),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      ).status;

    // Organization vaults.
    const vault = (person: Person, workspaceId: string) =>
      send(person, at(workspaceId, "/vaults"), "POST", {
        name: `Org vault ${crypto.randomUUID().slice(0, 8)}`,
        ownerKind: "organization",
      });
    expect(await vault(member, acme.workspaceId)).toBe(403);
    expect(await vault(admin, other.workspaceId)).toBe(403);
    expect(await vault(admin, acme.workspaceId)).toBe(201);
    expect(await vault(owner, acme.workspaceId)).toBe(201);
    // Every organization vault, wherever it works: the people who manage them.
    const everyVault = (person: Person, workspaceId: string) =>
      send(person, at(workspaceId, "/organization-vaults"), "GET");
    expect(await everyVault(member, acme.workspaceId)).toBe(403);
    expect(await everyVault(admin, other.workspaceId)).toBe(403);
    expect(await everyVault(admin, acme.workspaceId)).toBe(200);
    expect(await everyVault(owner, acme.workspaceId)).toBe(200);

    // Organization-owned 1Password connections.
    const onePassword = (person: Person, workspaceId: string) =>
      send(person, at(workspaceId, "/connections/1password/install"), "POST", {
        token: "ops_fake_healthy",
        ownership: "organization",
        label: `Org 1Password ${crypto.randomUUID().slice(0, 8)}`,
      });
    expect(await onePassword(member, acme.workspaceId)).toBe(403);
    expect(await onePassword(admin, other.workspaceId)).toBe(403);
    expect(await onePassword(admin, acme.workspaceId)).toBe(201);

    // Organization Sandbox Environments.
    const rig = (person: Person, workspaceId: string) =>
      send(person, at(workspaceId, "/rigs"), "POST", {
        scope: "organization",
        name: `Org environment ${crypto.randomUUID().slice(0, 8)}`,
      });
    expect(await rig(member, acme.workspaceId)).toBe(403);
    expect(await rig(admin, other.workspaceId)).toBe(403);
    expect(await rig(admin, acme.workspaceId)).toBe(201);

    // Organization machines: an admin changes one (revokes it); a member who
    // manages the workspace's machines does not.
    const organizationMachine = async (accountId: string, workspaceId: string, by: Person) =>
      await shared.admin.begin(async (tx) => {
        await tx`select
          set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${workspaceId}, true),
          set_config('opengeni.subject_id', ${by.subjectId}, true),
          set_config('opengeni.initiating_human_subject_id', ${by.subjectId}, true)`;
        const [row] = await tx<{ enrollmentId: string }[]>`
          select enrollment_id as "enrollmentId"
          from finalize_scoped_enrollment(
            ${accountId}::uuid, ${workspaceId}::uuid, 'organization',
            ${`ed25519:${crypto.randomUUID()}`}, true, true, 'linux', 'x86_64',
            'organization machine', true
          )`;
        return row!.enrollmentId;
      });
    const acmeMachine = await organizationMachine(acme.accountId, acme.workspaceId, owner);
    const otherMachine = await organizationMachine(other.accountId, other.workspaceId, otherOwner);
    const revoke = (person: Person, workspaceId: string, enrollmentId: string) =>
      send(person, at(workspaceId, `/enrollments/${enrollmentId}/revoke`), "POST", {});

    // Where an organization machine or Sandbox Environment works follows the
    // same rule: the owner or an admin of that organization picks it.
    const everywhere = { allowedWorkspaceIds: null, allowPersonalWorkspaces: true };
    const machineReach = (person: Person, workspaceId: string, enrollmentId: string) =>
      send(person, at(workspaceId, `/machines/${enrollmentId}/reach`), "PUT", everywhere);
    expect(await machineReach(member, acme.workspaceId, acmeMachine)).toBe(403);
    expect(await machineReach(admin, other.workspaceId, otherMachine)).toBe(403);
    expect(await machineReach(admin, acme.workspaceId, acmeMachine)).toBe(200);
    const createdRig = await app.request(at(acme.workspaceId, "/rigs"), {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({
        scope: "organization",
        name: `Org environment ${crypto.randomUUID().slice(0, 8)}`,
      }),
    });
    expect(createdRig.status).toBe(201);
    const acmeRig = ((await createdRig.json()) as { id: string }).id;
    const rigReach = (person: Person, rigId: string) =>
      send(person, at(acme.workspaceId, `/rigs/${rigId}/reach`), "PUT", everywhere);
    expect(await rigReach(member, acmeRig)).toBe(403);
    expect(await rigReach(admin, acmeRig)).toBe(200);

    // The owners and admins who pick where each works list every one,
    // wherever it works (Organization settings > Shared).
    for (const kind of ["machines", "rigs"] as const) {
      const listEverywhere = (person: Person, workspaceId: string) =>
        send(person, at(workspaceId, `/organization-${kind}`), "GET");
      expect(await listEverywhere(member, acme.workspaceId)).toBe(403);
      expect(await listEverywhere(admin, other.workspaceId)).toBe(403);
      expect(await listEverywhere(admin, acme.workspaceId)).toBe(200);
      expect(await listEverywhere(owner, acme.workspaceId)).toBe(200);
    }

    expect(await revoke(member, acme.workspaceId, acmeMachine)).toBe(403);
    expect(await revoke(admin, other.workspaceId, otherMachine)).toBe(403);
    expect(await revoke(admin, acme.workspaceId, acmeMachine)).toBe(200);
  });
});
