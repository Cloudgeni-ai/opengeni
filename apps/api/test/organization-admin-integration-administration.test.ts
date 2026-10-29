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
   the owner, manages the organization's webhooks and credential provider, sees
   and revokes everyone's personal API keys and connected agents, and manages
   member-level organization API keys and service accounts; keys and service
   accounts that manage people, keys or billing stay the owner's. A member does
   none of this, and being an admin in one organization grants nothing in
   another where the same person is a member. */

const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-admin-integrations");
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

describe("organization admins manage organization integrations", () => {
  test("owner and admin manage them; members and other organizations do not", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "organization-admin-integrations-secret-32-bytes",
        publicBaseUrl: origin,
        environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
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
          ${shared.admin.json(["workspace:read", "sessions:read"])}
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

    const send = async (person: Person, path: string, method = "GET", body?: unknown) =>
      await app.request(path, {
        method,
        headers: browser(person.cookie),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const org = (accountId: string, path: string) => `/v1/organizations/${accountId}${path}`;

    // The organization credential provider and webhooks.
    const provider = (person: Person, accountId: string) =>
      send(person, org(accountId, "/credential-provider"), "PUT", {
        url: "https://provider.example/credentials",
        workspaceFilter: null,
      });
    expect((await provider(member, acme.accountId)).status).toBe(403);
    expect((await provider(admin, other.accountId)).status).toBe(403);
    expect((await provider(admin, acme.accountId)).status).toBe(201);
    expect((await send(admin, org(acme.accountId, "/credential-provider"))).status).toBe(200);
    expect(
      (await send(admin, org(acme.accountId, "/credential-provider/rotate-secret"), "POST")).status,
    ).toBe(200);
    const webhook = (person: Person, accountId: string) =>
      send(person, org(accountId, "/webhooks"), "POST", {
        url: "https://hooks.example/opengeni",
        eventTypes: ["turn.completed"],
        workspaceFilter: null,
      });
    expect((await webhook(member, acme.accountId)).status).toBe(403);
    expect((await webhook(admin, other.accountId)).status).toBe(403);
    expect((await webhook(admin, acme.accountId)).status).toBe(201);
    expect((await send(member, org(acme.accountId, "/webhooks"))).status).toBe(403);
    expect((await send(admin, org(acme.accountId, "/webhooks"))).status).toBe(200);

    // Everyone's personal API keys and connected agents.
    const personalKey = async (person: Person, accountId: string) => {
      const response = await send(person, org(accountId, "/personal-api-keys"), "POST", {
        name: `Scripts ${crypto.randomUUID().slice(0, 8)}`,
        access: {
          preset: "read_only",
          permissions: organizationAccessPresetPermissions("read_only"),
          workspaceScope: { kind: "all" },
        },
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { apiKey: { id: string } }).apiKey.id;
    };
    const keys = async (person: Person, accountId: string) =>
      (await (await send(person, org(accountId, "/personal-api-keys"))).json()) as {
        apiKeys: Array<{ id: string }>;
        canManageAll: boolean;
      };
    const agents = async (person: Person, accountId: string) =>
      (await (await send(person, org(accountId, "/mcp-connections"))).json()) as {
        canManageAll: boolean;
      };
    const memberKey = await personalKey(member, acme.accountId);
    const ownerKey = await personalKey(owner, acme.accountId);
    const otherKey = await personalKey(otherOwner, other.accountId);
    expect((await keys(member, acme.accountId)).canManageAll).toBe(false);
    expect((await agents(member, acme.accountId)).canManageAll).toBe(false);
    const seen = await keys(admin, acme.accountId);
    expect(seen.canManageAll).toBe(true);
    expect(seen.apiKeys.map((key) => key.id)).toEqual(
      expect.arrayContaining([memberKey, ownerKey]),
    );
    expect((await agents(admin, acme.accountId)).canManageAll).toBe(true);
    expect((await keys(admin, other.accountId)).canManageAll).toBe(false);
    expect((await agents(admin, other.accountId)).canManageAll).toBe(false);
    expect(
      (await send(admin, org(other.accountId, `/personal-api-keys/${otherKey}`), "DELETE")).status,
    ).toBe(404);
    expect(
      (await send(member, org(acme.accountId, `/personal-api-keys/${ownerKey}`), "DELETE")).status,
    ).toBe(404);
    expect(
      (await send(admin, org(acme.accountId, `/personal-api-keys/${memberKey}`), "DELETE")).status,
    ).toBe(204);

    // Organization API keys and service accounts: an admin manages the
    // member-level ones; owner-level keys and service accounts stay the owner's.
    type CreatedKey = {
      apiKey: { id: string; serviceAccount?: { id: string; role: string } | null };
    };
    const policy = (preset: "full" | "read_only") => ({
      preset,
      permissions: organizationAccessPresetPermissions(preset),
      workspaceScope: { kind: "all" },
    });
    const orgKey = (person: Person, accountId: string, body: Record<string, unknown>) =>
      send(person, org(accountId, "/api-keys"), "POST", {
        name: `Automation ${crypto.randomUUID().slice(0, 8)}`,
        ...body,
      });
    expect((await send(member, org(acme.accountId, "/api-keys"))).status).toBe(403);
    expect((await send(admin, org(other.accountId, "/api-keys"))).status).toBe(403);
    expect((await send(admin, org(acme.accountId, "/api-keys"))).status).toBe(200);
    expect((await orgKey(member, acme.accountId, { policy: policy("read_only") })).status).toBe(
      403,
    );
    expect((await orgKey(admin, other.accountId, { policy: policy("read_only") })).status).toBe(
      403,
    );
    expect((await orgKey(admin, acme.accountId, { policy: policy("full") })).status).toBe(403);
    expect((await orgKey(admin, acme.accountId, { access: "developer_setup" })).status).toBe(403);
    expect((await orgKey(admin, acme.accountId, {})).status).toBe(403);
    const readKeyResponse = await orgKey(admin, acme.accountId, { policy: policy("read_only") });
    expect(readKeyResponse.status).toBe(201);
    const readKey = ((await readKeyResponse.json()) as CreatedKey).apiKey;
    expect(readKey.serviceAccount?.role).toBe("member");
    const fullKeyResponse = await orgKey(owner, acme.accountId, { policy: policy("full") });
    expect(fullKeyResponse.status).toBe(201);
    const fullKey = ((await fullKeyResponse.json()) as CreatedKey).apiKey;
    expect(fullKey.serviceAccount?.role).toBe("admin");
    expect(
      (
        await orgKey(admin, acme.accountId, {
          policy: policy("read_only"),
          serviceAccountId: fullKey.serviceAccount!.id,
        })
      ).status,
    ).toBe(403);
    const keyPath = (id: string) => org(acme.accountId, `/api-keys/${id}`);
    expect((await send(admin, keyPath(fullKey.id), "PATCH", { name: "Renamed" })).status).toBe(403);
    expect((await send(admin, keyPath(fullKey.id), "DELETE")).status).toBe(403);
    expect(
      (await send(admin, keyPath(readKey.id), "PATCH", { policy: policy("full") })).status,
    ).toBe(403);
    expect((await send(admin, keyPath(readKey.id), "PATCH", { name: "Renamed" })).status).toBe(200);
    expect((await send(member, keyPath(readKey.id), "DELETE")).status).toBe(403);
    expect((await send(admin, keyPath(readKey.id), "DELETE")).status).toBe(200);

    const accounts = org(acme.accountId, "/service-accounts");
    expect((await send(member, accounts)).status).toBe(403);
    expect((await send(admin, org(other.accountId, "/service-accounts"))).status).toBe(403);
    expect((await send(admin, accounts)).status).toBe(200);
    expect(
      (await send(admin, accounts, "POST", { name: "Deploy bot", role: "admin" })).status,
    ).toBe(403);
    const created = await send(admin, accounts, "POST", { name: "Deploy bot", role: "member" });
    expect(created.status).toBe(201);
    const memberAccount = ((await created.json()) as { id: string }).id;
    const ownerAccount = fullKey.serviceAccount!.id;
    expect(
      (await send(admin, `${accounts}/${ownerAccount}`, "PATCH", { name: "Renamed" })).status,
    ).toBe(403);
    expect((await send(admin, `${accounts}/${ownerAccount}`, "DELETE")).status).toBe(403);
    expect(
      (await send(admin, `${accounts}/${memberAccount}`, "PATCH", { role: "admin" })).status,
    ).toBe(403);
    expect(
      (await send(admin, `${accounts}/${memberAccount}`, "PATCH", { name: "Release bot" })).status,
    ).toBe(200);
    expect((await send(admin, `${accounts}/${memberAccount}`, "DELETE")).status).toBe(204);
    // The owner still manages everything.
    expect((await send(owner, keyPath(fullKey.id), "DELETE")).status).toBe(200);
    expect((await send(owner, `${accounts}/${ownerAccount}`, "DELETE")).status).toBe(204);
  });
});
