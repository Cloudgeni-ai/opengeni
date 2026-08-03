import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  areGitHubRepositoriesAllowedForWorkspace,
  bindAuthorizedGitHubInstallationRepositories,
  bindGitHubInstallationRepositories,
  createDb,
  GitHubInstallationAuthorityCommitError,
  hasAuditableGitHubInstallationAuthority,
  listGitHubInstallationAccessForWorkspace,
  type Database,
  type DbClient,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("github-installation-authority");
  if (!shared) {
    available = false;
    console.warn("[github-installation-authority] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("GitHub installation owner-authority persistence", () => {
  test("consumes one proof once under concurrency and enforces its exact allowlist", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const input = authorityInput(workspace, {
      installationId: 7001,
      authorityNonce: `concurrent-${crypto.randomUUID()}`,
      repositoryIds: [7101],
    });

    const results = await Promise.all([
      bindAuthorizedGitHubInstallationRepositories(db, input),
      bindAuthorizedGitHubInstallationRepositories(db, input),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);

    const [stored] = await listGitHubInstallationAccessForWorkspace(db, workspace.workspaceId);
    expect(stored).toMatchObject({
      installationId: 7001,
      githubAccountId: 9001,
      githubActorId: 9001,
      authorityKind: "personal_owner",
      repositoryScope: "selected",
      repositoryIds: [7101],
    });
    expect(hasAuditableGitHubInstallationAuthority(stored!)).toBe(true);
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(db, workspace.workspaceId, 7001, [7101]),
    ).toBe(true);
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(db, workspace.workspaceId, 7001, [7102]),
    ).toBe(false);
  });

  test("isolates one installation into independent workspace allowlists and rejects cross-workspace replay", async () => {
    if (!available) return;
    const first = await freshWorkspace();
    const second = await freshWorkspace(first.accountId);
    const installationId = 7002;
    const firstNonce = `first-${crypto.randomUUID()}`;

    expect(
      await bindAuthorizedGitHubInstallationRepositories(
        db,
        authorityInput(first, {
          installationId,
          authorityNonce: firstNonce,
          repositoryIds: [7201],
        }),
      ),
    ).not.toBeNull();
    expect(
      await bindAuthorizedGitHubInstallationRepositories(
        db,
        authorityInput(second, {
          installationId,
          authorityNonce: `second-${crypto.randomUUID()}`,
          repositoryIds: [7202],
          authorityKind: "organization_owner",
          accountType: "Organization",
          githubAccountId: 9002,
          githubActorId: 9003,
        }),
      ),
    ).not.toBeNull();

    expect(
      await areGitHubRepositoriesAllowedForWorkspace(db, first.workspaceId, installationId, [7201]),
    ).toBe(true);
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(db, first.workspaceId, installationId, [7202]),
    ).toBe(false);
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(
        db,
        second.workspaceId,
        installationId,
        [7202],
      ),
    ).toBe(true);
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(
        db,
        second.workspaceId,
        installationId,
        [7201],
      ),
    ).toBe(false);

    const replay = await bindAuthorizedGitHubInstallationRepositories(
      db,
      authorityInput(second, {
        installationId: 7003,
        authorityNonce: firstNonce,
        repositoryIds: [7301],
      }),
    );
    expect(replay).toBeNull();
    expect(
      (await listGitHubInstallationAccessForWorkspace(db, second.workspaceId)).some(
        (binding) => binding.installationId === 7003,
      ),
    ).toBe(false);
  });

  test("rolls back expired or future-dated proof windows at the database clock", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const expired = authorityInput(workspace, {
      installationId: 7004,
      authorityNonce: `expired-${crypto.randomUUID()}`,
      repositoryIds: [7401],
      authorityCheckedAt: new Date(Date.now() - 120_000),
      authorityExpiresAt: new Date(Date.now() - 60_000),
    });
    await expect(bindAuthorizedGitHubInstallationRepositories(db, expired)).rejects.toBeInstanceOf(
      GitHubInstallationAuthorityCommitError,
    );

    const future = authorityInput(workspace, {
      installationId: 7005,
      authorityNonce: `future-${crypto.randomUUID()}`,
      repositoryIds: [7501],
      authorityCheckedAt: new Date(Date.now() + 60_000),
      authorityExpiresAt: new Date(Date.now() + 120_000),
    });
    await expect(bindAuthorizedGitHubInstallationRepositories(db, future)).rejects.toBeInstanceOf(
      GitHubInstallationAuthorityCommitError,
    );

    const oversized = authorityInput(workspace, {
      installationId: 7007,
      authorityNonce: `oversized-${crypto.randomUUID()}`,
      repositoryIds: [7701],
      authorityCheckedAt: new Date(),
      authorityExpiresAt: new Date(Date.now() + 10 * 60_000 + 1_000),
    });
    await expect(bindAuthorizedGitHubInstallationRepositories(db, oversized)).rejects.toThrow(
      "authority proof is invalid or expired",
    );
    expect(await listGitHubInstallationAccessForWorkspace(db, workspace.workspaceId)).toEqual([]);
  });

  test("rejects partially populated authority tuples at the database boundary", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    let postgresCode: string | undefined;
    try {
      await admin`
        INSERT INTO github_installations (
          account_id,
          workspace_id,
          installation_id,
          github_account_id,
          account_login,
          account_type,
          repository_scope,
          linked_by_subject_id
        ) VALUES (
          ${workspace.accountId},
          ${workspace.workspaceId},
          7008,
          9008,
          'owner',
          'User',
          'selected',
          'opengeni-subject'
        )
      `;
    } catch (error) {
      postgresCode = (error as { code?: string }).code;
    }
    expect(postgresCode).toBe("23514");
  });

  test("keeps legacy rows untrusted and prevents legacy helpers from mutating an audited binding", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installationId = 7006;
    await bindGitHubInstallationRepositories(db, {
      ...workspace,
      installationId,
      accountLogin: "legacy-owner",
      accountType: "User",
      linkedBySubjectId: "legacy-subject",
      repositoryIds: [7601],
    });
    const [legacy] = await listGitHubInstallationAccessForWorkspace(db, workspace.workspaceId);
    expect(hasAuditableGitHubInstallationAuthority(legacy!)).toBe(false);
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(
        db,
        workspace.workspaceId,
        installationId,
        [7601],
      ),
    ).toBe(false);

    expect(
      await bindAuthorizedGitHubInstallationRepositories(
        db,
        authorityInput(workspace, {
          installationId,
          authorityNonce: `upgrade-${crypto.randomUUID()}`,
          repositoryIds: [7602],
        }),
      ),
    ).not.toBeNull();
    await expect(
      bindGitHubInstallationRepositories(db, {
        ...workspace,
        installationId,
        accountLogin: "legacy-owner",
        accountType: "User",
        linkedBySubjectId: "legacy-subject",
        repositoryIds: [7603],
      }),
    ).rejects.toThrow("Failed to bind GitHub installation");
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(
        db,
        workspace.workspaceId,
        installationId,
        [7602],
      ),
    ).toBe(true);
    expect(
      await areGitHubRepositoriesAllowedForWorkspace(
        db,
        workspace.workspaceId,
        installationId,
        [7603],
      ),
    ).toBe(false);
  });
});

async function freshWorkspace(
  accountId?: string,
): Promise<{ accountId: string; workspaceId: string }> {
  const resolvedAccountId =
    accountId ??
    (
      await admin<{ id: string }[]>`
        INSERT INTO managed_accounts (name)
        VALUES ('GitHub authority account')
        RETURNING id
      `
    )[0]!.id;
  const [workspace] = await admin<{ id: string }[]>`
    INSERT INTO workspaces (account_id, name)
    VALUES (${resolvedAccountId}, 'GitHub authority workspace')
    RETURNING id
  `;
  return { accountId: resolvedAccountId, workspaceId: workspace!.id };
}

function authorityInput(
  workspace: { accountId: string; workspaceId: string },
  patch: Partial<Parameters<typeof bindAuthorizedGitHubInstallationRepositories>[1]> = {},
): Parameters<typeof bindAuthorizedGitHubInstallationRepositories>[1] {
  const authorityCheckedAt = new Date();
  return {
    ...workspace,
    installationId: 7000,
    githubAccountId: 9001,
    accountLogin: "owner",
    accountType: "User",
    linkedBySubjectId: "opengeni-subject",
    githubActorId: 9001,
    githubActorLogin: "owner",
    authorityKind: "personal_owner",
    authorityCheckedAt,
    authorityExpiresAt: new Date(authorityCheckedAt.getTime() + 10 * 60_000),
    authorityNonce: `authority-${crypto.randomUUID()}`,
    repositoryIds: [7001],
    ...patch,
  };
}
