import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  countWorkspacesForAccount,
  createDb,
  createWorkspace,
  ensureWorkspaceByExternalIdentity,
  listSharedWorkspacesForAccount,
  WorkspaceExternalIdentityConflictError,
  WorkspaceLimitExceededError,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_APP_URL;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const createdAccountIds: string[] = [];

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL and OPENGENI_ORG_TENANCY_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 12 });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("external-workspace-provisioning");
  }
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[external-workspace-provisioning] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 12 });
}, 180_000);

afterAll(async () => {
  if (shared && createdAccountIds.length > 0) {
    await shared.admin`delete from managed_accounts where id in ${shared.admin(createdAccountIds)}`;
  }
  await client?.close();
  await shared?.release();
}, 60_000);

async function createAccount(name: string): Promise<string> {
  if (!shared) throw new Error("database unavailable");
  const [account] = await shared.admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${name}) returning id`;
  if (!account) throw new Error("account insert returned no row");
  createdAccountIds.push(account.id);
  return account.id;
}

describe("external workspace provisioning", () => {
  test("concurrent retries create one workspace and one inference-control row", async () => {
    if (!shared || !client) return;
    const accountId = await createAccount("External provisioning concurrency");
    const externalSource = `external-product-${crypto.randomUUID()}`;
    const externalId = "tenant-42";

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ensureWorkspaceByExternalIdentity(client!.db, {
          accountId,
          externalSource,
          externalId,
          name: index === 0 ? "Canonical tenant" : `Retry name ${index}`,
          slug: index === 0 ? "canonical-tenant" : `retry-${index}`,
        }),
      ),
    );

    expect(new Set(results.map((result) => result.workspace.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const workspaceId = results[0]!.workspace.id;
    const [counts] = await shared.admin<Array<{ workspaces: number; controls: number }>>`
      select
        (select count(*)::int from workspaces
          where external_source = ${externalSource} and external_id = ${externalId}) as workspaces,
        (select count(*)::int from workspace_inference_controls
          where workspace_id = ${workspaceId}) as controls`;
    expect(counts).toEqual({ workspaces: 1, controls: 1 });

    const original = results.find((result) => result.created)!.workspace;
    const replay = await ensureWorkspaceByExternalIdentity(client.db, {
      accountId,
      externalSource,
      externalId,
      name: "A stale display name",
      slug: "stale-display-slug",
    });
    expect(replay).toMatchObject({
      created: false,
      workspace: {
        id: workspaceId,
        name: original.name,
        slug: original.slug,
        kind: "shared",
      },
    });
  });

  test("the same external identity cannot replay across organizations", async () => {
    if (!client) return;
    const firstAccountId = await createAccount("External provisioning owner");
    const secondAccountId = await createAccount("External provisioning stranger");
    const externalSource = `cross-account-${crypto.randomUUID()}`;
    const externalId = "tenant-shared-id";

    await ensureWorkspaceByExternalIdentity(client.db, {
      accountId: firstAccountId,
      externalSource,
      externalId,
      name: "First owner",
    });
    await expect(
      ensureWorkspaceByExternalIdentity(client.db, {
        accountId: secondAccountId,
        externalSource,
        externalId,
        name: "Second owner",
      }),
    ).rejects.toBeInstanceOf(WorkspaceExternalIdentityConflictError);
  });

  test("direct and external creators share one account workspace-limit fence", async () => {
    if (!client) return;
    const accountId = await createAccount("Cross-route workspace limit");
    const maxWorkspacesPerAccount = 1;
    const results = await Promise.allSettled([
      createWorkspace(client.db, {
        accountId,
        name: "Direct workspace",
        maxWorkspacesPerAccount,
      }),
      ensureWorkspaceByExternalIdentity(client.db, {
        accountId,
        externalSource: `cross-route-limit-${crypto.randomUUID()}`,
        externalId: "tenant-1",
        name: "External workspace",
        maxWorkspacesPerAccount,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(WorkspaceLimitExceededError);
    expect(await countWorkspacesForAccount(client.db, accountId)).toBe(1);
  });

  test("organization inventory excludes the canonical personal-workspace pointer", async () => {
    if (!shared || !client) return;
    const accountId = await createAccount("Shared workspace inventory");
    const sharedWorkspace = await createWorkspace(client.db, {
      accountId,
      name: "Organization workspace",
    });
    const [personalWorkspace] = await shared.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${accountId}, 'Personal workspace') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${personalWorkspace!.id}, ${accountId})`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id, authorization_revision
      ) values (
        ${accountId}, ${`user:${crypto.randomUUID()}`}, 'owner', 'active',
        ${personalWorkspace!.id}, 1
      )`;

    const inventory = await listSharedWorkspacesForAccount(client.db, accountId);
    expect(inventory.map((workspace) => workspace.id)).toContain(sharedWorkspace.id);
    expect(inventory.map((workspace) => workspace.id)).not.toContain(personalWorkspace!.id);
    expect(inventory.every((workspace) => workspace.kind === "shared")).toBe(true);
  });
});
