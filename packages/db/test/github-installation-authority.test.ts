import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  applyGitHubInstallationRepositoryObservation,
  areGitHubRepositoriesAllowedForWorkspace,
  bindAuthorizedGitHubInstallationRepositories,
  bindGitHubInstallationRepositories,
  createDb,
  GitHubInstallationAuthorityCommitError,
  hasAuditableGitHubInstallationAuthority,
  hasGitHubInstallationOwnerAuthority,
  listGitHubInstallationAccessForWorkspace,
  listGitHubInstallationBindingWorkspaces,
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
      eventRouteSecret: null,
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
        eventRouteSecret: null,
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

describe("GitHub installation allowlists follow GitHub", () => {
  test("the installation lane shows exactly one installation's bindings across accounts", async () => {
    if (!available) return;
    const installationId = 7801;
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const other = await freshWorkspace();
    for (const workspace of [first, second]) {
      await bindAuthorizedGitHubInstallationRepositories(
        db,
        authorityInput(workspace, { installationId, repositoryIds: [7811] }),
      );
    }
    await bindAuthorizedGitHubInstallationRepositories(
      db,
      authorityInput(other, { installationId: 7802, repositoryIds: [7812] }),
    );

    expect(await listGitHubInstallationBindingWorkspaces(db, installationId)).toEqual(
      [first, second].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
    );
    expect(await listGitHubInstallationBindingWorkspaces(db, 7899)).toEqual([]);

    // The application role sees no binding without the lane, and only the
    // named installation's bindings with it.
    const app = postgres(shared!.appUrl, { max: 1 });
    try {
      const [outside] = await app<{ count: number }[]>`
        select count(*)::int as count from github_installations
        where installation_id in (${installationId}, 7802)
      `;
      expect(outside!.count).toBe(0);
      const inside = await app.begin(async (tx) => {
        await tx`select set_config('opengeni.github_installation_id', ${String(installationId)}, true)`;
        return await tx<{ installation_id: number }[]>`
          select installation_id from github_installations
          where installation_id in (${installationId}, 7802)
        `;
      });
      expect(inside.map((row) => row.installation_id)).toEqual([installationId, installationId]);
      // The lane is read-only.
      const updated = await app.begin(async (tx) => {
        await tx`select set_config('opengeni.github_installation_id', ${String(installationId)}, true)`;
        return await tx`
          update github_installations set account_login = 'taken'
          where installation_id = ${installationId}
          returning id
        `;
      });
      expect(updated).toHaveLength(0);
    } finally {
      await app.end();
    }
  });

  test("a binding mirrors GitHub's list in order and applies removals at once", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installationId = 7803;
    const bound = await bindAuthorizedGitHubInstallationRepositories(
      db,
      authorityInput(workspace, { installationId, repositoryIds: [1, 2] }),
    );
    const base = Date.parse(bound!.updatedAt);
    const at = (offsetMs: number) => new Date(base + offsetMs);
    const apply = (
      observation: Parameters<
        typeof applyGitHubInstallationRepositoryObservation
      >[1]["observation"],
    ) =>
      applyGitHubInstallationRepositoryObservation(db, {
        ...workspace,
        installationId,
        observation,
      });
    const allowed = (ids: number[]) =>
      areGitHubRepositoriesAllowedForWorkspace(db, workspace.workspaceId, installationId, ids);

    // A list read before the bind changes nothing.
    expect(await apply({ kind: "mirror", repositoryIds: [1], observedAt: at(-1) })).toMatchObject({
      applied: false,
      repositoryIds: [1, 2],
    });
    // GitHub now shares repository 3 (a new repository of an "All
    // repositories" installation): the workspace may use it.
    expect(
      await apply({ kind: "mirror", repositoryIds: [3, 1, 2], observedAt: at(1_000) }),
    ).toEqual({ applied: true, changed: true, added: [3], removed: [], repositoryIds: [1, 2, 3] });
    expect(await allowed([3])).toBe(true);

    // A removal applies whatever its order, and fences out older lists.
    expect(
      await apply({ kind: "remove", repositoryIds: [2], observedAt: at(3_000) }),
    ).toMatchObject({ changed: true, removed: [2], repositoryIds: [1, 3] });
    expect(await allowed([2])).toBe(false);
    expect(
      await apply({ kind: "mirror", repositoryIds: [1, 2, 3], observedAt: at(2_000) }),
    ).toMatchObject({ applied: false, repositoryIds: [1, 3] });
    // A list read in the same millisecond as the removal may predate it.
    expect(
      await apply({ kind: "mirror", repositoryIds: [1, 2, 3], observedAt: at(3_000) }),
    ).toMatchObject({ applied: false, repositoryIds: [1, 3] });
    expect(await allowed([2])).toBe(false);
    // A late removal still removes, without moving the fence back.
    await apply({ kind: "mirror", repositoryIds: [1, 3, 4], observedAt: at(5_000) });
    expect(
      await apply({ kind: "remove", repositoryIds: [4], observedAt: at(4_000) }),
    ).toMatchObject({ removed: [4], repositoryIds: [1, 3] });
    expect(
      await apply({ kind: "mirror", repositoryIds: [1, 3, 4], observedAt: at(4_500) }),
    ).toMatchObject({ applied: false, repositoryIds: [1, 3] });

    // GitHub sharing nothing leaves the binding unusable but still bound;
    // sharing again restores it without a new owner proof.
    await apply({ kind: "mirror", repositoryIds: [], observedAt: at(6_000) });
    let [stored] = await listGitHubInstallationAccessForWorkspace(db, workspace.workspaceId);
    expect(stored!.repositoryIds).toEqual([]);
    expect(hasAuditableGitHubInstallationAuthority(stored!)).toBe(false);
    expect(hasGitHubInstallationOwnerAuthority(stored!)).toBe(true);
    expect(await allowed([1])).toBe(false);
    await apply({ kind: "mirror", repositoryIds: [5], observedAt: at(7_000) });
    expect(await allowed([5])).toBe(true);

    // The owner proof and its audit fields are untouched.
    [stored] = await listGitHubInstallationAccessForWorkspace(db, workspace.workspaceId);
    expect(stored).toMatchObject({
      authorityCheckedAt: bound!.authorityCheckedAt,
      authorityExpiresAt: bound!.authorityExpiresAt,
      authorityNonce: bound!.authorityNonce,
      linkedBySubjectId: bound!.linkedBySubjectId,
      githubActorId: bound!.githubActorId,
      repositoryIds: [5],
      updatedAt: at(7_000).toISOString(),
    });

    // A deleted installation removes everything.
    expect(
      await apply({ kind: "remove", repositoryIds: "all", observedAt: at(8_000) }),
    ).toMatchObject({ removed: [5], repositoryIds: [] });
  });

  test("a binding without an owner proof never follows GitHub", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await bindGitHubInstallationRepositories(db, {
      ...workspace,
      installationId: 7804,
      accountLogin: "legacy",
      accountType: "Organization",
      linkedBySubjectId: "legacy-subject",
      repositoryIds: [7821],
      eventRouteSecret: null,
    });
    expect(
      await applyGitHubInstallationRepositoryObservation(db, {
        ...workspace,
        installationId: 7804,
        observation: {
          kind: "mirror",
          repositoryIds: [7821, 7822],
          observedAt: new Date(Date.now() + 60_000),
        },
      }),
    ).toBeNull();
    expect(
      await applyGitHubInstallationRepositoryObservation(db, {
        ...workspace,
        installationId: 7805,
        observation: { kind: "remove", repositoryIds: "all", observedAt: new Date() },
      }),
    ).toBeNull();
    const [stored] = await listGitHubInstallationAccessForWorkspace(db, workspace.workspaceId);
    expect(stored!.repositoryIds).toEqual([7821]);
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
    eventRouteSecret: null,
    ...patch,
  };
}
