import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  type AccessContext,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getConnectionMetadata,
  updateOrganizationMember,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { createSignedState } from "@opengeni/github";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import {
  completeSocialOAuthCallback,
  type SocialProviderFetch,
} from "../src/integrations/social-oauth";

// A managed human's Personal workspace has no workspace_memberships row; the
// owner reaches it only through the canonical managed-cookie exception. An
// OAuth callback carries signed state instead of that cookie and re-checks the
// owner through requireConnectOwnerAuthority, which finds them only through
// the signed personal-owner claim. Fiken and the Slack bot once omitted the
// claim and the legacy X/Reddit callback bypassed that re-check, so each failed
// only here, after provider consent. These cases start from a real Better Auth
// session; connect-owner-state-surface.test.ts keeps new connectors on the
// same path.

const STATE_SECRET = "connect-personal-workspace-state-secret";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

const authSessionBySessionCookie = new Map<
  string,
  { authSessionId: string; userId: string; email: string }
>();

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: `connect-personal-${crypto.randomUUID()}`,
  sandboxBackend: "none",
  integrationsEnabled: true,
  integrationsStateSecret: STATE_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  publicBaseUrl: "https://app.example.test",
  fikenClientId: "fiken-client-id",
  fikenClientSecret: "fiken-client-secret",
  slackClientId: "slack-client-id",
  slackClientSecret: "slack-client-secret",
  slackSigningSecret: "slack-signing-secret",
  socialOauthClientsJson: JSON.stringify({ x: { clientId: "x-client", clientSecret: "x-secret" } }),
});

type ProviderCall = { method: string; url: URL };

function recordingFetch(respond: (url: URL, method: string) => Response): {
  fetch: typeof globalThis.fetch;
  calls: ProviderCall[];
} {
  const calls: ProviderCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    return respond(url, method);
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function fakeFiken() {
  return recordingFetch((url) => {
    if (url.hostname === "fiken.no" && url.pathname === "/oauth/token") {
      return Response.json({
        access_token: "fixture-oauth-access-token",
        refresh_token: "fixture-oauth-refresh-token",
        token_type: "bearer",
        expires_in: 86_400,
      });
    }
    if (url.pathname.endsWith("/companies")) {
      return Response.json([{ slug: "demo-as", name: "Demo AS", organizationNumber: "999999999" }]);
    }
    return Response.json({ message: "unexpected fixture route" }, { status: 500 });
  });
}

function fakeSlack() {
  // One Slack team binds to one Opengeni workspace, so each install gets its own.
  const teamId = `T_${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  return recordingFetch((url) => {
    const method = url.pathname.replace(/^\/api\//u, "");
    if (method === "oauth.v2.access") {
      return Response.json({
        ok: true,
        access_token: ["xoxb", "fixture", "not-a-real-credential"].join("-"),
        app_id: "A_OPEN_GENI",
      });
    }
    if (method === "auth.test") {
      return Response.json(
        {
          ok: true,
          team_id: teamId,
          team: "Opengeni Test Workspace",
          user_id: "U_OPEN_GENI",
          bot_id: "B_OPEN_GENI",
        },
        { headers: { "x-oauth-scopes": OPENGENI_SLACK_BOT_REQUESTED_SCOPES.join(",") } },
      );
    }
    if (method === "users.info") {
      return Response.json({
        ok: true,
        user: {
          id: "U_OPEN_GENI",
          is_bot: true,
          deleted: false,
          profile: { display_name: "Opengeni", real_name: "Opengeni", api_app_id: "A_OPEN_GENI" },
        },
      });
    }
    return Response.json({ ok: false, error: "unexpected_fixture_method" });
  });
}

function fakeX(): { fetch: SocialProviderFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: SocialProviderFetch = async (url) => {
    calls.push(url);
    if (url === "https://api.x.com/2/oauth2/token") {
      return Response.json({
        access_token: "x-access-1",
        refresh_token: "x-refresh-1",
        token_type: "bearer",
        expires_in: 7200,
        scope: "tweet.read tweet.write users.read offline.access",
      });
    }
    if (url === "https://api.x.com/2/users/me") {
      return Response.json({ data: { id: "u-777", username: "opengeni_ai", name: "Opengeni" } });
    }
    return Response.json({ error: `unexpected provider call: ${url}` }, { status: 500 });
  };
  return { fetch: fetchImpl, calls };
}

function buildApp(
  providers: { fikenFetch?: typeof globalThis.fetch; slackFetch?: typeof globalThis.fetch } = {},
): Hono {
  if (!client) throw new Error("test database unavailable");
  const noop = async () => undefined;
  return createApp({
    db: client.db,
    bus: new MemoryEventBus(),
    settings,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = authSessionBySessionCookie.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, name: "Managed human" },
            },
          };
        },
      },
    } as never,
    ...providers,
  } as unknown as ApiRouteDeps);
}

type ManagedHuman = {
  subjectId: string;
  accountId: string;
  cookie: string;
  personalWorkspaceId: string;
};

async function createAuthHuman(bootstrapOwnOrganization = true) {
  if (!client || !shared) throw new Error("test database unavailable");
  const userId = `connect-personal-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const cookie = `session=${authSessionId}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Managed human', ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  if (bootstrapOwnOrganization) {
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email,
      name: "Managed human",
      emailVerified: true,
    });
  }
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  authSessionBySessionCookie.set(cookie, { authSessionId, userId, email });
  return { subjectId: `user:${userId}`, email, cookie };
}

async function resolveManagedHuman(
  auth: { subjectId: string; cookie: string },
  expectedAccountId?: string,
): Promise<ManagedHuman> {
  if (!shared) throw new Error("test database unavailable");
  const response = await buildApp().request("http://x/v1/access/me", {
    headers: { cookie: auth.cookie },
  });
  if (response.status !== 200) throw new Error(`managed provisioning failed: ${response.status}`);
  const access = (await response.json()) as AccessContext;
  const accountId = expectedAccountId ?? access.defaultAccountId!;
  const [membership] = await shared.admin<Array<{ personalWorkspaceId: string }>>`
    select personal_workspace_id as "personalWorkspaceId"
    from organization_memberships
    where account_id = ${accountId} and subject_id = ${auth.subjectId} and status = 'active'`;
  if (!membership) throw new Error("managed human has no active organization membership");
  return {
    subjectId: auth.subjectId,
    accountId,
    cookie: auth.cookie,
    personalWorkspaceId: membership.personalWorkspaceId,
  };
}

async function provisionManagedHuman(): Promise<ManagedHuman> {
  return await resolveManagedHuman(await createAuthHuman());
}

async function inviteMember(owner: ManagedHuman): Promise<ManagedHuman> {
  if (!client) throw new Error("test database unavailable");
  const auth = await createAuthHuman(false);
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: owner.accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: auth.subjectId,
    targetEmail: auth.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: owner.accountId,
    actorSubjectId: auth.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return await resolveManagedHuman(auth, owner.accountId);
}

function jsonHeaders(human: ManagedHuman): Record<string, string> {
  return { cookie: human.cookie, "content-type": "application/json" };
}

async function startedState(response: Response, urlField = "authorizationUrl"): Promise<string> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  return new URL(String(body[urlField])).searchParams.get("state")!;
}

async function connectionCount(workspaceId: string, providerDomain: string): Promise<number> {
  const [row] = await shared!.admin<Array<{ count: number }>>`
    select count(*)::int as count from connections
    where workspace_id = ${workspaceId} and provider_domain = ${providerDomain}`;
  return row!.count;
}

/** A native Connect attempt in the Personal workspace, completed by its callback. */
async function completeConnectAttempt(
  app: Hono,
  human: ManagedHuman,
  providerId: string,
  callbackPath: string,
): Promise<Record<string, unknown>> {
  const base = `/v1/workspaces/${human.personalWorkspaceId}/connect/attempts`;
  const returnUrl = `https://HOST.example:443/settings?x=%2f#${providerId}`;
  const begin = await app.request(base, {
    method: "POST",
    headers: jsonHeaders(human),
    body: JSON.stringify({
      providerId,
      ownership: "workspace",
      returnUrl,
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  expect(begin.status).toBe(200);
  const attempt = (await begin.json()) as { id: string; nextAction: { url: string } };
  const state = new URL(attempt.nextAction.url).searchParams.get("state")!;
  const response = await app.request(
    `${callbackPath}?${new URLSearchParams({ code: "fixture-auth-code", state })}`,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(returnUrl);
  return (await (
    await app.request(`${base}/${attempt.id}`, { headers: jsonHeaders(human) })
  ).json()) as Record<string, unknown>;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-connect-personal-workspace");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("real database required");
    console.warn("[connect-personal-workspace] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("OAuth connectors in the owner's Personal workspace", () => {
  test("the premise: the Personal workspace has no workspace_memberships row", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const rows = await shared.admin`
      select 1 from workspace_memberships where workspace_id = ${human.personalWorkspaceId}`;
    expect(rows.length).toBe(0);
  });

  test("Fiken connects through the OAuth start route and callback", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const provider = fakeFiken();
    const app = buildApp({ fikenFetch: provider.fetch });
    const state = await startedState(
      await app.request(
        `/v1/workspaces/${human.personalWorkspaceId}/connections/fiken/oauth/start`,
        { method: "POST", headers: jsonHeaders(human), body: JSON.stringify({}) },
      ),
    );
    // The browser returns from the provider without the Opengeni cookie.
    const response = await app.request(
      `/v1/integrations/fiken/callback?${new URLSearchParams({ code: "fixture-auth-code", state })}`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("reason")).toBeNull();
    expect(location.searchParams.get("fiken")).toBe("connected");
    const connection = await getConnectionMetadata(
      client.db,
      human.personalWorkspaceId,
      location.searchParams.get("connectionId")!,
      null,
    );
    expect(connection).toMatchObject({
      subjectId: null,
      providerDomain: "fiken.no",
      kind: "oauth2",
      status: "active",
      metadata: expect.objectContaining({ defaultCompanySlug: "demo-as" }),
    });
  });

  test("Fiken completes a native Connect attempt", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const app = buildApp({ fikenFetch: fakeFiken().fetch });
    expect(
      await completeConnectAttempt(app, human, "fiken-oauth", "/v1/integrations/fiken/callback"),
    ).toMatchObject({
      state: "complete",
      credentialsCommitted: true,
      account: { providerId: "fiken-oauth", ownership: "workspace" },
    });
    expect(await connectionCount(human.personalWorkspaceId, "fiken.no")).toBe(1);
  });

  test("the Slack bot installs through the install route and callback", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const provider = fakeSlack();
    const app = buildApp({ slackFetch: provider.fetch });
    const state = await startedState(
      await app.request(
        `/v1/workspaces/${human.personalWorkspaceId}/connections/slack-bot/install`,
        { method: "POST", headers: jsonHeaders(human), body: JSON.stringify({}) },
      ),
    );
    const response = await app.request(
      `/v1/integrations/slack/callback?${new URLSearchParams({ code: "fixture-code", state })}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("slack=connected");
    const [row] = await shared.admin<Array<{ subjectId: string | null }>>`
      select subject_id as "subjectId" from connections
      where workspace_id = ${human.personalWorkspaceId}
        and metadata->>'credentialRole' = ${OPENGENI_SLACK_BOT_CREDENTIAL_ROLE}`;
    expect(row).toEqual({ subjectId: null });
  });

  test("the Slack bot completes a native Connect attempt", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const app = buildApp({ slackFetch: fakeSlack().fetch });
    expect(
      await completeConnectAttempt(app, human, "slack-bot", "/v1/integrations/slack/callback"),
    ).toMatchObject({ state: "complete", credentialsCommitted: true });
  });

  test("X connects only for the owner through the in-chat OAuth start", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const provider = fakeX();
    const state = await startedState(
      await buildApp().request(`/v1/workspaces/${human.personalWorkspaceId}/social/oauth/start`, {
        method: "POST",
        headers: jsonHeaders(human),
        body: JSON.stringify({ provider: "x", ownership: "personal" }),
      }),
    );
    // The callback route takes no provider double, so drive its handler with one.
    const result = await completeSocialOAuthCallback(
      { db: client.db, settings, providerFetch: provider.fetch },
      {
        code: "provider-code",
        state,
        requestUrl: "https://app.example.test/v1/social/oauth/callback",
      },
    );
    const location = new URL(result.redirectTo, "https://app.example.test");
    expect(location.searchParams.get("reason")).toBeNull();
    expect(provider.calls).toContain("https://api.x.com/2/oauth2/token");
    const rows = await shared.admin<Array<{ subjectId: string | null }>>`
      select subject_id as "subjectId" from social_connections
      where workspace_id = ${human.personalWorkspaceId} and provider = 'x'`;
    expect(rows).toEqual([{ subjectId: human.subjectId }]);
  });

  test("a state without the signed personal-owner claim still fails closed", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const provider = fakeFiken();
    const state = createSignedState(STATE_SECRET, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      subjectId: human.subjectId,
      returnPath: `/workspaces/${human.personalWorkspaceId}/plugins`,
    });
    const response = await buildApp({ fikenFetch: provider.fetch }).request(
      `/v1/integrations/fiken/callback?${new URLSearchParams({ code: "fixture-auth-code", state })}`,
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("fiken")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("callback_failed");
    expect(provider.calls).toHaveLength(0);
    expect(await connectionCount(human.personalWorkspaceId, "fiken.no")).toBe(0);
  });

  test("the claim does not open another member's Personal workspace", async () => {
    if (!shared) return;
    const owner = await provisionManagedHuman();
    const member = await inviteMember(owner);
    const provider = fakeFiken();
    // Even a correctly signed claim names only its own subject, and the
    // resolver admits that subject only to its own Personal workspace.
    const state = createSignedState(STATE_SECRET, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      subjectId: member.subjectId,
      personalOwnerVerified: true,
      returnPath: `/workspaces/${owner.personalWorkspaceId}/plugins`,
    });
    const response = await buildApp({ fikenFetch: provider.fetch }).request(
      `/v1/integrations/fiken/callback?${new URLSearchParams({ code: "fixture-auth-code", state })}`,
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("fiken")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("callback_failed");
    expect(provider.calls).toHaveLength(0);
    expect(await connectionCount(owner.personalWorkspaceId, "fiken.no")).toBe(0);
  });

  test("a claim signed before the member was suspended no longer finishes", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const member = await inviteMember(owner);
    const provider = fakeFiken();
    const app = buildApp({ fikenFetch: provider.fetch });
    // A genuine start from the member's own Personal workspace in this
    // organization, signed while the membership was live.
    const state = await startedState(
      await app.request(
        `/v1/workspaces/${member.personalWorkspaceId}/connections/fiken/oauth/start`,
        { method: "POST", headers: jsonHeaders(member), body: JSON.stringify({}) },
      ),
    );
    const [membership] = await shared.admin<Array<{ id: string; authorizationRevision: number }>>`
      select id, authorization_revision::int as "authorizationRevision"
      from organization_memberships
      where account_id = ${owner.accountId} and subject_id = ${member.subjectId}`;
    await updateOrganizationMember(client.db, {
      organizationId: owner.accountId,
      actorSubjectId: owner.subjectId,
      operationId: crypto.randomUUID(),
      membershipId: membership!.id,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: membership!.authorizationRevision,
        reason: "left between consent and callback",
      },
    });
    const response = await app.request(
      `/v1/integrations/fiken/callback?${new URLSearchParams({ code: "fixture-auth-code", state })}`,
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("fiken")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("callback_failed");
    expect(provider.calls).toHaveLength(0);
    expect(await connectionCount(member.personalWorkspaceId, "fiken.no")).toBe(0);
  });

  test("another connector's signed state is not accepted as a Fiken state", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const provider = fakeFiken();
    // A genuine Slack bot install state for the same person and workspace,
    // signed with the same integrations secret, replayed into Fiken.
    const slackState = await startedState(
      await buildApp({ slackFetch: fakeSlack().fetch }).request(
        `/v1/workspaces/${human.personalWorkspaceId}/connections/slack-bot/install`,
        { method: "POST", headers: jsonHeaders(human), body: JSON.stringify({}) },
      ),
    );
    const response = await buildApp({ fikenFetch: provider.fetch }).request(
      `/v1/integrations/fiken/callback?${new URLSearchParams({
        code: "fixture-auth-code",
        state: slackState,
      })}`,
    );
    const location = new URL(response.headers.get("location") ?? "http://x/");
    expect(location.searchParams.get("fiken")).toBe("error");
    expect(provider.calls).toHaveLength(0);
    expect(await connectionCount(human.personalWorkspaceId, "fiken.no")).toBe(0);
  });
});
