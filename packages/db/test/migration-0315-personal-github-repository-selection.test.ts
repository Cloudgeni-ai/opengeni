import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  PersonalGitHubRepositorySelectionChangedError,
  PersonalGitHubRepositorySelectionIdempotencyError,
  PersonalGitHubRepositorySelectionUnavailableError,
  createDb,
  deleteWorkspace,
  ensureManagedAccessForUser,
  getPersonalGitHubRepositorySelectionState,
  persistProviderOAuthConnection,
  replacePersonalGitHubRepositorySelections,
  verifyPersonalGitHubRepositorySelections,
  withRlsContext,
  setSubjectRlsContext,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
const workspaceIds: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal_github_repository_selection");
  if (!shared) {
    available = false;
    console.warn("[personal-github-repository-selection] docker unavailable, skipping");
    return;
  }
  await migrate(shared.adminUrl);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  for (const workspaceId of workspaceIds) {
    await deleteWorkspace(client?.db, workspaceId).catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `github-repository-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "GitHub repository owner",
  });
  workspaceIds.push(...access.workspaceGrants.map((grant) => grant.workspaceId));
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  )!;
  const bindingId = crypto.randomUUID();
  const now = new Date().toISOString();
  const connection = await persistProviderOAuthConnection(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    visibleToSubjectId: subjectId,
    providerDomain: "github.com",
    kind: "oauth2",
    status: "active",
    credentialEncrypted: "test-ciphertext-never-resolved",
    grantedScopes: ["repo"],
    expiresAt: null,
    metadata: {
      credentialRole: "opengeni_github_personal",
      providerFamily: "github",
      providerPrincipalId: "9876543210987654321",
      githubUserId: "9876543210987654321",
      githubLogin: "octocat",
      oauthEnvironment: "test",
      oauthClientMarker: "a".repeat(32),
      credentialBindingId: bindingId,
      connectedAt: now,
      lastVerifiedAt: now,
    },
    createdBySubjectId: subjectId,
    updatedBySubjectId: subjectId,
    credentialRole: "opengeni_github_personal",
    providerFamily: "github",
    providerPrincipalId: "9876543210987654321",
    requireLiveUserAuthority: true,
    requiredLiveUserPermission: "connections:write",
    exclusiveProviderPrincipalPerOwner: true,
  });
  if (!connection) throw new Error("fixture connection was not created");
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    connection,
  };
}

function selected(lastVerifiedAt = new Date().toISOString()) {
  return {
    repositoryId: "9007199254740993123",
    fullName: "octocat/private-repository",
    canonicalUrl: "https://github.com/octocat/private-repository",
    defaultBranch: "main",
    visibility: "private" as const,
    private: true,
    archived: false,
    disabled: false,
    permissions: {
      pull: true,
      push: true,
      admin: false,
      maintain: false,
      triage: false,
    },
    selectedAccess: "write" as const,
    lastVerifiedAt,
  };
}

describe("migration 0315 personal GitHub repository selection", () => {
  test("admits the dedicated discriminator only through existing scheduled connection ledgers", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0315_personal_github_repository_selection.sql", import.meta.url),
    ).text();
    expect(source).toContain("scheduled_task_connection_authority_shape_chk");
    expect(source).toContain("scheduled_run_connection_authority_shape_chk");
    expect(source.match(/connection_type IN \('mcp', 'github_personal'\)/gu)).toHaveLength(2);
    expect(source.match(/\) NOT VALID;/gu)).toHaveLength(2);
    expect(source).toContain("VALIDATE CONSTRAINT scheduled_task_connection_authority_shape_chk");
    expect(source).toContain("VALIDATE CONSTRAINT scheduled_run_connection_authority_shape_chk");
  });

  test("keeps bigint repository IDs exact and advances only authority-relevant generations", async () => {
    if (!available) return;
    const owner = await fixture();
    const initial = await getPersonalGitHubRepositorySelectionState(client.db, {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
    });
    expect(initial).toMatchObject({ selectionGeneration: 0, repositories: [] });
    const emptyVerification = await verifyPersonalGitHubRepositorySelections(client.db, {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
      expectedConnectionAuthorityGeneration: initial!.connectionAuthorityGeneration,
      expectedSelectionGeneration: 0,
      idempotencyKey: crypto.randomUUID(),
      repositories: [],
    });
    expect(emptyVerification).toMatchObject({ selectionGeneration: 0, repositories: [] });

    const request = {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
      expectedConnectionAuthorityGeneration: initial!.connectionAuthorityGeneration,
      expectedSelectionGeneration: 0,
      idempotencyKey: crypto.randomUUID(),
      repositories: [selected()],
    };
    const replaced = await replacePersonalGitHubRepositorySelections(client.db, request);
    expect(replaced.selectionGeneration).toBe(1);
    expect(replaced.repositories[0]).toMatchObject({
      repositoryId: "9007199254740993123",
      selectionGeneration: 1,
      selectedAccess: "write",
    });
    expect(
      await replacePersonalGitHubRepositorySelections(client.db, {
        ...request,
        repositories: [selected(new Date(Date.now() + 500).toISOString())],
      }),
    ).toEqual(replaced);

    const verified = await verifyPersonalGitHubRepositorySelections(client.db, {
      ...request,
      expectedSelectionGeneration: 1,
      idempotencyKey: crypto.randomUUID(),
      repositories: [selected(new Date(Date.now() + 1_000).toISOString())],
    });
    expect(verified.selectionGeneration).toBe(1);
    expect(verified.repositories[0]!.selectionGeneration).toBe(1);

    const removed = await replacePersonalGitHubRepositorySelections(client.db, {
      ...request,
      expectedSelectionGeneration: 1,
      idempotencyKey: crypto.randomUUID(),
      repositories: [],
    });
    expect(removed).toMatchObject({ selectionGeneration: 2, repositories: [] });
    await expect(
      replacePersonalGitHubRepositorySelections(client.db, request),
    ).rejects.toBeInstanceOf(PersonalGitHubRepositorySelectionChangedError);
  }, 60_000);

  test("rejects inconsistent provider facts and write access without live write capability", async () => {
    if (!available) return;
    const owner = await fixture();
    const initial = await getPersonalGitHubRepositorySelectionState(client.db, {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
    });
    const base = {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
      expectedConnectionAuthorityGeneration: initial!.connectionAuthorityGeneration,
      expectedSelectionGeneration: 0,
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(
      replacePersonalGitHubRepositorySelections(client.db, {
        ...base,
        repositories: [
          {
            ...selected(),
            private: false,
          },
        ],
      }),
    ).rejects.toBeTruthy();
    await expect(
      replacePersonalGitHubRepositorySelections(client.db, {
        ...base,
        idempotencyKey: crypto.randomUUID(),
        repositories: [
          {
            ...selected(),
            permissions: {
              pull: true,
              push: false,
              admin: false,
              maintain: false,
              triage: false,
            },
          },
        ],
      }),
    ).rejects.toBeTruthy();
  }, 60_000);

  test("fences stale generations and idempotency-key substitution", async () => {
    if (!available) return;
    const owner = await fixture();
    const initial = await getPersonalGitHubRepositorySelectionState(client.db, {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
    });
    const idempotencyKey = crypto.randomUUID();
    const base = {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
      expectedConnectionAuthorityGeneration: initial!.connectionAuthorityGeneration,
      expectedSelectionGeneration: 0,
      idempotencyKey,
      repositories: [selected()],
    };
    await replacePersonalGitHubRepositorySelections(client.db, base);
    await expect(
      replacePersonalGitHubRepositorySelections(client.db, {
        ...base,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PersonalGitHubRepositorySelectionChangedError);
    await expect(
      replacePersonalGitHubRepositorySelections(client.db, {
        ...base,
        repositories: [],
      }),
    ).rejects.toBeInstanceOf(PersonalGitHubRepositorySelectionIdempotencyError);
  }, 60_000);

  test("revokes direct application DML even in the exact owner RLS scope", async () => {
    if (!available) return;
    const owner = await fixture();
    await expect(
      withRlsContext(
        client.db,
        { accountId: owner.accountId, workspaceId: owner.workspaceId },
        async (scopedDb) => {
          await setSubjectRlsContext(scopedDb, owner.subjectId);
          await scopedDb.execute(sql`
            insert into personal_github_repository_selection_heads (
              connection_id, account_id, origin_workspace_id, owner_subject_id,
              provider_principal_id, credential_binding_id,
              connection_authority_generation, generation, updated_by_subject_id
            ) values (
              ${owner.connection.id}::uuid, ${owner.accountId}::uuid,
              ${owner.workspaceId}::uuid, ${owner.subjectId}, '1',
              ${crypto.randomUUID()}::uuid, 1, 1, ${owner.subjectId}
            )
          `);
        },
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  test("does not expose or mutate a selection for a different named subject", async () => {
    if (!available) return;
    const owner = await fixture();
    const otherSubjectId = `user:not-${owner.subjectId}`;
    const ownerState = await getPersonalGitHubRepositorySelectionState(client.db, {
      accountId: owner.accountId,
      originWorkspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      connectionId: owner.connection.id,
    });
    expect(
      await getPersonalGitHubRepositorySelectionState(client.db, {
        accountId: owner.accountId,
        originWorkspaceId: owner.workspaceId,
        subjectId: otherSubjectId,
        connectionId: owner.connection.id,
      }),
    ).toBeNull();
    await expect(
      replacePersonalGitHubRepositorySelections(client.db, {
        accountId: owner.accountId,
        originWorkspaceId: owner.workspaceId,
        subjectId: otherSubjectId,
        connectionId: owner.connection.id,
        expectedConnectionAuthorityGeneration: ownerState!.connectionAuthorityGeneration,
        expectedSelectionGeneration: 0,
        idempotencyKey: crypto.randomUUID(),
        repositories: [selected()],
      }),
    ).rejects.toBeInstanceOf(PersonalGitHubRepositorySelectionUnavailableError);
  }, 60_000);
});
