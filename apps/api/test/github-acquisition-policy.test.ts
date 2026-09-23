import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { Hono } from "hono";
import { OrganizationIntegrationDeniedError, type ConnectAttempt } from "@opengeni/contracts";
import { type ApiRouteDeps } from "@opengeni/core";
import {
  beginConnectAttempt,
  createDb,
  createWorkspace,
  getConnectAttempt,
  type DbClient,
  listGitHubInstallationAccessForWorkspace,
} from "@opengeni/db";
import { updateOrganizationIntegrationPolicy } from "@opengeni/db/organization-integration-policy";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createSignedState } from "@opengeni/github";
import { completeGitHubAppConnect } from "../src/integrations/github-app-connect";
import { registerGitHubRoutes } from "../src/routes/github";
import { registerPrReviewRoutes } from "../src/routes/pr-review";

let shared: SharedTestDatabase;
let client: DbClient;
const keyId = crypto.randomUUID();
const token = crypto.randomUUID();
const scope = { accountId: crypto.randomUUID(), workspaceId: "", subjectId: `api_key:${keyId}` };
let revision = 0;
const secret = "github-policy-fixture-state";
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) throw new Error("Set both policy fixture URLs");
  const acquired =
    adminUrl && appUrl
      ? {
          admin: postgres(adminUrl),
          adminUrl,
          appUrl,
          release: async () => {
            await shared.admin.end();
          },
        }
      : await acquireSharedTestDatabase("github-acquisition-policy");
  if (!acquired) throw new Error("GitHub policy tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  await shared.admin`insert into managed_accounts (id, name) values (${scope.accountId}, 'GitHub policy fixture')`;
  scope.workspaceId = (
    await createWorkspace(client.db, { accountId: scope.accountId, name: "Fixture" })
  ).id;
  await shared.admin`insert into api_keys (id, account_id, name, credential_kind, prefix, key_hash, permissions)
    values (${keyId}, ${scope.accountId}, 'Fixture', 'organization', 'test', ${createHash("sha256").update(token).digest("hex")}, '["workspace:admin","secrets:write","github:manage"]'::jsonb)`;
}, 180_000);
afterAll(async () => {
  if (shared) await shared.admin`delete from managed_accounts where id = ${scope.accountId}`;
  await client?.close();
  await shared?.release();
});
async function allow(keys: string[]) {
  revision = (
    await updateOrganizationIntegrationPolicy(
      client.db,
      scope,
      {
        mode: "restricted",
        allowedIntegrationKeys: keys,
        expectedRevision: revision,
        operationId: crypto.randomUUID(),
      },
      async () => scope,
    )
  ).revision;
}
function deps(discover: () => Promise<unknown>): ApiRouteDeps {
  return {
    db: client.db,
    githubStateSecret: secret,
    settings: testSettings({
      sandboxBackend: "none",
      environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
      productAccessMode: "managed",
      prReviewGithubAppId: "54321",
      prReviewGithubClientId: "fixture-client",
      prReviewGithubClientSecret: "fixture-secret",
      prReviewGithubAppSlug: "fixture-lens",
      prReviewGithubAppPrivateKey: "fixture-key",
      prReviewGithubWebhookSecret: "fixture-webhook",
    }),
    githubAppApi: { discoverInstallationBindingCandidates: discover },
    prReviewGithubAppApi: { discoverInstallationBindingCandidates: discover },
  } as unknown as ApiRouteDeps;
}

function routes(api: ApiRouteDeps) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof OrganizationIntegrationDeniedError)
      return c.json({ error: error.message }, 403);
    if ("getResponse" in error) return (error as { getResponse(): Response }).getResponse();
    throw error;
  });
  registerGitHubRoutes(app, api);
  registerPrReviewRoutes(app, api);
  return app;
}
const headers = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
for (const provider of ["github-app", "github-lens"] as const) {
  for (const boundary of ["preflight", "late policy", "late actor"] as const)
    test(`${provider} native callback ${boundary}`, async () => {
      const late = boundary !== "preflight";
      await allow(late ? [provider] : [provider === "github-app" ? "github-lens" : "github-app"]);
      let calls = 0;
      const api = deps(async () => []);
      const installationId = Math.floor(Math.random() * 100_000_000) + 1;
      const proof = async () => {
        calls++;
        if (boundary === "late policy") await allow([]);
        if (boundary === "late actor")
          await shared.admin`update api_keys set revoked_at = now() where id = ${keyId}`;
        return {
          actorId: 7,
          actorLogin: "fixture",
          authorityKind: "personal_owner" as const,
          installation: {
            installationId,
            accountId: 7,
            accountLogin: "fixture",
            accountType: "User",
            suspended: false,
          },
          repositories: [
            {
              id: installationId + 1,
              installationId,
              name: "repo",
              fullName: "fixture/repo",
              private: true,
              htmlUrl: "https://github.com/fixture/repo",
              cloneUrl: "https://github.com/fixture/repo.git",
              defaultBranch: "main",
              accountLogin: "fixture",
              accountType: "User",
            },
          ],
        };
      };
      api.githubAppApi = { authorizeInstallationBinding: proof } as never;
      api.prReviewGithubAppApi = { authorizeInstallationBinding: proof } as never;
      const state = createSignedState(secret, {
        ...scope,
        installationId,
        intent:
          provider === "github-app" ? "installation_authority_oauth" : "pr_review_github_oauth",
      });
      const cookie =
        provider === "github-app" ? "opengeni_github_state" : "opengeni_pr_review_github_state";
      const response = await routes(api).request(
        `/v1/${provider === "github-app" ? "github" : "pr-review/github"}/oauth/callback?code=fixture&state=${encodeURIComponent(state)}`,
        {
          headers: { ...headers(), cookie: `${cookie}=${state}` },
        },
      );
      // Restore this synthetic shared test actor before assertions so the
      // negative probe does not strand subsequent independent test cases.
      if (boundary === "late actor")
        await shared.admin`update api_keys set revoked_at = null where id = ${keyId}`;
      expect({
        status: response.status,
        body: response.status === 403 ? undefined : await response.text(),
        calls,
      }).toEqual({ status: 403, body: undefined, calls: late ? 1 : 0 });
      expect(calls).toBe(late ? 1 : 0);
      expect(await listGitHubInstallationAccessForWorkspace(client.db, scope.workspaceId)).toEqual(
        [],
      );
      const [registrations] =
        await shared.admin`select count(*)::int as count from pr_review_app_registrations where workspace_id = ${scope.workspaceId}`;
      expect(registrations!.count).toBe(0);
    });
}
for (const provider of ["github", "gitlab", "azure_devops"] as const)
  test(`manual ${provider} PR review registration uses explicit provider classification`, async () => {
    await allow(provider === "github" ? ["github-app"] : ["github-app", "github-lens"]);
    const response = await routes(deps(async () => [])).request(
      `/v1/workspaces/${scope.workspaceId}/pr-review/registrations`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name: crypto.randomUUID(),
          provider,
          providerBaseUrl:
            provider === "azure_devops" ? "https://dev.azure.com/fixture" : undefined,
          credentialKind: provider === "github" ? "github_app" : "provider_token",
          appId: provider === "github" ? "42" : undefined,
          privateKey: provider === "github" ? "fixture-private-key" : undefined,
          accessToken: provider === "github" ? undefined : "fixture-access-token",
          webhookSecret: "fixture-webhook-secret",
          webhookUsername: provider === "azure_devops" ? "fixture" : undefined,
        }),
      },
    );
    expect({
      status: response.status,
      body: response.status === 403 ? undefined : await response.text(),
    }).toEqual({ status: 403, body: undefined });
  });
async function begin(providerId: "github-app" | "github-lens") {
  const id = crypto.randomUUID();
  const state = createSignedState(secret, {
    kind: "github_app_connect",
    ...scope,
    personalOwnerVerified: false,
    connectAttemptId: id,
    phase: "discover",
    providerId,
  });
  const attempt: ConnectAttempt = {
    id,
    workspaceId: scope.workspaceId,
    providerId,
    ownership: "workspace",
    revision: 1,
    state: "requires_user_action",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "provider_setup",
    nextAction: {
      type: "authorize",
      url: `https://provider.example/authorize?state=${encodeURIComponent(state)}`,
    },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  await beginConnectAttempt(client.db, scope, {
    attempt,
    idempotencyKey: id,
    requestDigest: "a".repeat(64),
    returnUrl: "https://host.example/return",
  });
  return {
    id,
    state,
    expectedProvider: providerId,
    code: "fixture-code",
    requestUrl: "https://api.example/callback",
  };
}
for (const provider of ["github-app", "github-lens"] as const) {
  test(`${provider} denies before discovery and fences policy changed during provider work`, async () => {
    let calls = 0;
    const denied = await begin(provider);
    await allow([provider === "github-app" ? "github-lens" : "github-app"]);
    await completeGitHubAppConnect(
      deps(async () => {
        calls++;
        return [];
      }),
      denied,
    );
    expect(calls).toBe(0);
    expect((await getConnectAttempt(client.db, scope, denied.id)).attempt.revision).toBe(1);
    await allow([provider]);
    const late = await begin(provider);
    await completeGitHubAppConnect(
      deps(async () => {
        calls++;
        await allow([]);
        return [];
      }),
      late,
    );
    expect(calls).toBe(1);
    expect((await getConnectAttempt(client.db, scope, late.id)).attempt.revision).toBe(1);
    const [row] = await shared.admin`select receipts from connect_attempts where id = ${late.id}`;
    expect(row!.receipts).toEqual({});
    await allow([provider]);
    await completeGitHubAppConnect(
      deps(async () => {
        calls++;
        return [];
      }),
      late,
    );
    expect(calls).toBe(1);
    expect((await getConnectAttempt(client.db, scope, late.id)).attempt.revision).toBe(1);
  });
  test(`${provider} replays exact completed callback under denial but rejects revoked actor`, async () => {
    await allow([provider]);
    const input = await begin(provider);
    let calls = 0;
    const api = deps(async () => {
      calls++;
      return [];
    });
    await completeGitHubAppConnect(api, input);
    expect((await getConnectAttempt(client.db, scope, input.id)).attempt.revision).toBe(2);
    await allow([]);
    expect((await completeGitHubAppConnect(api, input)).status).toBe(302);
    expect(calls).toBe(1);
    await shared.admin`update api_keys set permissions = '[]'::jsonb where id = ${keyId}`;
    try {
      // A rejected callback must not disclose its authenticated return destination.
      expect((await completeGitHubAppConnect(api, input)).status).toBe(400);
      expect(calls).toBe(1);
    } finally {
      await shared.admin`update api_keys set permissions = '["workspace:admin","secrets:write","github:manage"]'::jsonb where id = ${keyId}`;
    }
  });
  test(`${provider} cancellation remains available under denial`, async () => {
    await allow([]);
    const input = await begin(provider);
    let calls = 0;
    await completeGitHubAppConnect(
      deps(async () => {
        calls++;
        return [];
      }),
      { ...input, error: "access_denied" },
    );
    expect((await getConnectAttempt(client.db, scope, input.id)).attempt.state).toBe("cancelled");
    expect(calls).toBe(0);
  });
}

test("manual GitHub repository preflight, late policy fence, allowed commit and reductions", async () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  await allow(["github-lens"]);
  const app = routes(deps(async () => []));
  const base = `/v1/workspaces/${scope.workspaceId}/pr-review`;
  const created = await app.request(`${base}/registrations`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: crypto.randomUUID(),
      provider: "github",
      credentialKind: "github_app",
      appId: "42",
      privateKey,
      webhookSecret: "fixture-webhook-secret",
    }),
  });
  expect(created.status).toBe(201);
  const registration = await created.json();
  let calls = 0;
  let restrict = false;
  let revokeActor = false;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    calls++;
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    if (url.pathname === "/app/installations")
      return Response.json([{ id: 42, account: { id: 7, login: "fixture", type: "User" } }]);
    if (url.pathname === "/app/installations/42/access_tokens")
      return Response.json({
        token: "fixture-installation-token",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    if (url.pathname === "/installation/repositories") {
      if (restrict) await allow([]);
      if (revokeActor)
        await shared.admin`update api_keys set revoked_at = now() where id = ${keyId}`;
      return Response.json({
        total_count: 1,
        repositories: [
          {
            id: 43,
            name: "repo",
            full_name: "fixture/repo",
            private: true,
            html_url: "https://github.com/fixture/repo",
            clone_url: "https://github.com/fixture/repo.git",
            default_branch: "main",
          },
        ],
      });
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  const bind = () =>
    app.request(`${base}/repositories`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        registrationId: registration.id,
        repositoryUri: "https://github.com/fixture/repo.git",
        repositoryFullName: "fixture/repo",
        providerRepositoryId: 43,
        installationId: 42,
      }),
    });
  try {
    await allow(["github-app"]);
    expect((await bind()).status).toBe(403);
    expect(calls).toBe(0);
    await allow(["github-lens"]);
    restrict = true;
    expect((await bind()).status).toBe(403);
    expect(calls).toBe(3);
    const [row] =
      await shared.admin`select count(*)::int as count from pr_review_repository_bindings where registration_id = ${registration.id}`;
    expect(row!.count).toBe(0);
    await allow(["github-lens"]);
    restrict = false;
    revokeActor = true;
    const revoked = await bind();
    await shared.admin`update api_keys set revoked_at = null where id = ${keyId}`;
    revokeActor = false;
    expect(revoked.status).toBe(403);
    const [afterRevocation] =
      await shared.admin`select count(*)::int as count from pr_review_repository_bindings where registration_id = ${registration.id}`;
    expect(afterRevocation!.count).toBe(0);
    const accepted = await bind();
    expect({
      status: accepted.status,
      body: accepted.status === 201 ? undefined : await accepted.text(),
    }).toEqual({ status: 201, body: undefined });
    const binding = await accepted.json();
    await allow([]);
    const unchanged = await app.request(`${base}/repositories/${binding.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status: binding.status }),
    });
    expect(unchanged.status).toBe(200);
    const disabled = await app.request(`${base}/repositories/${binding.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(disabled.status).toBe(200);
    expect(
      (
        await app.request(`${base}/repositories/${binding.id}`, {
          method: "DELETE",
          headers: headers(),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(`${base}/registrations/${registration.id}`, {
          method: "DELETE",
          headers: headers(),
        })
      ).status,
    ).toBe(204);
    expect(calls).toBe(9);
  } finally {
    await shared.admin`update api_keys set revoked_at = null where id = ${keyId}`;
    fetch.mockRestore();
  }
});
