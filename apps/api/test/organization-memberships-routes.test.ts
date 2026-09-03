import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps, ManagedEmailDeliveryResult, ManagedEmailMessage } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimOrganizationUserSetupDelivery,
  completeSelfServiceOrganizationSetup,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getSelfServiceOrganizationOnboardingState,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerManagedOnboardingRoutes } from "../src/routes/managed-onboarding";
import { registerCodexRoutes } from "../src/routes/codex";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let userId = "";
let subjectId = "";
let accountId = "";
let authSessionId = "";
const managedEmailMessages: ManagedEmailMessage[] = [];
let managedEmailOutcome: ManagedEmailDeliveryResult = {
  status: "sent",
  providerMessageId: "test-message",
};
let managedEmailSendHook: ((message: ManagedEmailMessage) => Promise<void>) | null = null;
const managedEmailTransport = {
  sender: "OpenGeni <auth@mail.opengeni.ai>",
  idempotency: {
    scope: "test-provider-v1:organization-memberships-routes",
    retentionSeconds: 86_400,
  },
  send: async (message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> => {
    managedEmailMessages.push(structuredClone(message));
    await managedEmailSendHook?.(message);
    return managedEmailOutcome;
  },
};

const managedSettings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: "http://opengeni.test",
  betterAuthSecret: "organization-membership-route-secret-at-least-32-bytes",
  organizationUserSetupEmailTokenTransport: "query",
  organizationUserSetupQueryEdgeSanitizationConfirmed: true,
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-organization-memberships");
  if (!shared) return;

  client = createDb(shared.appUrl);
  userId = `organization-membership-${crypto.randomUUID()}`;
  subjectId = `user:${userId}`;
  authSessionId = `session-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;

  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Organization member', ${email}, true)`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email,
    name: "Organization member",
    emailVerified: true,
  });
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at,
      identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;

  app = new Hono();
  registerOrganizationMembershipRoutes(app, {
    db: client.db,
    settings: managedSettings,
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: authSessionId },
            user: { id: userId, email, name: "Organization member", emailVerified: true },
          },
        }),
      },
    } as never,
    managedEmailTransport,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (shared && accountId) {
    await shared.admin`delete from managed_accounts where id = ${accountId}`.catch(() => undefined);
  }
  if (shared && userId) {
    await shared.admin`delete from auth_users where id = ${userId}`.catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("organization membership routes", () => {
  test("lets only the canonical single-user local browser administer its organization", async () => {
    if (!client) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "opengeni:local",
      accountExternalId: "default",
      accountName: "Local",
      workspaceExternalSource: "opengeni:local",
      workspaceExternalId: "default",
      workspaceName: "Local",
      subjectId: "dev",
      subjectLabel: "Local dev",
    });
    if (!access.defaultAccountId) throw new Error("local account was not returned");
    const local = new Hono();
    registerOrganizationMembershipRoutes(local, {
      db: client.db,
      settings: testSettings({ productAccessMode: "local" }),
      managedAuth: null,
    } as ApiRouteDeps);
    registerCodexRoutes(local, {
      db: client.db,
      settings: testSettings({ productAccessMode: "local" }),
      managedAuth: null,
      githubStateSecret: "local-organization-codex-test-secret",
    } as ApiRouteDeps);

    const response = await local.request(
      `http://x/v1/organizations/${access.defaultAccountId}/overview`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      organization: { id: access.defaultAccountId },
    });
    const codex = await local.request(
      `http://x/v1/organizations/${access.defaultAccountId}/codex/accounts`,
    );
    expect(codex.status).toBe(200);
    expect(await codex.json()).toMatchObject({ accounts: [] });

    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            device_auth_id: "local-device-auth",
            user_code: "LOCAL-1234",
            interval: "5",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      const start = await local.request(
        `http://opengeni-api:8000/v1/organizations/${access.defaultAccountId}/codex/connect/start`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "homeserver",
            origin: "http://homeserver:30079",
            "sec-fetch-site": "same-origin",
            "x-forwarded-host": "homeserver",
            "x-forwarded-proto": "http",
          },
          body: "{}",
        },
      );
      expect(start.status).toBe(200);
      expect(await start.json()).toMatchObject({ userCode: "LOCAL-1234" });

      const crossOrigin = await local.request(
        `http://opengeni-api:8000/v1/organizations/${access.defaultAccountId}/codex/connect/start`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "homeserver",
            origin: "http://attacker.example:30079",
            "sec-fetch-site": "same-origin",
            "x-forwarded-host": "homeserver",
            "x-forwarded-proto": "http",
          },
          body: "{}",
        },
      );
      expect(crossOrigin.status).toBe(403);
    } finally {
      globalThis.fetch = realFetch;
    }

    const delegated = await local.request(
      `http://x/v1/organizations/${access.defaultAccountId}/overview`,
      { headers: { authorization: "Bearer not-a-valid-local-token" } },
    );
    expect(delegated.status).toBe(401);
  });

  test("denies non-managed and delegated principals before database access", async () => {
    const configured = new Hono();
    registerOrganizationMembershipRoutes(configured, {
      db: {} as never,
      settings: testSettings({ productAccessMode: "configured" }),
      managedAuth: null,
    } as ApiRouteDeps);
    expect((await configured.request("http://x/v1/organization-memberships")).status).toBe(401);
    expect(
      (
        await configured.request("http://x/v1/organizations/additional", {
          method: "POST",
        })
      ).status,
    ).toBe(401);

    const delegated = new Hono();
    registerOrganizationMembershipRoutes(delegated, {
      db: {} as never,
      settings: managedSettings,
      managedAuth: {} as never,
    } as ApiRouteDeps);
    expect(
      (
        await delegated.request("http://x/v1/organization-memberships", {
          headers: {
            authorization: "Bearer delegated",
            cookie: "session=present",
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await delegated.request("http://x/v1/organizations/additional", {
          method: "POST",
          headers: {
            authorization: "Bearer delegated",
            cookie: "session=present",
          },
        })
      ).status,
    ).toBe(401);
  });

  test("creates an organization with only its Personal workspace and replays idempotently", async () => {
    if (!shared || !client) return;
    const setupUserId = `organization-setup-${crypto.randomUUID()}`;
    const setupSubjectId = `user:${setupUserId}`;
    const setupSessionId = `session-${crypto.randomUUID()}`;
    const setupEmail = `${setupUserId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${setupUserId}, 'Organization setup owner', ${setupEmail}, true)`;
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id)
      values (${crypto.randomUUID()}, ${setupUserId}, 'credential', ${setupUserId})`;
    const setupIdentity = await synchronizeCanonicalHumanLoginBindings(client.db, setupUserId);
    await shared.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at,
        identity_id, identity_revision, auth_revision
      ) values (
        ${setupSessionId}, ${setupUserId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${setupIdentity.identityId}, ${setupIdentity.identityRevision}, ${setupIdentity.authRevision}
      )`;
    const setupApp = new Hono();
    registerOrganizationMembershipRoutes(setupApp, {
      db: client.db,
      settings: managedSettings,
      managedAuth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: { id: setupSessionId },
              user: {
                id: setupUserId,
                email: setupEmail,
                name: "Organization setup owner",
                emailVerified: true,
              },
            },
          }),
        },
      } as never,
      managedEmailTransport,
    } as ApiRouteDeps);
    const operationId = crypto.randomUUID();
    let createdOrganizationId = "";
    try {
      const request = {
        name: "Product team",
        operationId,
      };
      const [response, concurrentRetry] = await Promise.all([
        setupApp.request("http://x/v1/organizations", {
          method: "POST",
          headers: {
            cookie: "session=present",
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        }),
        setupApp.request("http://x/v1/organizations", {
          method: "POST",
          headers: {
            cookie: "session=present",
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        }),
      ]);
      expect(response.status).toBe(201);
      expect(concurrentRetry.status).toBe(201);
      const created = (await response.json()) as {
        organization: { id: string; name: string };
        workspaceId: string;
      };
      expect(await concurrentRetry.json()).toEqual(created);
      createdOrganizationId = created.organization.id;
      expect(created).toMatchObject({
        organization: { name: "Product team" },
      });

      const replay = await setupApp.request("http://x/v1/organizations", {
        method: "POST",
        headers: {
          cookie: "session=present",
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(created);

      const [authority] = await shared.admin<
        Array<{ memberships: number; sharedWorkspaces: number; personalWorkspaces: number }>
      >`
        select
          (select count(*)::int from organization_memberships
            where account_id = ${createdOrganizationId}
              and subject_id = ${setupSubjectId}
              and role = 'owner'
              and status = 'active') as memberships,
          (select count(*)::int from workspace_memberships
            where account_id = ${createdOrganizationId}
              and workspace_id = ${created.workspaceId}
              and subject_id = ${setupSubjectId}
              and role = 'owner') as "sharedWorkspaces",
          (select count(*)::int from workspaces
            where account_id = ${createdOrganizationId}
              and external_source = 'opengeni:organization-membership') as "personalWorkspaces"`;
      expect(authority).toEqual({ memberships: 1, sharedWorkspaces: 0, personalWorkspaces: 1 });
    } finally {
      if (createdOrganizationId) {
        await shared.admin`
          delete from self_service_organization_setup_receipts
          where account_id = ${createdOrganizationId}`;
        await shared.admin`delete from managed_accounts where id = ${createdOrganizationId}`;
      }
    }
  });

  test("supports organization invite, subject-bound acceptance, listing and suspension", async () => {
    if (!shared || !client || !app) return;
    const ownerMembershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const ownerMembershipBody = (await ownerMembershipResponse.json()) as {
      memberships: Array<{ organizationId: string }>;
    };
    accountId = ownerMembershipBody.memberships[0]!.organizationId;

    const targetUserId = `organization-invite-target-${crypto.randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const targetSessionId = `session-${crypto.randomUUID()}`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${targetUserId}, 'Invitation target', ${targetEmail}, true)`;
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id)
      values (${crypto.randomUUID()}, ${targetUserId}, 'credential', ${targetUserId})`;
    const targetIdentity = await synchronizeCanonicalHumanLoginBindings(client.db, targetUserId);
    await shared.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at,
        identity_id, identity_revision, auth_revision
      ) values (
        ${targetSessionId}, ${targetUserId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${targetIdentity.identityId}, ${targetIdentity.identityRevision}, ${targetIdentity.authRevision}
      )`;
    const targetApp = new Hono();
    registerOrganizationMembershipRoutes(targetApp, {
      db: client.db,
      settings: managedSettings,
      managedAuth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: { id: targetSessionId },
              user: {
                id: targetUserId,
                email: targetEmail,
                name: "Invitation target",
                emailVerified: true,
              },
            },
          }),
        },
      } as never,
      managedEmailTransport,
    } as ApiRouteDeps);

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const inviteResponse = await app.request(`http://x/v1/organizations/${accountId}/invitations`, {
      method: "POST",
      headers: {
        cookie: "session=present",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: targetEmail,
        role: "member",
        expiresAt,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(inviteResponse.status).toBe(201);
    const invitation = (await inviteResponse.json()) as {
      id: string;
      revision: number;
    };
    expect(invitation).not.toHaveProperty("targetRegistrationStatus");
    const redundantOrganization = await targetApp.request("http://x/v1/organizations", {
      method: "POST",
      headers: {
        cookie: "session=present",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Must not be created",
        operationId: crypto.randomUUID(),
      }),
    });
    expect(redundantOrganization.status).toBe(409);
    const [fallbackAfterBlockedSetup] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from managed_accounts
      where external_source = 'better-auth:user'
        and external_id = ${targetUserId}`;
    expect(fallbackAfterBlockedSetup?.count).toBe(0);
    const [storedBeforeBinding] = await shared.admin<Array<{ targetSubjectId: string | null }>>`
      select target_subject_id as "targetSubjectId"
      from organization_membership_invitations
      where id = ${invitation.id}`;
    expect(storedBeforeBinding?.targetSubjectId).toBeNull();
    const targetInvitations = await targetApp.request("http://x/v1/organization-invitations", {
      headers: { cookie: "session=present" },
    });
    expect(targetInvitations.status).toBe(200);
    const targetInvitationsBody = (await targetInvitations.json()) as {
      invitations: Array<{ id: string; revision: number }>;
      nextCursor: string | null;
    };
    expect(targetInvitationsBody.nextCursor).toBeNull();
    const listedInvitation = targetInvitationsBody.invitations.find(
      (candidate) => candidate.id === invitation.id,
    );
    expect(listedInvitation).toBeDefined();
    expect(listedInvitation).not.toHaveProperty("targetRegistrationStatus");
    const [storedAfterBinding] = await shared.admin<Array<{ targetSubjectId: string | null }>>`
      select target_subject_id as "targetSubjectId"
      from organization_membership_invitations
      where id = ${invitation.id}`;
    expect(storedAfterBinding?.targetSubjectId).toBe(`user:${targetUserId}`);
    expect(
      (
        await targetApp.request("http://x/v1/organization-invitations?limit=101", {
          headers: { cookie: "session=present" },
        })
      ).status,
    ).toBe(422);

    const acceptResponse = await targetApp.request(
      `http://x/v1/organization-invitations/${invitation.id}/accept`,
      {
        method: "POST",
        headers: {
          cookie: "session=present",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: listedInvitation!.revision,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(acceptResponse.status).toBe(200);
    const accepted = (await acceptResponse.json()) as {
      membership: {
        id: string;
        authorizationRevision: number;
        subjectId: string;
      };
    };
    expect(accepted.membership.subjectId).toBe(`user:${targetUserId}`);

    const memberList = await app.request(`http://x/v1/organizations/${accountId}/members`, {
      headers: { cookie: "session=present" },
    });
    expect(memberList.status).toBe(200);
    expect(((await memberList.json()) as { members: unknown[] }).members).toHaveLength(2);
    const organizationInvitations = await app.request(
      `http://x/v1/organizations/${accountId}/invitations?limit=1`,
      { headers: { cookie: "session=present" } },
    );
    expect(organizationInvitations.status).toBe(200);
    expect(
      ((await organizationInvitations.json()) as { invitations: unknown[] }).invitations,
    ).toHaveLength(1);
    const memberEnumeration = await targetApp.request(
      `http://x/v1/organizations/${accountId}/invitations`,
      { headers: { cookie: "session=present" } },
    );
    expect(memberEnumeration.status).toBe(403);
    const memberEmailProbe = await targetApp.request(
      `http://x/v1/organizations/${accountId}/invitations`,
      {
        method: "POST",
        headers: {
          cookie: "session=present",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: `${crypto.randomUUID()}@example.test`,
          role: "member",
          expiresAt,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(memberEmailProbe.status).toBe(403);
    const suspendResponse = await app.request(
      `http://x/v1/organizations/${accountId}/members/${accepted.membership.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: "session=present",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "suspend",
          expectedAuthorizationRevision: accepted.membership.authorizationRevision,
          operationId: crypto.randomUUID(),
          reason: "temporary leave",
        }),
      },
    );
    expect(suspendResponse.status).toBe(200);
    expect((await suspendResponse.json()) as { status: string }).toMatchObject({
      status: "suspended",
    });
    for (const retentionDays of [29, 91]) {
      const rejectedRetention = await app.request(
        `http://x/v1/organizations/${accountId}/retention-policy`,
        {
          method: "PATCH",
          headers: {
            cookie: "session=present",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "delete_after",
            retentionDays,
            expectedVersion: 1,
            operationId: crypto.randomUUID(),
          }),
        },
      );
      expect(rejectedRetention.status).toBe(422);
    }
  });

  test("creates a non-enumerating invitation before the email is registered", async () => {
    if (!app) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    const email = `not-registered-${crypto.randomUUID()}@example.test`;
    const response = await app.request(`http://x/v1/organizations/${accountId}/invitations`, {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Future teammate",
        initialWorkspaceIds: [],
        role: "member",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        operationId: crypto.randomUUID(),
      }),
    });
    expect(response.status).toBe(201);
    const invitation = await response.json();
    expect(invitation).toMatchObject({
      targetEmail: email,
      targetName: "Future teammate",
      initialWorkspaceIds: [],
      status: "pending",
    });
    expect(invitation).not.toHaveProperty("targetRegistrationStatus");
  });

  test("journals failed delivery, previews the frozen invitation, and retries with one stable provider key", async () => {
    if (!app || !client) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    managedEmailMessages.splice(0);
    managedEmailOutcome = { status: "failed", errorClass: "provider_refused" };
    try {
      const targetEmail = `delivery-retry-${crypto.randomUUID()}@example.test`;
      const createResponse = await app.request(
        `http://x/v1/organizations/${accountId}/invitations`,
        {
          method: "POST",
          headers: { cookie: "session=present", "content-type": "application/json" },
          body: JSON.stringify({
            email: targetEmail,
            name: "Delivery teammate",
            initialWorkspaceIds: [],
            role: "admin",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            operationId: crypto.randomUUID(),
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const invitation = (await createResponse.json()) as {
        id: string;
        delivery: {
          id: string;
          state: string;
          attemptCount: number;
          errorClass: string | null;
        };
      };
      expect(invitation.delivery).toMatchObject({
        state: "failed",
        attemptCount: 1,
        errorClass: "provider_refused",
      });
      expect(managedEmailMessages).toHaveLength(1);
      const failedMessage = managedEmailMessages[0]!;
      expect(failedMessage.kind).toBe("organization_user_setup");
      expect(failedMessage.to).toBe(targetEmail);
      expect(failedMessage.text).toContain("Hi Delivery teammate,");
      expect(failedMessage.text).toContain("as Admin");
      expect(failedMessage.text).toContain("never shares anyone's Personal workspace");
      expect(failedMessage.idempotencyKey).toBeTruthy();

      const setupUrl = failedMessage.text.match(/Accept invitation to .*: (https?:\/\/\S+)/)?.[1];
      expect(setupUrl).toBeTruthy();
      const parsedSetupUrl = new URL(setupUrl!);
      expect(parsedSetupUrl.hash).toBe("");
      const token = parsedSetupUrl.searchParams.get("token");
      expect(token).toBeTruthy();
      const previewApp = new Hono();
      registerManagedOnboardingRoutes(previewApp, {
        settings: managedSettings,
        db: client.db,
        managedAuth: {},
      } as never);
      const previewResponse = await previewApp.request(
        "http://x/v1/auth/organization-setup/preview",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      expect(previewResponse.status).toBe(200);
      expect(await previewResponse.json()).toMatchObject({
        state: "pending",
        organizationId: accountId,
        targetEmail,
        targetName: "Delivery teammate",
        organizationRole: "admin",
        sharedWorkspaceAccess: [],
      });

      managedEmailOutcome = { status: "sent", providerMessageId: "retry-message" };
      const retryOperationId = crypto.randomUUID();
      const retryResponse = await app.request(
        `http://x/v1/organizations/${accountId}/invitations/${invitation.id}/delivery/retry`,
        {
          method: "POST",
          headers: { cookie: "session=present", "content-type": "application/json" },
          body: JSON.stringify({ operationId: retryOperationId }),
        },
      );
      expect(retryResponse.status).toBe(200);
      expect(await retryResponse.json()).toMatchObject({
        id: invitation.delivery.id,
        state: "sent",
        attemptCount: 2,
        errorClass: null,
      });
      expect(managedEmailMessages).toHaveLength(2);
      const retriedMessage = managedEmailMessages[1]!;
      expect(retriedMessage).toEqual(failedMessage);

      const exactReplay = await app.request(
        `http://x/v1/organizations/${accountId}/invitations/${invitation.id}/delivery/retry`,
        {
          method: "POST",
          headers: { cookie: "session=present", "content-type": "application/json" },
          body: JSON.stringify({ operationId: retryOperationId }),
        },
      );
      expect(exactReplay.status).toBe(200);
      expect(await exactReplay.json()).toMatchObject({ state: "sent", attemptCount: 2 });
      expect(managedEmailMessages).toHaveLength(2);
    } finally {
      managedEmailOutcome = { status: "sent", providerMessageId: "test-message" };
      managedEmailMessages.splice(0);
    }
  }, 120_000);

  test("recovers a committed invitation with no journal and maps a concurrent claim to 409", async () => {
    if (!app || !client || !shared) return;
    managedEmailMessages.splice(0);
    managedEmailOutcome = { status: "sent", providerMessageId: "recovered-message" };
    const invitationOperationId = crypto.randomUUID();
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      operationId: invitationOperationId,
      targetSubjectId: null,
      targetEmail: `missing-journal-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const listedBeforeRecovery = await app.request(
      `http://x/v1/organizations/${accountId}/invitations`,
      { headers: { cookie: "session=present" } },
    );
    expect(listedBeforeRecovery.status).toBe(200);
    expect(
      (
        (await listedBeforeRecovery.json()) as {
          invitations: Array<{ id: string; delivery: unknown }>;
        }
      ).invitations.find((candidate) => candidate.id === invitation.id),
    ).toMatchObject({ delivery: null });
    const recovered = await app.request(
      `http://x/v1/organizations/${accountId}/invitations/${invitation.id}/delivery/retry`,
      {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      },
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ state: "sent", attemptCount: 1 });

    const deferredTargetEmail = `deferred-journal-${crypto.randomUUID()}@example.test`;
    const deferredInvitationOperationId = crypto.randomUUID();
    const deferredInvitation = await createOrganizationInvitation(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      operationId: deferredInvitationOperationId,
      targetSubjectId: null,
      targetEmail: deferredTargetEmail,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    let providerReachedResolve!: () => void;
    let releaseProviderResolve!: () => void;
    const providerReached = new Promise<void>((resolve) => {
      providerReachedResolve = resolve;
    });
    const releaseProvider = new Promise<void>((resolve) => {
      releaseProviderResolve = resolve;
    });
    managedEmailSendHook = async (message) => {
      if (message.to !== deferredTargetEmail) return;
      providerReachedResolve();
      await releaseProvider;
    };
    try {
      const endpoint = `http://x/v1/organizations/${accountId}/invitations/${deferredInvitation.id}/delivery/retry`;
      const firstRetry = app.request(endpoint, {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      });
      await providerReached;
      const messagesAtProvider = managedEmailMessages.length;
      const concurrentRetry = await app.request(endpoint, {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      });
      expect(concurrentRetry.status).toBe(409);
      expect(managedEmailMessages).toHaveLength(messagesAtProvider);
      releaseProviderResolve();
      expect((await firstRetry).status).toBe(200);
    } finally {
      managedEmailSendHook = null;
      releaseProviderResolve();
    }

    const heldInvitationOperationId = crypto.randomUUID();
    const heldInvitation = await createOrganizationInvitation(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      operationId: heldInvitationOperationId,
      targetSubjectId: null,
      targetEmail: `held-journal-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const held = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      invitationId: heldInvitation.id,
      invitationOperationId: heldInvitationOperationId,
      operationId: crypto.randomUUID(),
    });
    if (!held.claimed) throw new Error("held delivery was not claimed");
    const conflicted = await app.request(
      `http://x/v1/organizations/${accountId}/invitations/${heldInvitation.id}/delivery/retry`,
      {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      },
    );
    expect(conflicted.status).toBe(409);
    await shared.admin`
      update organization_user_setup_deliveries
      set claim_expires_at = clock_timestamp() - interval '1 second'
      where id = ${held.delivery.id}`;
    const recoveredHeld = await app.request(
      `http://x/v1/organizations/${accountId}/invitations/${heldInvitation.id}/delivery/retry`,
      {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      },
    );
    expect(recoveredHeld.status).toBe(200);
    expect(await recoveredHeld.json()).toMatchObject({ state: "sent", attemptCount: 2 });
  }, 120_000);

  test("returns an authoritative revoked invitation when revocation races provider delivery", async () => {
    if (!app || !shared) return;
    managedEmailMessages.splice(0);
    const targetEmail = `delivery-response-race-${crypto.randomUUID()}@example.test`;
    managedEmailSendHook = async (message) => {
      if (message.to !== targetEmail) return;
      await shared!.admin`
        update organization_membership_invitations
        set status = 'revoked', revision = revision + 1, updated_at = clock_timestamp()
        where account_id = ${accountId} and target_email = ${targetEmail}`;
    };
    try {
      const response = await app.request(`http://x/v1/organizations/${accountId}/invitations`, {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          role: "member",
          initialWorkspaceIds: [],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          operationId: crypto.randomUUID(),
        }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        targetEmail,
        status: "revoked",
        delivery: { state: "revoked", retryState: "unavailable" },
      });
    } finally {
      managedEmailSendHook = null;
      managedEmailMessages.splice(0);
    }
  }, 120_000);

  test("exposes owner-managed private-session settings behind readiness", async () => {
    if (!shared || !client || !app) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    const endpoint = `http://x/v1/organizations/${accountId}/private-session-settings`;
    const [ownerMembership] = await shared.admin<Array<{ id: string }>>`
      select id from organization_memberships
      where account_id = ${accountId} and subject_id = ${subjectId}`;
    if (!ownerMembership) throw new Error("owner membership missing");

    const otherUserId = `private-settings-idor-${crypto.randomUUID()}`;
    const otherEmail = `${otherUserId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${otherUserId}, 'Other organization owner', ${otherEmail}, true)`;
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id)
      values (${crypto.randomUUID()}, ${otherUserId}, 'credential', ${otherUserId})`;
    await synchronizeCanonicalHumanLoginBindings(client.db, otherUserId);
    const otherAccess = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: otherUserId,
      email: otherEmail,
      name: "Other organization owner",
      emailVerified: true,
    });
    const otherOrganizationId = otherAccess.organizationMemberships[0]?.organizationId;
    if (!otherOrganizationId) throw new Error("other organization missing");
    const otherEndpoint = `http://x/v1/organizations/${otherOrganizationId}/private-session-settings`;
    expect(
      (await app.request(otherEndpoint, { headers: { cookie: "session=present" } })).status,
    ).toBe(403);
    expect(
      (
        await app.request(otherEndpoint, {
          method: "PATCH",
          headers: { cookie: "session=present", "content-type": "application/json" },
          body: JSON.stringify({
            enabled: false,
            expectedVersion: 0,
            operationId: crypto.randomUUID(),
          }),
        })
      ).status,
    ).toBe(403);

    const initial = await app.request(endpoint, { headers: { cookie: "session=present" } });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      organizationId: accountId,
      enabled: false,
      available: false,
      version: 0,
    });

    const beforeReadiness = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(beforeReadiness.status).toBe(409);

    const memberShapedRequest = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
        membershipId: crypto.randomUUID(),
      }),
    });
    expect(memberShapedRequest.status).toBe(422);

    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'api-settings-test')`;
    const enabled = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      organizationId: accountId,
      enabled: true,
      available: true,
      version: 1,
      changed: true,
    });

    await shared.admin`
      update organization_memberships set role = 'member'
      where id = ${ownerMembership.id}`;
    const memberGet = await app.request(endpoint, { headers: { cookie: "session=present" } });
    const memberPatch = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        expectedVersion: 1,
        operationId: crypto.randomUUID(),
      }),
    });
    const memberCreateWorkspace = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces`,
      {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          name: "Member must not create",
          operationId: crypto.randomUUID(),
        }),
      },
    );
    await shared.admin`
      update organization_memberships set role = 'owner'
      where id = ${ownerMembership.id}`;
    expect(memberGet.status).toBe(403);
    expect(memberPatch.status).toBe(403);
    expect(memberCreateWorkspace.status).toBe(403);
  });

  test("renames the canonical organization and inventories every shared workspace without Personal workspaces", async () => {
    if (!shared || !app) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string; personalWorkspaceId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    const personalWorkspaceId = membershipBody.memberships[0]!.personalWorkspaceId;
    const sharedWorkspaceId = crypto.randomUUID();
    const serviceSubject = `service:${crypto.randomUUID()}`;
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (
        ${sharedWorkspaceId}, ${accountId}, 'Company platform', 'test', ${crypto.randomUUID()}
      )`;
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${accountId}, ${sharedWorkspaceId}, ${subjectId}, 'Organization member', 'admin',
        ${shared.admin.json(["sessions:read", "workspace:read"])}::jsonb
      ), (
        ${accountId}, ${sharedWorkspaceId}, ${serviceSubject}, 'Deployment automation', 'service',
        ${shared.admin.json(["workspace:read"])}::jsonb
      )`;

    const overviewResponse = await app.request(`http://x/v1/organizations/${accountId}/overview`, {
      headers: { cookie: "session=present" },
    });
    expect(overviewResponse.status).toBe(200);
    const overview = (await overviewResponse.json()) as {
      organization: { name: string; updatedAt: string };
      workspaces: Array<{
        id: string;
        name: string;
        members: Array<{ subjectId: string; subjectLabel: string; principalKind: string }>;
      }>;
    };
    expect(overview.workspaces.map((workspace) => workspace.id)).toContain(sharedWorkspaceId);
    expect(overview.workspaces.map((workspace) => workspace.id)).not.toContain(personalWorkspaceId);
    expect(
      overview.workspaces.find((workspace) => workspace.id === sharedWorkspaceId),
    ).toMatchObject({
      name: "Company platform",
      members: [
        expect.objectContaining({
          subjectId: serviceSubject,
          subjectLabel: "Deployment automation",
          principalKind: "service",
        }),
        expect.objectContaining({
          subjectId,
          subjectLabel: "Organization member",
          principalKind: "human",
        }),
      ],
    });

    const operationId = crypto.randomUUID();
    const rename = await app.request(`http://x/v1/organizations/${accountId}`, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme Engineering",
        expectedUpdatedAt: overview.organization.updatedAt,
        operationId,
      }),
    });
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as { name: string; updatedAt: string };
    expect(renamed).toMatchObject({ name: "Acme Engineering" });

    const secondRename = await app.request(`http://x/v1/organizations/${accountId}`, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme Product",
        expectedUpdatedAt: renamed.updatedAt,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(secondRename.status).toBe(200);
    expect(await secondRename.json()).toMatchObject({ name: "Acme Product" });

    const replay = await app.request(`http://x/v1/organizations/${accountId}`, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme Engineering",
        expectedUpdatedAt: overview.organization.updatedAt,
        operationId,
      }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(renamed);

    // An ordinary managed-session bootstrap must not overwrite the name with
    // the user's profile name after an administrator has deliberately renamed it.
    await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const afterBootstrap = await app.request(`http://x/v1/organizations/${accountId}/overview`, {
      headers: { cookie: "session=present" },
    });
    expect(await afterBootstrap.json()).toMatchObject({
      organization: { name: "Acme Product" },
    });
  }, 180_000);

  test("administers existing shared workspaces without access while granting new creators workspace admin", async () => {
    if (!shared || !app) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string; personalWorkspaceId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    const personalWorkspaceId = membershipBody.memberships[0]!.personalWorkspaceId;
    const sharedWorkspaceId = crypto.randomUUID();
    const targetPersonalWorkspaceId = crypto.randomUUID();
    const targetMembershipId = crypto.randomUUID();
    const targetSubjectId = `user:organization-control-target-${crypto.randomUUID()}`;
    await shared.admin`
      insert into workspaces (id, account_id, name)
      values
        (${sharedWorkspaceId}, ${accountId}, 'Control-plane workspace'),
        (${targetPersonalWorkspaceId}, ${accountId}, 'Target personal workspace')`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values
        (${sharedWorkspaceId}, ${accountId}),
        (${targetPersonalWorkspaceId}, ${accountId})`;
    await shared.admin`
      insert into organization_memberships (
        id, account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${targetMembershipId}, ${accountId}, ${targetSubjectId}, 'member', 'active',
        ${targetPersonalWorkspaceId}
      )`;

    const before = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from workspace_memberships
      where workspace_id = ${sharedWorkspaceId} and subject_id = ${subjectId}`;
    expect(before[0]?.count).toBe(0);

    const createOperationId = crypto.randomUUID();
    const createBody = {
      name: "Created through organization",
      operationId: createOperationId,
    };
    const created = await app.request(`http://x/v1/organizations/${accountId}/workspaces`, {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    const createdWorkspace = (await created.json()) as { id: string; name: string };
    expect(createdWorkspace).toMatchObject({ name: createBody.name });
    const replayCreate = await app.request(`http://x/v1/organizations/${accountId}/workspaces`, {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(replayCreate.status).toBe(201);
    expect(await replayCreate.json()).toEqual(createdWorkspace);
    const [createdMembership] = await shared.admin<Array<{ count: number; role: string | null }>>`
      select count(*)::int as count, max(role::text) as role from workspace_memberships
      where workspace_id = ${createdWorkspace.id} and subject_id = ${subjectId}`;
    expect(createdMembership).toEqual({ count: 1, role: "admin" });

    const missingUpdate = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}/members/${crypto.randomUUID()}`,
      {
        method: "PUT",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          role: "admin",
          expectedUpdatedAt: null,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(missingUpdate.status).toBe(404);

    const add = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}/members/${targetMembershipId}`,
      {
        method: "PUT",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          role: "member",
          expectedUpdatedAt: null,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(add.status).toBe(200);
    const addedAccess = (await add.json()) as { updatedAt: string; permissions: string[] };
    expect(addedAccess).toMatchObject({
      subjectId: targetSubjectId,
      role: "member",
    });
    expect(addedAccess.permissions).toContain("sessions:create");

    const promote = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}/members/${targetMembershipId}`,
      {
        method: "PUT",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          role: "admin",
          expectedUpdatedAt: addedAccess.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(promote.status).toBe(200);
    const promotedAccess = (await promote.json()) as { updatedAt: string; permissions: string[] };
    expect(promotedAccess).toMatchObject({
      subjectId: targetSubjectId,
      role: "admin",
    });
    expect(promotedAccess.permissions).toContain("workspace:admin");

    const [workspaceBeforeRename] = await shared.admin<Array<{ updatedAt: string }>>`
      select to_char(
        updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as "updatedAt" from workspaces where id = ${sharedWorkspaceId}`;

    const rename = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}`,
      {
        method: "PATCH",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          name: "Renamed through organization",
          expectedUpdatedAt: workspaceBeforeRename!.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ name: "Renamed through organization" });

    const settings = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}/settings`,
      {
        method: "PATCH",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({ memoryEnabled: true }),
      },
    );
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ settings: { memoryEnabled: true } });

    const personalDenied = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${personalWorkspaceId}/members/${targetMembershipId}`,
      {
        method: "PUT",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          role: "viewer",
          expectedUpdatedAt: null,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(personalDenied.status).toBe(403);

    const remove = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}/members/${targetMembershipId}/revoke`,
      {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: promotedAccess.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(remove.status).toBe(200);
    expect(await remove.json()).toMatchObject({ removed: true, replay: false });
    const after = await shared.admin<Array<{ actorCount: number; targetCount: number }>>`
      select
        count(*) filter (where subject_id = ${subjectId})::int as "actorCount",
        count(*) filter (where subject_id = ${targetSubjectId})::int as "targetCount"
      from workspace_memberships
      where workspace_id = ${sharedWorkspaceId}`;
    expect(after[0]).toEqual({ actorCount: 0, targetCount: 0 });

    const personalDeleteDenied = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${personalWorkspaceId}`,
      { method: "DELETE", headers: { cookie: "session=present" } },
    );
    expect(personalDeleteDenied.status).toBe(403);

    const deleted = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}`,
      { method: "DELETE", headers: { cookie: "session=present" } },
    );
    expect(deleted.status).toBe(204);
    const [remaining] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from workspaces where id = ${sharedWorkspaceId}`;
    expect(remaining?.count).toBe(0);

    const missingDelete = await app.request(
      `http://x/v1/organizations/${accountId}/workspaces/${sharedWorkspaceId}`,
      { method: "DELETE", headers: { cookie: "session=present" } },
    );
    expect(missingDelete.status).toBe(404);
  }, 180_000);

  test("refuses invitation creation before committing when setup delivery is unconfigured", async () => {
    if (!shared || !client) return;
    const unconfigured = new Hono();
    registerOrganizationMembershipRoutes(unconfigured, {
      db: client.db,
      // Managed mode with integrations disabled is a valid deployment that never
      // requires OPENGENI_PUBLIC_BASE_URL, so this precondition is reachable.
      settings: testSettings({ productAccessMode: "managed" }),
      managedAuth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: { id: authSessionId },
              user: {
                id: userId,
                email: `${userId}@example.test`,
                name: "Organization member",
                emailVerified: true,
              },
            },
          }),
        },
      } as never,
    } as ApiRouteDeps);
    const targetEmail = `unconfigured-${crypto.randomUUID()}@example.test`;
    const response = await unconfigured.request(
      `http://x/v1/organizations/${accountId}/invitations`,
      {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          role: "member",
          operationId: crypto.randomUUID(),
          initialWorkspaceIds: [],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      },
    );
    expect(response.status).toBe(503);
    // The point of the precondition: no orphaned invitation row is left behind.
    const [committed] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from organization_membership_invitations
      where target_email = ${targetEmail}`;
    expect(committed?.count).toBe(0);
  });

  test("creates another organization for the same authenticated human", async () => {
    if (!shared || !client) return;
    const additionalUserId = `additional-organization-${crypto.randomUUID()}`;
    const additionalSubjectId = `user:${additionalUserId}`;
    const additionalSessionId = `session-${crypto.randomUUID()}`;
    const additionalEmail = `${additionalUserId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${additionalUserId}, 'Additional owner', ${additionalEmail}, true)`;
    await completeSelfServiceOrganizationSetup(client.db, {
      authUserId: additionalUserId,
      actorSubjectId: additionalSubjectId,
      organizationName: "Original organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "b".repeat(64),
    });
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id)
      values (${crypto.randomUUID()}, ${additionalUserId}, 'credential', ${additionalUserId})`;
    const identity = await synchronizeCanonicalHumanLoginBindings(client.db, additionalUserId);
    await shared.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at,
        identity_id, identity_revision, auth_revision
      ) values (
        ${additionalSessionId}, ${additionalUserId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
      )`;

    const additionalApp = new Hono();
    registerOrganizationMembershipRoutes(additionalApp, {
      db: client.db,
      settings: managedSettings,
      managedAuth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: { id: additionalSessionId },
              user: {
                id: additionalUserId,
                email: additionalEmail,
                name: "Additional owner",
                emailVerified: true,
              },
            },
          }),
        },
      } as never,
      managedEmailTransport,
    } as ApiRouteDeps);

    const request = {
      name: "New team",
      workspaceName: "General",
      operationId: crypto.randomUUID(),
    };
    const response = await additionalApp.request("http://x/v1/organizations/additional", {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      organization: { id: string; name: string };
      workspaceId: string;
      personalWorkspaceId: string;
    };
    expect(created).toMatchObject({ organization: { name: "New team" } });
    expect(created.workspaceId).not.toBe(created.personalWorkspaceId);

    const replay = await additionalApp.request("http://x/v1/organizations/additional", {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);

    const malformed = await additionalApp.request("http://x/v1/organizations/additional", {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({ ...request, operationId: crypto.randomUUID(), unexpected: true }),
    });
    expect(malformed.status).toBe(422);

    for (let index = 2; index <= 10; index += 1) {
      const withinLimit = await additionalApp.request("http://x/v1/organizations/additional", {
        method: "POST",
        headers: { cookie: "session=present", "content-type": "application/json" },
        body: JSON.stringify({
          name: `Additional team ${index}`,
          workspaceName: `Workspace ${index}`,
          operationId: crypto.randomUUID(),
        }),
      });
      expect(withinLimit.status).toBe(201);
    }
    const overLimit = await additionalApp.request("http://x/v1/organizations/additional", {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        name: "One too many",
        workspaceName: "Overflow",
        operationId: crypto.randomUUID(),
      }),
    });
    expect(overLimit.status).toBe(409);
    expect(await overLimit.text()).toBe("additional organization limit reached");

    const [graph] = await shared.admin<
      Array<{ memberships: number; workspaces: number; access: number }>
    >`
      select
        (select count(*)::int from organization_memberships
          where account_id = ${created.organization.id}
            and subject_id = ${additionalSubjectId}
            and role = 'owner' and status = 'active') as memberships,
        (select count(*)::int from workspaces
          where account_id = ${created.organization.id}) as workspaces,
        (select count(*)::int from workspace_memberships
          where account_id = ${created.organization.id}
            and workspace_id = ${created.workspaceId}
            and subject_id = ${additionalSubjectId}
            and role = 'admin') as access`;
    expect(graph).toEqual({ memberships: 1, workspaces: 2, access: 1 });
  });

  test("returns only the current active membership and reports terminal state as empty", async () => {
    if (!shared || !app) return;

    const response = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      memberships: Array<{
        id: string;
        organizationId: string;
        status: string;
        personalWorkspaceId: string;
      }>;
    };
    expect(body.memberships).toHaveLength(1);
    accountId = body.memberships[0]!.organizationId;

    const [stored] = await shared.admin<
      Array<{
        id: string;
        accountId: string;
        status: string;
        personalWorkspaceId: string;
      }>
    >`
      select
        id,
        account_id as "accountId",
        status,
        personal_workspace_id as "personalWorkspaceId"
      from organization_memberships
      where account_id = ${accountId}
        and subject_id = ${subjectId}`;
    expect(body).toEqual({
      memberships: [
        {
          id: stored!.id,
          organizationId: stored!.accountId,
          status: "active",
          personalWorkspaceId: stored!.personalWorkspaceId,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(subjectId);
    expect(JSON.stringify(body)).not.toContain("retention");

    await shared.admin`
      update organization_memberships
      set status = 'suspended', revoked_at = null
      where account_id = ${accountId}
        and subject_id = ${subjectId}`;
    // Terminal-only membership is a bounded EMPTY projection, not a 403. The
    // route lists only the caller's own memberships, so an empty list leaks
    // nothing, and it is the exact state the onboarding contract reports as
    // `unavailable` - a 403 here used to come from the fallback-organization
    // projection that 0348 removed, and made the caller look unauthenticated
    // rather than un-onboarded.
    const terminal = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toEqual({ memberships: [] });
    expect(
      await getSelfServiceOrganizationOnboardingState(client!.db, {
        authUserId: userId,
        email: `${userId}@example.test`,
        emailVerified: true,
      }),
    ).toBe("unavailable");
  });
});
