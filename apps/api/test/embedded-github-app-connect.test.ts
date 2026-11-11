import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bindAuthorizedGitHubInstallationRepositories,
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  listConnectorActionPolicies,
  listGitHubInstallationAccessForWorkspace,
  upsertConnectorActionPolicies,
  type DbClient,
} from "@opengeni/db";

import { createSignedState, readSignedState } from "@opengeni/github";
import { GITHUB_REST_MCP_APP_SERVER_ID } from "@opengeni/runtime/github-rest-mcp";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

let fixture: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("embedded-github-app-connect");
  if (!acquired) throw new Error("PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

const providerId = "github-app";
for (const newInstallation of [false, true])
  test(`${providerId} Connect ${newInstallation ? "installs a new" : "chooses an existing"} account and commits only fresh owner proof`, async () => {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: randomUUID(),
      accountName: "App fixture",
      workspaceExternalSource: "test",
      workspaceExternalId: randomUUID(),
      workspaceName: "Fixture",
      subjectId: `user:${randomUUID()}`,
    });
    const grant = access.workspaceGrants[0]!;
    workspaces.push(grant.workspaceId);
    const identity = await ensureExternalIdentity(client.db, {
      accountId: grant.accountId,
      externalId: "app-owner",
    });
    const workspaceId = identity.personalWorkspaceId;
    const token = randomBytes(24).toString("hex");
    await createOrganizationApiKey(client.db, {
      accountId: grant.accountId,
      name: "Fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:read", "github:manage", "github:use"],
    });
    const installationId = Math.floor(Math.random() * 100_000_000) + 1;
    const installation = {
      installationId,
      accountId: installationId + 1,
      accountLogin: "fixture-owner",
      accountType: "User",
      suspended: false,
    };
    let discovery = 0;
    let proofs = 0;
    const app = createApp({
      githubStateSecret: "embedded-app-state",
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
      settings: testSettings({
        productAccessMode: "managed",
        integrationsEnabled: true,
        publicBaseUrl: "https://opengeni.example.test",
        environmentsEncryptionKey: randomBytes(32).toString("base64"),
        integrationsStateSecret: "embedded-github-app-fixture",
        sandboxBackend: "none",
        githubAppId: "12345",
        githubClientId: "fixture-client",
        githubClientSecret: "fixture-secret",
        githubAppSlug: "fixture-app",
        githubAppPrivateKey: "fixture-private-key",
      }),
      githubAppApi: {
        discoverInstallationBindingCandidates: async () => {
          discovery++;
          return [{ installation, authorityKind: "personal_owner" }];
        },
        authorizeInstallationBinding: async () => {
          proofs++;
          return {
            installation,
            authorityKind: "personal_owner",
            actorId: installation.accountId,
            actorLogin: installation.accountLogin,
            repositories: [
              {
                id: installationId + 2,
                installationId,
                name: "repo",
                fullName: "fixture-owner/repo",
                private: true,
                htmlUrl: "https://github.com/fixture-owner/repo",
                cloneUrl: "https://github.com/fixture-owner/repo.git",
                defaultBranch: "main",
                accountLogin: installation.accountLogin,
                accountType: "User",
              },
            ],
          };
        },
      },
    } as never);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
      ),
    };
    const base = `/v1/workspaces/${workspaceId}/connect/attempts`;
    const returnUrl = "https://HOST.example:443/settings?opaque=%2f#App";
    const started = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId,
        ownership: "workspace",
        returnUrl,
        idempotencyKey: randomUUID(),
      }),
    });
    expect({
      status: started.status,
      ...(started.status !== 200 ? { error: await started.clone().text() } : {}),
    }).toEqual({ status: 200 });
    const attempt = await started.json();
    const callback = (url: string) =>
      app.request(
        `/v1/github/oauth/callback?${new URLSearchParams({ state: new URL(url).searchParams.get("state")!, code: "fixture-code" })}`,
      );
    expect((await callback(attempt.nextAction.url)).headers.get("location")).toBe(returnUrl);
    expect((await callback(attempt.nextAction.url)).headers.get("location")).toBe(returnUrl);
    expect(discovery).toBe(1);
    const selected = await (await app.request(`${base}/${attempt.id}`, { headers })).json();
    expect(selected).toMatchObject({
      state: "account_selection",
      nextAction: { type: "select_account" },
    });
    expect(
      await listGitHubInstallationAccessForWorkspace(client.db, identity.personalWorkspaceId),
    ).toEqual([]);
    const selection = await app.request(`${base}/${attempt.id}/advance`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: selected.revision,
        idempotencyKey: randomUUID(),
        action: { type: "account", accountId: newInstallation ? "new" : String(installationId) },
      }),
    });
    expect(selection.status).toBe(200);
    let binding = await selection.json();
    if (newInstallation) {
      const state = new URL(binding.nextAction.url).searchParams.get("state")!;
      const installCallback = `/v1/github/install/callback?${new URLSearchParams({ state, installation_id: String(installationId), setup_action: "install" })}`;
      const installed = await app.request(installCallback);
      binding = await (await app.request(`${base}/${attempt.id}`, { headers })).json();
      expect(binding.state).toBe("requires_user_action");
      expect(binding.nextAction.type).toBe("authorize");
      expect(installed.headers.get("location")).toBe(binding.nextAction.url);
      expect((await app.request(installCallback)).headers.get("location")).toBe(
        binding.nextAction.url,
      );
      expect(new URL(installed.headers.get("location")!).pathname).toBe("/login/oauth/authorize");
      expect(proofs).toBe(0);
    }
    // Two signed browser stages may coexist. An obsolete unconsumed stage must
    // not acquire a durable claim and strand the current authorization stage.
    const supersededState = createSignedState("embedded-app-state", {
      ...readSignedState(
        new URL(binding.nextAction.url).searchParams.get("state")!,
        "embedded-app-state",
      ),
      nonce: randomUUID(),
    });
    const supersededUrl = new URL(binding.nextAction.url);
    supersededUrl.searchParams.set("state", supersededState);
    expect((await callback(supersededUrl.toString())).headers.get("location")).toBe(returnUrl);
    expect(await (await app.request(`${base}/${attempt.id}`, { headers })).json()).toEqual(binding);
    expect(proofs).toBe(0);
    expect((await callback(binding.nextAction.url)).headers.get("location")).toBe(returnUrl);
    expect(await (await app.request(`${base}/${attempt.id}`, { headers })).json()).toMatchObject({
      state: "complete",
      completionRequirement: "provider_setup",
      credentialsCommitted: false,
      account: { providerId },
    });
    expect((await callback(binding.nextAction.url)).headers.get("location")).toBe(returnUrl);
    expect(proofs).toBe(1);
    const expiredPayload = {
      accountId: grant.accountId,
      workspaceId,
      subjectId: identity.subjectId,
      connectAttemptId: attempt.id,
      kind: "github_app_connect",
      providerId,
      phase: "bind",
      personalOwnerVerified: true,
    };
    const expiredState = createSignedState(
      "embedded-app-state",
      expiredPayload,
      Math.floor(Date.now() / 1000) - 7200,
    );
    const expiredUrl = `https://provider.example/authorize?state=${encodeURIComponent(expiredState)}`;
    expect((await callback(expiredUrl)).headers.get("location")).toBe(returnUrl);
    expect(proofs).toBe(1);
    const staleState = createSignedState(
      "embedded-app-state",
      expiredPayload,
      Math.floor(Date.now() / 1000) - 25 * 60 * 60,
    );
    const stale = await callback(
      `https://provider.example/authorize?state=${encodeURIComponent(staleState)}`,
    );
    expect(stale.status).toBe(400);
    expect(stale.headers.get("location")).toBeNull();
    expect(proofs).toBe(1);
    const forgedState = createSignedState("wrong-secret", expiredPayload);
    const forged = await callback(
      `https://provider.example/authorize?state=${encodeURIComponent(forgedState)}`,
    );
    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();
    expect(await forged.text()).not.toContain("Opengeni");
    expect(await listGitHubInstallationAccessForWorkspace(client.db, workspaceId)).toHaveLength(1);
  });

test(`${providerId} repair starts at the named installation's fix, and a reinstall replaces it`, async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Repair fixture",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "repair-owner",
  });
  const workspaceId = identity.personalWorkspaceId;
  const token = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:read", "github:manage", "github:use"],
  });
  const uninstalledId = Math.floor(Math.random() * 100_000_000) + 1;
  const reinstalledId = uninstalledId + 1;
  const owner = { accountId: uninstalledId + 1_000, accountLogin: "benyhh", accountType: "User" };
  const checkedAt = new Date();
  await bindAuthorizedGitHubInstallationRepositories(client.db, {
    accountId: grant.accountId,
    workspaceId,
    installationId: uninstalledId,
    githubAccountId: owner.accountId,
    accountLogin: owner.accountLogin,
    accountType: owner.accountType,
    linkedBySubjectId: identity.subjectId,
    githubActorId: owner.accountId,
    githubActorLogin: owner.accountLogin,
    authorityKind: "personal_owner",
    authorityCheckedAt: checkedAt,
    authorityExpiresAt: new Date(checkedAt.getTime() + 5 * 60_000),
    authorityNonce: `repair-${randomUUID()}`,
    repositoryIds: [uninstalledId + 2],
    eventRouteSecret: null,
  });
  // Reviews and merges ask first on the installation being repaired. The
  // reinstalled one already blocks merges (chosen before this repair).
  const approval = (installationId: number, toolName: string, decision: "ask" | "block") => ({
    accountId: grant.accountId,
    workspaceId,
    subjectId: identity.subjectId,
    connectionId: `github-app:${installationId}`,
    serverId: GITHUB_REST_MCP_APP_SERVER_ID,
    toolName,
    actionName: toolName,
    policy: decision,
  });
  await upsertConnectorActionPolicies(client.db, [
    approval(uninstalledId, "pull_request_merge", "ask"),
    approval(uninstalledId, "pull_request_review_submit", "ask"),
  ]);
  await upsertConnectorActionPolicies(client.db, [
    approval(reinstalledId, "pull_request_merge", "block"),
  ]);
  let discovery = 0;
  let githubDown = false;
  const proofs: number[] = [];
  const app = createApp({
    githubStateSecret: "embedded-app-state",
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings: testSettings({
      productAccessMode: "managed",
      integrationsEnabled: true,
      publicBaseUrl: "https://opengeni.example.test",
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
      integrationsStateSecret: "embedded-github-app-fixture",
      sandboxBackend: "none",
      githubAppId: "12345",
      githubClientId: "fixture-client",
      githubClientSecret: "fixture-secret",
      githubAppSlug: "fixture-app",
      githubAppPrivateKey: "fixture-private-key",
    }),
    githubAppApi: {
      // GitHub no longer has the first installation: it was uninstalled.
      getInstallation: async ({ installationId }: { installationId: number }) => {
        if (githubDown) throw new Error("GitHub is unavailable");
        return installationId === uninstalledId
          ? null
          : { installationId, accountId: owner.accountId, suspended: false };
      },
      discoverInstallationBindingCandidates: async () => {
        discovery++;
        return [];
      },
      authorizeInstallationBinding: async ({ installationId }: { installationId: number }) => {
        proofs.push(installationId);
        return {
          installation: { installationId, ...owner, suspended: false },
          authorityKind: "personal_owner",
          actorId: owner.accountId,
          actorLogin: owner.accountLogin,
          repositories: [
            {
              id: reinstalledId + 2,
              installationId,
              name: "repo",
              fullName: "benyhh/repo",
              private: true,
              htmlUrl: "https://github.com/benyhh/repo",
              cloneUrl: "https://github.com/benyhh/repo.git",
              defaultBranch: "main",
              accountLogin: owner.accountLogin,
              accountType: owner.accountType,
            },
          ],
        };
      },
    },
  } as never);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${workspaceId}/connect/attempts`;
  const returnUrl = "https://app.example.test/integrations/github";
  const begin = (reconnectAccountId: string) =>
    app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId,
        ownership: "workspace",
        returnUrl,
        idempotencyKey: randomUUID(),
        reconnectAccountId,
      }),
    });
  const stateOf = (url: string) =>
    readSignedState(new URL(url).searchParams.get("state")!, "embedded-app-state") as Record<
      string,
      unknown
    >;

  // Uninstalled: straight to installing the app again, no account chooser.
  const started = await begin(`github-installation:${uninstalledId}`);
  expect({
    status: started.status,
    ...(started.status !== 200 ? { error: await started.clone().text() } : {}),
  }).toEqual({ status: 200 });
  const attempt = await started.json();
  expect(attempt.account).toMatchObject({
    id: `github-installation:${uninstalledId}`,
    label: "benyhh",
    status: "auth_needed",
  });
  expect(new URL(attempt.nextAction.url).pathname).toBe("/apps/fixture-app/installations/new");
  expect(stateOf(attempt.nextAction.url)).toMatchObject({ phase: "install" });
  const installed = await app.request(
    `/v1/github/install/callback?${new URLSearchParams({
      state: new URL(attempt.nextAction.url).searchParams.get("state")!,
      installation_id: String(reinstalledId),
      setup_action: "install",
    })}`,
  );
  const ownerSignIn = installed.headers.get("location")!;
  expect(new URL(ownerSignIn).pathname).toBe("/login/oauth/authorize");
  expect(stateOf(ownerSignIn)).toMatchObject({ phase: "bind", installationId: reinstalledId });
  const signedIn = await app.request(
    `/v1/github/oauth/callback?${new URLSearchParams({
      state: new URL(ownerSignIn).searchParams.get("state")!,
      code: "fixture-code",
    })}`,
  );
  expect(signedIn.headers.get("location")).toBe(returnUrl);
  expect(await (await app.request(`${base}/${attempt.id}`, { headers })).json()).toMatchObject({
    state: "complete",
    account: { id: `github-installation:${reinstalledId}`, status: "connected" },
  });
  // The reinstall replaced the binding it repaired.
  expect(
    (await listGitHubInstallationAccessForWorkspace(client.db, workspaceId)).map(
      (binding) => binding.installationId,
    ),
  ).toEqual([reinstalledId]);
  // Its approvals carried over, without overriding a choice already made
  // on the new installation.
  expect(
    (
      await listConnectorActionPolicies(client.db, {
        accountId: grant.accountId,
        workspaceId,
        connectionIds: [`github-app:${reinstalledId}`],
      })
    )
      .map(({ toolName, policy }) => ({ toolName, policy }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName)),
  ).toEqual([
    { toolName: "pull_request_merge", policy: "block" },
    { toolName: "pull_request_review_submit", policy: "ask" },
  ]);

  // Installed: straight to that installation's owner sign-in.
  const authorizing = await (await begin(`github-installation:${reinstalledId}`)).json();
  expect(new URL(authorizing.nextAction.url).pathname).toBe("/login/oauth/authorize");
  expect(stateOf(authorizing.nextAction.url)).toMatchObject({
    phase: "bind",
    installationId: reinstalledId,
  });
  expect(discovery).toBe(0);
  expect(proofs).toEqual([reinstalledId]);

  // GitHub didn't answer: the account chooser covers either fix.
  githubDown = true;
  const unknown = await (await begin(`github-installation:${reinstalledId}`)).json();
  expect(stateOf(unknown.nextAction.url)).toMatchObject({ phase: "discover" });
  expect(unknown.account).toMatchObject({ id: `github-installation:${reinstalledId}` });
  githubDown = false;

  // Only a linked installation can be repaired.
  expect((await begin(`github-installation:${uninstalledId}`)).status).toBe(409);
  expect((await begin("github-installation:abc")).status).toBe(422);
});
