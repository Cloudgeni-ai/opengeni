import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { signDelegatedAccessToken, type PrReviewManagedGitHubSetup } from "@opengeni/contracts";
import { stampDelegatedHumanAuthorization, type ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createWorkspace,
  deleteWorkspace,
  listPrReviewAppRegistrations,
  listPrReviewRepositoryBindings,
  synchronizeCanonicalHumanLoginBindings,
  type DbClient,
} from "@opengeni/db";
import { readSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerPrReviewGitHubRoutes } from "../src/routes/pr-review-github";

const stateSecret = "pr-review-github-route-state-secret";
const webhookSecret = "pr-review-github-route-webhook-secret";
const encryptionKey = Buffer.alloc(32, 19).toString("base64");
const delegationSecret = "pr-review-github-native-fixture-delegation-secret";
const userId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const nativeCookie = `lens-native-session=${sessionId}`;
const nativeUser = {
  id: userId,
  name: "Lens native owner",
  email: `${userId}@lens-fixture.example.test`,
  emailVerified: true,
};

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let workspaceId: string | null = null;
let accountId: string | null = null;
let subjectId: string | null = null;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) throw new Error("Set both policy fixture URLs");
  if (adminUrl && appUrl) {
    const admin = postgres(adminUrl);
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    shared = await acquireSharedTestDatabase("pr-review-github-routes");
  }
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("PR Review GitHub routes require real PostgreSQL");
    return;
  }
  client = createDb(shared.appUrl);
  await shared.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${nativeUser.name}, ${nativeUser.email}, true)`;
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`insert into auth_sessions (
    id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
  ) values (${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
    ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision})`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test:pr-review-native",
    accountExternalId: userId,
    accountName: "Lens native fixture",
    workspaceExternalSource: "test:pr-review-native",
    workspaceExternalId: userId,
    workspaceName: "Lens native fixture",
    subjectId: `user:${userId}`,
    subjectLabel: nativeUser.name,
    workspacePermissions: ["workspace:read", "workspace:admin", "secrets:write"],
  });
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  )!;
  workspaceId = grant.workspaceId;
  accountId = grant.accountId;
  subjectId = grant.subjectId;
  const personal = await createWorkspace(client.db, {
    accountId,
    name: "Lens native Personal",
  });
  await shared.admin`insert into organization_memberships (
    account_id, subject_id, role, status, personal_workspace_id
  ) values (${accountId}, ${subjectId}, 'owner', 'active', ${personal.id})`;
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  if (shared) {
    if (accountId) {
      await shared.admin`delete from organization_memberships where account_id = ${accountId}`;
      await shared.admin`delete from managed_accounts where id = ${accountId}`;
    }
    await shared.admin`delete from auth_users where id = ${userId}`;
  }
  await client?.close();
  await shared?.release();
}, 180_000);

function browserHeader(response: Response): string {
  const flowCookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!);
  expect(flowCookies.length).toBeGreaterThan(0);
  return [nativeCookie, ...flowCookies].join("; ");
}

describe("OpenGeni Lens GitHub installation routes", () => {
  test("owner-proves one installation, consumes OAuth state once, and routes its signed webhook", async () => {
    if (!client || !workspaceId || !accountId || !subjectId) return;
    const app = new Hono();
    let discoveryCalls = 0;
    let proofCalls = 0;
    registerPrReviewGitHubRoutes(app, {
      db: client.db,
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret,
        environmentsEncryptionKey: encryptionKey,
        githubAppManifestStateSecret: stateSecret,
        prReviewGithubAppId: "98765",
        prReviewGithubClientId: "lens-client",
        prReviewGithubClientSecret: "lens-client-secret",
        prReviewGithubAppSlug: "opengeni-lens",
        prReviewGithubWebhookSecret: webhookSecret,
        prReviewGithubAppPrivateKey: "test-private-key",
        sandboxBackend: "none",
      }),
      githubStateSecret: stateSecret,
      managedAuth: {
        api: {
          getSession: async ({ headers }: { headers: Headers }) => {
            const cookies = (headers.get("cookie") ?? "").split(";").map((value) => value.trim());
            return {
              headers: new Headers(),
              response: cookies.includes(nativeCookie)
                ? { session: { id: sessionId }, user: nativeUser }
                : null,
            };
          },
        },
      },
      workflowClient: {},
      prReviewGithubAppApi: {
        discoverInstallationBindingCandidates: async () => {
          discoveryCalls += 1;
          return [
            {
              installation: {
                installationId: 42,
                accountId: 77,
                accountLogin: "lens-owner",
                accountType: "User",
                suspended: false,
              },
              authorityKind: "personal_owner",
            },
          ];
        },
        authorizeInstallationBinding: async ({ installationId }: { installationId: number }) => {
          proofCalls += 1;
          return {
            actorId: 77,
            actorLogin: "lens-owner",
            authorityKind: "personal_owner",
            installation: {
              installationId,
              accountId: 77,
              accountLogin: "lens-owner",
              accountType: "User",
              suspended: false,
            },
            repositories: [
              {
                id: 1001,
                installationId,
                fullName: "lens-owner/repository",
                name: "repository",
                private: true,
                htmlUrl: "https://github.com/lens-owner/repository",
                cloneUrl: "https://github.com/lens-owner/repository.git",
                defaultBranch: "main",
                accountLogin: "lens-owner",
                accountType: "User",
              },
            ],
          };
        },
      },
    } as unknown as ApiRouteDeps);

    const setupResponse = await app.request(
      `http://test/v1/workspaces/${workspaceId}/pr-review/github`,
      { headers: { cookie: nativeCookie } },
    );
    expect(setupResponse.status).toBe(200);
    const setup = (await setupResponse.json()) as PrReviewManagedGitHubSetup;
    expect(setup).toMatchObject({ configured: true, status: "not_connected" });
    expect(setup.connectUrl).toBeTruthy();

    expect((await app.request(setup.connectUrl!)).status).toBe(401);
    const sourceState = new URL(setup.connectUrl!).searchParams.get("state")!;
    const connect = await app.request(setup.connectUrl!, { headers: { cookie: nativeCookie } });
    expect(connect.status).toBe(302);
    const discoveryState = new URL(connect.headers.get("location")!).searchParams.get("state")!;
    const discoveryCookie = browserHeader(connect);
    // Real browser navigation must mint fresh provider state rather than redeem
    // the initiation state known to an agent with a manually injected cookie.
    expect(discoveryState).not.toBe(sourceState);
    expect(readSignedState(discoveryState, stateSecret)?.nonce).not.toBe(
      readSignedState(sourceState, stateSecret)?.nonce,
    );
    expect(readSignedState(discoveryState, stateSecret)).toMatchObject({
      accountId,
      workspaceId,
      intent: "pr_review_github_discovery",
      initiatingSubjectId: subjectId,
    });

    const discoveryUrl = `http://test/v1/pr-review/github/oauth/callback?code=discover&state=${encodeURIComponent(discoveryState)}`;
    const flowCookie = discoveryCookie
      .split("; ")
      .filter((value) => value !== nativeCookie)
      .join("; ");
    expect((await app.request(discoveryUrl, { headers: { cookie: flowCookie } })).status).toBe(401);
    expect((await app.request(discoveryUrl, { headers: { cookie: nativeCookie } })).status).toBe(
      400,
    );
    const delegatedRequest = new Request(discoveryUrl, {
      headers: { cookie: discoveryCookie },
    });
    stampDelegatedHumanAuthorization(delegatedRequest, {
      organizationId: accountId,
      subjectId,
      permissions: ["workspace:admin", "secrets:write"],
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
    });
    expect((await app.fetch(delegatedRequest)).status).toBe(403);
    const legacyToken = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId,
      permissions: ["workspace:admin", "secrets:write"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 600,
    });
    expect(
      (
        await app.request(discoveryUrl, {
          headers: { cookie: discoveryCookie, authorization: `Bearer ${legacyToken}` },
        })
      ).status,
    ).toBe(403);
    expect(discoveryCalls).toBe(0);
    expect(proofCalls).toBe(0);

    const discovery = await app.request(discoveryUrl, { headers: { cookie: discoveryCookie } });
    expect(discovery.status).toBe(302);
    expect(discoveryCalls).toBe(1);
    const authorizationState = new URL(discovery.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const authorizationCookie = browserHeader(discovery);
    expect(readSignedState(authorizationState, stateSecret)).toMatchObject({
      accountId,
      workspaceId,
      installationId: 42,
      intent: "pr_review_github_oauth",
      initiatingSubjectId: subjectId,
    });

    const authorizationUrl =
      `http://test/v1/pr-review/github/oauth/callback?code=authorize&state=` +
      encodeURIComponent(authorizationState);
    const authorized = await app.request(authorizationUrl, {
      headers: { cookie: authorizationCookie },
    });
    expect(authorized.status).toBe(200);
    expect(proofCalls).toBe(1);
    expect(await authorized.text()).toContain("OpenGeni Lens connected");

    const registrations = await listPrReviewAppRegistrations(client.db, accountId, workspaceId);
    expect(registrations).toEqual([
      expect.objectContaining({
        credentialKind: "managed_github_app",
        installationId: "42",
        providerAccountLogin: "lens-owner",
        webhookPath: "/v1/webhooks/pr-review/github",
      }),
    ]);
    expect(await listPrReviewRepositoryBindings(client.db, accountId, workspaceId)).toEqual([
      expect.objectContaining({
        providerRepositoryId: "1001",
        repositoryFullName: "lens-owner/repository",
        status: "active",
      }),
    ]);

    const replay = await app.request(authorizationUrl, {
      headers: { cookie: authorizationCookie },
    });
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("authorization was already used");

    const payload = JSON.stringify({
      action: "closed",
      installation: { id: 42 },
      repository: { id: 1001 },
    });
    const rejected = await app.request("http://test/v1/webhooks/pr-review/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": crypto.randomUUID(),
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: payload,
    });
    expect(rejected.status).toBe(401);

    const accepted = await app.request("http://test/v1/webhooks/pr-review/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": crypto.randomUUID(),
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}`,
      },
      body: payload,
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: true, runIds: [] });

    const connected = (await (
      await app.request(`http://test/v1/workspaces/${workspaceId}/pr-review/github`, {
        headers: { cookie: nativeCookie },
      })
    ).json()) as PrReviewManagedGitHubSetup;
    expect(connected).toMatchObject({
      configured: true,
      status: "connected",
      installations: [expect.objectContaining({ accountLogin: "lens-owner", repositoryCount: 1 })],
    });
  }, 60_000);
});
