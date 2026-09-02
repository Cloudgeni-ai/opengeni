import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Settings } from "@opengeni/config";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type GitHubAppRepositoryBranchPage,
} from "@opengeni/contracts";
import {
  bindAuthorizedGitHubInstallationRepositories,
  createDb,
  deleteWorkspace,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { createApp } from "../src/app";

const DELEGATION_SECRET = "github-branches-delegation";
const EDGE_ACCESS_KEY = "github-branches-edge";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;
const workspaceIds: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("github-branches");
  if (!shared) {
    available = false;
    console.warn("[github-branches] docker unavailable, skipping");
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
  const userId = `github-branches-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "GitHub branch user",
  });
  const workspaceId = access.defaultWorkspaceId!;
  const grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId)!;
  workspaceIds.push(...access.workspaceGrants.map((candidate) => candidate.workspaceId));
  return { accountId: grant.accountId, workspaceId, subjectId };
}

async function bearer(workspace: Awaited<ReturnType<typeof freshWorkspace>>): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    permissions: ["github:use", "workspace:read"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

async function bindRepository(
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  input: { installationId: number; repositoryIds: number[] },
): Promise<void> {
  const now = new Date();
  const bound = await bindAuthorizedGitHubInstallationRepositories(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    installationId: input.installationId,
    githubAccountId: 9001,
    accountLogin: "Cloudgeni-ai",
    accountType: "Organization",
    linkedBySubjectId: workspace.subjectId,
    githubActorId: 9002,
    githubActorLogin: "owner",
    authorityKind: "organization_owner",
    authorityCheckedAt: now,
    authorityExpiresAt: new Date(now.getTime() + 5 * 60_000),
    authorityNonce: `github-branches-${crypto.randomUUID()}`,
    repositoryIds: input.repositoryIds,
  });
  expect(bound).not.toBeNull();
}

function testApp(
  listRepositoryBranches: (input: {
    installationId: number;
    repositoryId: number;
    page: number;
    limit: number;
  }) => Promise<GitHubAppRepositoryBranchPage>,
) {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    githubAppApi: { listRepositoryBranches },
  } as never);
}

async function headers(workspace: Awaited<ReturnType<typeof freshWorkspace>>) {
  return {
    authorization: await bearer(workspace),
    "x-opengeni-access-key": EDGE_ACCESS_KEY,
    [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
  };
}

describe("authenticated GitHub App branch routes", () => {
  test("lists only one exact allowlisted repository with bounded pagination", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await bindRepository(workspace, { installationId: 42, repositoryIds: [1001] });
    const providerInputs: unknown[] = [];
    const app = testApp(async (input) => {
      providerInputs.push(input);
      return {
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        defaultBranch: "main",
        branches: ["feature/picker", "main"],
        nextPage: 3,
      };
    });
    const response = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/github/installations/42/repositories/1001/branches?cursor=2&limit=2`,
      { headers: await headers(workspace) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      branches: [
        { name: "feature/picker", isDefault: false },
        { name: "main", isDefault: true },
      ],
      nextCursor: 3,
    });
    expect(providerInputs).toEqual([{ installationId: 42, repositoryId: 1001, page: 2, limit: 2 }]);

    const denied = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/github/installations/42/repositories/1002/branches`,
      { headers: await headers(workspace) },
    );
    expect(denied.status).toBe(404);
    expect(providerInputs).toHaveLength(1);
  }, 60_000);

  test("discards provider results when the exact allowlist changes in flight", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await bindRepository(workspace, { installationId: 43, repositoryIds: [1101] });
    const app = testApp(async (input) => {
      await bindRepository(workspace, { installationId: 43, repositoryIds: [1102] });
      return {
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        defaultBranch: "main",
        branches: ["main"],
        nextPage: null,
      };
    });
    const response = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/github/installations/43/repositories/1101/branches`,
      { headers: await headers(workspace) },
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("authorization changed");
  }, 60_000);
});
