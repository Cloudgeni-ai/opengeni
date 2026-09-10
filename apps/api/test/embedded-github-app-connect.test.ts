import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  enablePackInstallation,
  listPrReviewAppRegistrations,
  listPrReviewRepositoryBindings,
  listGitHubInstallationAccessForWorkspace,
  type DbClient,
} from "@opengeni/db";
import { getCapabilityPack } from "@opengeni/core";
import { grantWorkspaceAccess, withWorkspaceSubjectRls } from "@opengeni/db";
import { stableJson } from "@opengeni/contracts";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
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

for (const providerId of ["github-app", "github-lens"] as const)
  test(`${providerId} Connect chooses an installation in the host and commits only fresh owner proof`, async () => {
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
    const workspaceId =
      providerId === "github-lens" ? grant.workspaceId : identity.personalWorkspaceId;
    if (providerId === "github-lens") {
      await withWorkspaceSubjectRls(client.db, workspaceId, grant.subjectId, (tx) =>
        grantWorkspaceAccess(tx, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: identity.subjectId,
          permissions: ["workspace:admin", "secrets:write"],
        }),
      );
      const pack = getCapabilityPack("pr-review")!;
      await enablePackInstallation(client.db, {
        accountId: grant.accountId,
        workspaceId,
        packId: pack.id,
        manifestSnapshot: pack,
        manifestDigest: createHash("sha256").update(stableJson(pack)).digest("hex"),
        installedBySubjectId: identity.subjectId,
        metadata: {},
      });
    }
    const token = randomBytes(24).toString("hex");
    await createOrganizationApiKey(client.db, {
      accountId: grant.accountId,
      name: "Fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions:
        providerId === "github-lens"
          ? ["workspace:read", "workspace:admin", "secrets:write"]
          : ["workspace:read", "github:manage", "github:use"],
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
        prReviewGithubAppId: "54321",
        prReviewGithubClientId: "lens-client",
        prReviewGithubClientSecret: "lens-secret",
        prReviewGithubAppSlug: "fixture-lens",
        prReviewGithubAppPrivateKey: "fixture-private-key",
        prReviewGithubWebhookSecret: "fixture-webhook-secret",
        githubAppId: "12345",
        githubClientId: "fixture-client",
        githubClientSecret: "fixture-secret",
        githubAppSlug: "fixture-app",
        githubAppPrivateKey: "fixture-private-key",
      }),
      [providerId === "github-lens" ? "prReviewGithubAppApi" : "githubAppApi"]: {
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
        `${providerId === "github-lens" ? "/v1/pr-review/github/oauth/callback" : "/v1/github/oauth/callback"}?${new URLSearchParams({ state: new URL(url).searchParams.get("state")!, code: "fixture-code" })}`,
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
        action: { type: "account", accountId: String(installationId) },
      }),
    });
    expect(selection.status).toBe(200);
    const binding = await selection.json();
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
    expect(await forged.text()).not.toContain("OpenGeni");
    expect(await listGitHubInstallationAccessForWorkspace(client.db, workspaceId)).toHaveLength(
      providerId === "github-app" ? 1 : 0,
    );
    if (providerId === "github-lens") {
      expect(
        await listPrReviewAppRegistrations(client.db, grant.accountId, workspaceId),
      ).toHaveLength(1);
      expect(
        await listPrReviewRepositoryBindings(client.db, grant.accountId, workspaceId),
      ).toHaveLength(1);
    }
  });
