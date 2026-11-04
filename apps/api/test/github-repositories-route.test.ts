// The web app reads the workspace's GitHub repositories on every load and
// window focus. A brief GitHub failure must not turn those passive reads into
// errors once a list is known, while an explicit sync still asks GitHub and
// reports its failure. The workspace allowlist always applies live.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Settings } from "@opengeni/config";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type GitHubRepository,
} from "@opengeni/contracts";
import {
  bindAuthorizedGitHubInstallationRepositories,
  createDb,
  deleteWorkspace,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { GitHubAppApiError } from "@opengeni/github";

import { createApp } from "../src/app";

const DELEGATION_SECRET = "github-repositories-delegation";
const EDGE_ACCESS_KEY = "github-repositories-edge";
const GITHUB_ACCOUNT_ID = 9101;

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;
const workspaceIds: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("github-repositories-route");
  if (!shared) {
    available = false;
    console.warn("[github-repositories-route] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    authRequired: true,
    accessKey: EDGE_ACCESS_KEY,
  });
}, 180_000);

afterAll(async () => {
  for (const workspaceId of workspaceIds) {
    await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function freshWorkspace() {
  const userId = `github-repositories-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "GitHub repositories user",
  });
  const workspaceId = access.defaultWorkspaceId!;
  const grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId)!;
  workspaceIds.push(...access.workspaceGrants.map((candidate) => candidate.workspaceId));
  return { accountId: grant.accountId, workspaceId, subjectId };
}

type Workspace = Awaited<ReturnType<typeof freshWorkspace>>;

async function bindRepositories(
  workspace: Workspace,
  input: { installationId: number; repositoryIds: number[] },
): Promise<void> {
  const now = new Date();
  const bound = await bindAuthorizedGitHubInstallationRepositories(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    installationId: input.installationId,
    githubAccountId: GITHUB_ACCOUNT_ID,
    accountLogin: "Cloudgeni-ai",
    accountType: "Organization",
    linkedBySubjectId: workspace.subjectId,
    githubActorId: 9102,
    githubActorLogin: "owner",
    authorityKind: "organization_owner",
    authorityCheckedAt: now,
    authorityExpiresAt: new Date(now.getTime() + 5 * 60_000),
    authorityNonce: `github-repositories-${crypto.randomUUID()}`,
    repositoryIds: input.repositoryIds,
    eventRouteSecret: null,
  });
  expect(bound).not.toBeNull();
}

function repository(id: number, installationId: number): GitHubRepository {
  return {
    id,
    installationId,
    fullName: `Cloudgeni-ai/repo-${id}`,
    name: `repo-${id}`,
    private: true,
    htmlUrl: `https://github.com/Cloudgeni-ai/repo-${id}`,
    cloneUrl: `https://github.com/Cloudgeni-ai/repo-${id}.git`,
    defaultBranch: "main",
    accountLogin: "Cloudgeni-ai",
    accountType: "Organization",
  };
}

/** A host GitHub App whose repository listing can be made to fail. */
function testApp(installationId: number, repositoryIds: number[]) {
  const github = {
    failing: false,
    failure: null as Error | null,
    listCalls: 0,
    repositoryIds,
  };
  const app = createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    githubAppApi: {
      getInstallation: async (input: { installationId: number }) => ({
        installationId: input.installationId,
        accountId: GITHUB_ACCOUNT_ID,
        accountLogin: "Cloudgeni-ai",
        accountType: "Organization",
        suspended: false,
      }),
      listRepositories: async () => {
        github.listCalls += 1;
        if (github.failure) throw github.failure;
        if (github.failing) throw new Error("GitHub answered 502 Bad Gateway");
        return github.repositoryIds.map((id) => repository(id, installationId));
      },
    },
  } as never);
  return { app, github };
}

async function headers(workspace: Workspace) {
  return {
    authorization: `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: workspace.subjectId,
      permissions: ["github:use", "workspace:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    })}`,
    "x-opengeni-access-key": EDGE_ACCESS_KEY,
    [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
  };
}

async function listedIds(response: Response): Promise<number[]> {
  const body = (await response.json()) as { repositories: GitHubRepository[] };
  return body.repositories.map((item) => item.id).sort((left, right) => left - right);
}

describe("workspace GitHub repositories", () => {
  test("a passive read survives a GitHub failure; a sync reports it", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await bindRepositories(workspace, { installationId: 501, repositoryIds: [1, 2] });
    const { app, github } = testApp(501, [1, 2, 3]);
    const list = `/v1/workspaces/${workspace.workspaceId}/github/repositories`;

    const first = await app.request(list, { headers: await headers(workspace) });
    expect(first.status).toBe(200);
    expect(await listedIds(first)).toEqual([1, 2]);

    github.failing = true;
    const passive = await app.request(list, { headers: await headers(workspace) });
    expect(passive.status).toBe(200);
    expect(await listedIds(passive)).toEqual([1, 2]);

    const callsBeforeSync = github.listCalls;
    const sync = await app.request(`${list}/sync`, {
      method: "POST",
      headers: await headers(workspace),
    });
    expect(sync.status).toBe(502);
    expect(github.listCalls).toBe(callsBeforeSync + 1);
  }, 60_000);

  test("an allowlist change applies to a cached list immediately", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await bindRepositories(workspace, { installationId: 502, repositoryIds: [11] });
    const { app } = testApp(502, [11, 12]);
    const list = `/v1/workspaces/${workspace.workspaceId}/github/repositories`;

    expect(await listedIds(await app.request(list, { headers: await headers(workspace) }))).toEqual(
      [11],
    );
    await bindRepositories(workspace, { installationId: 502, repositoryIds: [12] });
    expect(await listedIds(await app.request(list, { headers: await headers(workspace) }))).toEqual(
      [12],
    );
  }, 60_000);

  test("a reconnect shows a repository just shared on GitHub, even from a cached process", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await bindRepositories(workspace, { installationId: 504, repositoryIds: [31] });
    const { app, github } = testApp(504, [31]);
    const list = `/v1/workspaces/${workspace.workspaceId}/github/repositories`;

    expect(await listedIds(await app.request(list, { headers: await headers(workspace) }))).toEqual(
      [31],
    );
    // The person shares repo 32 on GitHub and reconnects (possibly through
    // another API replica); this process still holds the older list.
    github.repositoryIds = [31, 32];
    await Bun.sleep(5);
    await bindRepositories(workspace, { installationId: 504, repositoryIds: [31, 32] });
    expect(await listedIds(await app.request(list, { headers: await headers(workspace) }))).toEqual(
      [31, 32],
    );
    expect(github.listCalls).toBe(2);
    // Later passive reads use the new list.
    await app.request(list, { headers: await headers(workspace) });
    expect(github.listCalls).toBe(2);
  }, 60_000);

  test("GitHub refusing the installation is a 409 to reconnect, not a retryable 502", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await bindRepositories(workspace, { installationId: 505, repositoryIds: [41] });
    const { app, github } = testApp(505, [41]);
    const list = `/v1/workspaces/${workspace.workspaceId}/github/repositories`;

    github.failure = new GitHubAppApiError("Not Found", 404);
    const passive = await app.request(list, { headers: await headers(workspace) });
    expect(passive.status).toBe(409);
    const sync = await app.request(`${list}/sync`, {
      method: "POST",
      headers: await headers(workspace),
    });
    expect(sync.status).toBe(409);

    // A GitHub outage stays a 502 that clients may retry.
    github.failure = new GitHubAppApiError("Bad Gateway", 502);
    const outage = await app.request(`${list}/sync`, {
      method: "POST",
      headers: await headers(workspace),
    });
    expect(outage.status).toBe(502);
  }, 60_000);
});
