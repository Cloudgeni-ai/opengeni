/**
 * A shared subscription a person connects in a shared workspace also reaches
 * that person's own Personal workspace, and nobody else's: through the real
 * app as signed-in people, on real PostgreSQL as the application role. A
 * regular organization member who administers a shared workspace connects
 * SuperGrok there; the model is then selectable in their Personal workspace
 * (model catalog and status), not in another member's, and taking it off the
 * access list ends that.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  upsertWorkspaceMemberAsWorkspaceManager,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "https://app.opengeni.test";
const key = Buffer.alloc(32, 41);
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: `personal-reach-${crypto.randomUUID()}`,
  sandboxBackend: "none",
  environmentsEncryptionKey: key.toString("base64"),
  publicBaseUrl: ORIGIN,
  supergrokSubscriptionEnabled: true,
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const sessions = new Map<string, { authSessionId: string; userId: string; email: string }>();
let providerSubject = "";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

/** xAI's device sign-in; any other upstream read is unavailable. */
const xaiFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/oauth2/device/code"))
    return Response.json({
      device_code: `device-${crypto.randomUUID()}`,
      user_code: "XAI-1234",
      verification_uri: "https://accounts.x.ai/device",
      verification_uri_complete: "https://accounts.x.ai/device?code=XAI-1234",
      expires_in: 600,
      interval: 1,
    });
  if (url.endsWith("/oauth2/token"))
    return Response.json({
      access_token: jwt({
        principal_type: "User",
        principal_id: providerSubject,
        exp: Math.floor(Date.now() / 1_000) + 3_600,
      }),
      refresh_token: `refresh-${providerSubject}`,
      id_token: jwt({ sub: providerSubject, email: "grok@example.com", email_verified: true }),
      expires_in: 3600,
    });
  return new Response("unavailable", { status: 503 });
}) as typeof fetch;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-subscription-connector-personal-reach");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function app() {
  const noop = async () => undefined;
  return createApp({
    db: client!.db,
    bus: new MemoryEventBus(),
    settings,
    workflowClient: {
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "personal-reach-state",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    xaiFetch,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const session = sessions.get(headers.get("cookie") ?? "");
          if (!session) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: session.authSessionId },
              user: { id: session.userId, email: session.email, name: "Person" },
            },
          };
        },
      },
    } as never,
  } as unknown as ApiRouteDeps);
}

type Person = { subjectId: string; cookie: string; personalWorkspaceId: string };

/** A signed-in person; the first one bootstraps their own organization. */
async function signedIn(name: string, organizationId?: string, inviter?: string) {
  const userId = `personal-reach-${name.toLowerCase()}-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const cookie = `session=${authSessionId}`;
  await shared!.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${name}, ${email}, true)`;
  await shared!.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId,
    email,
    name,
    emailVerified: true,
  });
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision})`;
  sessions.set(cookie, { authSessionId, userId, email });
  if (organizationId && inviter) {
    const invitation = await createOrganizationInvitation(client!.db, {
      organizationId,
      actorSubjectId: inviter,
      operationId: crypto.randomUUID(),
      targetSubjectId: subjectId,
      targetEmail: email,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await acceptOrganizationInvitation(client!.db, {
      organizationId,
      actorSubjectId: subjectId,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
  }
  const [membership] = await shared!.admin<{ account_id: string; personal: string }[]>`
    select account_id::text as account_id, personal_workspace_id::text as personal
    from organization_memberships
    where subject_id = ${subjectId} and status = 'active'
      ${organizationId ? shared!.admin`and account_id = ${organizationId}::uuid` : shared!.admin``}`;
  return {
    accountId: membership!.account_id,
    person: { subjectId, cookie, personalWorkspaceId: membership!.personal } satisfies Person,
  };
}

function browser(person: Person, body?: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: person.cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function connectSuperGrok(person: Person, workspaceId: string): Promise<string> {
  providerSubject = `xai-${crypto.randomUUID()}`;
  const api = app();
  const start = await api.request(
    `/v1/workspaces/${workspaceId}/supergrok/connect/start`,
    browser(person, { scope: "workspace" }),
  );
  expect({ status: start.status, body: start.status === 200 ? null : await start.text() }).toEqual({
    status: 200,
    body: null,
  });
  const { state } = (await start.json()) as { state: string };
  const poll = await api.request(
    `/v1/workspaces/${workspaceId}/supergrok/connect/poll`,
    browser(person, { state }),
  );
  const connected = (await poll.json()) as { status: string; accountId: string };
  expect({ status: poll.status, connected: connected.status }).toEqual({
    status: 200,
    connected: "connected",
  });
  return connected.accountId;
}

/** The selectable SuperGrok models one person sees in one workspace. */
async function selectableGrok(person: Person, workspaceId: string): Promise<string[]> {
  const response = await app().request(
    `/v1/workspaces/${workspaceId}/model-catalog`,
    browser(person),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    models: Array<{ id: string; availability: { selectable: boolean } }>;
  };
  return body.models
    .filter((model) => model.id.startsWith("supergrok/") && model.availability.selectable)
    .map((model) => model.id);
}

async function status(person: Person, workspaceId: string) {
  const response = await app().request(
    `/v1/workspaces/${workspaceId}/supergrok/status`,
    browser(person),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { connected: boolean; accountCount: number };
}

async function rolePermissions(role: "admin" | "member") {
  const [row] = await shared!.admin<Array<{ permissions: string[] }>>`
    select opengeni_private.workspace_member_role_permissions(${role}) as permissions`;
  return row!.permissions;
}

describe.skipIf(!realDb)(
  "a workspace subscription reaches its connecting person's Personal workspace",
  () => {
    test("a regular member who administers a shared workspace connects there: their Personal workspace gets it, no one else's, until they remove it", async () => {
      const { accountId, person: owner } = await signedIn("Owner");
      const created = await app().request(
        "/v1/workspaces",
        browser(owner, { accountId, name: "Team" }),
      );
      expect(created.status).toBe(201);
      const teamId = ((await created.json()) as { id: string }).id;
      const { person: alice } = await signedIn("Alice", accountId, owner.subjectId);
      const { person: bob } = await signedIn("Bob", accountId, owner.subjectId);
      for (const [person, role, label] of [
        [alice, "admin", "Alice"],
        [bob, "member", "Bob"],
      ] as const)
        await upsertWorkspaceMemberAsWorkspaceManager(client!.db, {
          accountId,
          workspaceId: teamId,
          actorSubjectId: owner.subjectId,
          targetSubjectId: person.subjectId,
          mode: "add",
          subjectLabel: label,
          role,
          permissions: (await rolePermissions(role)) as never,
        });

      // Before: nobody's Personal workspace offers SuperGrok.
      expect(await selectableGrok(alice, alice.personalWorkspaceId)).toEqual([]);

      const connectionId = await connectSuperGrok(alice, teamId);

      // The team workspace and Alice's own Personal workspace have it.
      const inTeam = await selectableGrok(alice, teamId);
      expect(inTeam.length).toBeGreaterThan(0);
      expect(await selectableGrok(alice, alice.personalWorkspaceId)).toEqual(inTeam);
      expect(await status(alice, alice.personalWorkspaceId)).toMatchObject({
        connected: true,
        accountCount: 1,
      });
      // Bob, in the same team workspace, has it there but not in his Personal workspace,
      // nor does the organization owner.
      expect(await selectableGrok(bob, teamId)).toEqual(inTeam);
      expect(await selectableGrok(bob, bob.personalWorkspaceId)).toEqual([]);
      expect(await status(bob, bob.personalWorkspaceId)).toMatchObject({ connected: false });
      expect(await selectableGrok(owner, owner.personalWorkspaceId)).toEqual([]);

      // The access list shows it as Alice's, and as Alice's to the owner.
      const accessPath = `/v1/workspaces/${teamId}/model-connections/supergrok/${connectionId}/access`;
      const read = await app().request(accessPath, browser(alice));
      expect(read.status).toBe(200);
      const access = (await read.json()) as {
        policy: Record<string, unknown> & { connectorPersonalWorkspace?: boolean };
        connectorPersonalWorkspaceOwner?: { yours: boolean; name: string | null };
      };
      expect(access.policy.connectorPersonalWorkspace).toBe(true);
      expect(access.policy.allowPersonalWorkspaces).toBe(false);
      expect(access.connectorPersonalWorkspaceOwner).toEqual({ yours: true, name: null });
      // It stays the team workspace's own account.
      const [row] = await shared!.admin<{ managed_by: string | null }[]>`
      select managed_by_workspace_id::text as managed_by from subscription_connections
      where id = ${connectionId}::uuid`;
      expect(row?.managed_by).toBe(teamId);

      // Alice takes her Personal workspace off the list; the team workspace keeps it.
      const removed = await app().request(accessPath, {
        ...browser(alice, { ...access.policy, connectorPersonalWorkspace: false }),
        method: "PUT",
      });
      expect(removed.status).toBe(200);
      expect(
        ((await removed.json()) as { connectorPersonalWorkspace?: boolean })
          .connectorPersonalWorkspace,
      ).toBeUndefined();
      const reread = (await (await app().request(accessPath, browser(alice))).json()) as {
        policy: { connectorPersonalWorkspace?: boolean };
        connectorPersonalWorkspaceOwner?: unknown;
      };
      expect(reread.policy.connectorPersonalWorkspace).toBeUndefined();
      expect(reread.connectorPersonalWorkspaceOwner).toBeUndefined();
      expect(await selectableGrok(alice, alice.personalWorkspaceId)).toEqual([]);
      expect(await status(alice, alice.personalWorkspaceId)).toMatchObject({ connected: false });
      expect(await selectableGrok(alice, teamId)).toEqual(inTeam);
    });
  },
);
