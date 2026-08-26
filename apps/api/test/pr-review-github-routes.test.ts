import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stableJson, type PrReviewManagedGitHubSetup } from "@opengeni/contracts";
import { getCapabilityPack, type ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  enablePackInstallation,
  listPrReviewAppRegistrations,
  listPrReviewRepositoryBindings,
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

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let workspaceId: string | null = null;
let accountId: string | null = null;
let subjectId: string | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("pr-review-github-routes");
  if (!shared) return;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:configured",
    accountExternalId: "default",
    accountName: "Configured",
    workspaceExternalSource: "opengeni:configured",
    workspaceExternalId: "default",
    workspaceName: "Configured",
    subjectId: "configured:key",
    subjectLabel: "Configured key",
  });
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  )!;
  workspaceId = grant.workspaceId;
  accountId = grant.accountId;
  subjectId = grant.subjectId;
  const pack = getCapabilityPack("pr-review");
  if (!pack) throw new Error("PR Review Pack is unavailable");
  await enablePackInstallation(client.db, {
    accountId,
    workspaceId,
    packId: pack.id,
    manifestSnapshot: pack,
    manifestDigest: createHash("sha256").update(stableJson(pack)).digest("hex"),
    installedBySubjectId: subjectId,
    metadata: {},
  });
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 180_000);

describe("OpenGeni Lens GitHub installation routes", () => {
  test("owner-proves one installation, consumes OAuth state once, and routes its signed webhook", async () => {
    if (!client || !workspaceId || !accountId || !subjectId) return;
    const app = new Hono();
    registerPrReviewGitHubRoutes(app, {
      db: client.db,
      settings: testSettings({
        productAccessMode: "configured",
        delegationSecret: undefined,
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
      workflowClient: {},
      prReviewGithubAppApi: {
        discoverInstallationBindingCandidates: async () => [
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
        ],
        authorizeInstallationBinding: async ({ installationId }) => ({
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
        }),
      },
    } as unknown as ApiRouteDeps);

    const setupResponse = await app.request(
      `http://test/v1/workspaces/${workspaceId}/pr-review/github`,
    );
    expect(setupResponse.status).toBe(200);
    const setup = (await setupResponse.json()) as PrReviewManagedGitHubSetup;
    expect(setup).toMatchObject({ configured: true, status: "not_connected" });
    expect(setup.connectUrl).toBeTruthy();

    const connect = await app.request(setup.connectUrl!);
    expect(connect.status).toBe(302);
    const discoveryState = new URL(connect.headers.get("location")!).searchParams.get("state")!;
    const discoveryCookie = connect.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(readSignedState(discoveryState, stateSecret)).toMatchObject({
      accountId,
      workspaceId,
      intent: "pr_review_github_discovery",
    });

    const discovery = await app.request(
      `http://test/v1/pr-review/github/oauth/callback?code=discover&state=${encodeURIComponent(discoveryState)}`,
      { headers: { cookie: discoveryCookie } },
    );
    expect(discovery.status).toBe(302);
    const authorizationState = new URL(discovery.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const authorizationCookie = discovery.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(readSignedState(authorizationState, stateSecret)).toMatchObject({
      accountId,
      workspaceId,
      installationId: 42,
      intent: "pr_review_github_oauth",
    });

    const authorizationUrl =
      `http://test/v1/pr-review/github/oauth/callback?code=authorize&state=` +
      encodeURIComponent(authorizationState);
    const authorized = await app.request(authorizationUrl, {
      headers: { cookie: authorizationCookie },
    });
    expect(authorized.status).toBe(200);
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
      await app.request(`http://test/v1/workspaces/${workspaceId}/pr-review/github`)
    ).json()) as PrReviewManagedGitHubSetup;
    expect(connected).toMatchObject({
      configured: true,
      status: "connected",
      installations: [expect.objectContaining({ accountLogin: "lens-owner", repositoryCount: 1 })],
    });
  }, 60_000);
});
