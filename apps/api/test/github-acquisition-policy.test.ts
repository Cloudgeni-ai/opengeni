import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createSignedState } from "@opengeni/github";
import { completeGitHubAppConnect } from "../src/integrations/github-app-connect";
import { registerGitHubRoutes } from "../src/routes/github";

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
    }),
    githubAppApi: { discoverInstallationBindingCandidates: discover },
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
  return app;
}
const headers = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
{
  const provider = "github-app";
  for (const boundary of ["preflight", "late policy", "late actor"] as const)
    test(`${provider} native callback ${boundary}`, async () => {
      const late = boundary !== "preflight";
      await allow(late ? [provider] : []);
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
      const state = createSignedState(secret, {
        ...scope,
        installationId,
        intent: "installation_authority_oauth",
      });
      const cookie = "opengeni_github_state";
      const response = await routes(api).request(
        `/v1/github/oauth/callback?code=fixture&state=${encodeURIComponent(state)}`,
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
    });
}
async function begin(providerId: "github-app") {
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
    code: "fixture-code",
    requestUrl: "https://api.example/callback",
  };
}
{
  const provider = "github-app";
  test(`${provider} denies before discovery and fences policy changed during provider work`, async () => {
    let calls = 0;
    const denied = await begin(provider);
    await allow([]);
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
