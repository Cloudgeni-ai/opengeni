import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  bootstrapWorkspace,
  createDb,
  listOwnedConnectionAccounts,
  persistProviderOAuthConnection,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("local_human_personal_authority");
  if (!shared) {
    available = false;
    console.warn("[local-human-personal-authority] docker unavailable, skipping");
    return;
  }
  await migrate(shared.adminUrl);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0369 local human personal authority", () => {
  test("keeps the local authority lane exact, narrow, and role-pinned", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0369_local_human_personal_authority.sql", import.meta.url),
    ).text();
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("account_row.external_source = 'opengeni:local'");
    expect(source).toContain("caller_subject IS DISTINCT FROM 'dev'");
    expect(source).toContain("authority.resource_kind = 'connection'");
    expect(source).toContain("NULL, 'connection.use', 'always'");
    expect(source).toContain("REVOKE ALL ON FUNCTION issue_self_local_connection_use_grant");
    expect(source).not.toMatch(/\bALTER TABLE\b/u);
    expect(source).not.toMatch(/\bDROP TABLE\b/u);
  });

  test("bootstraps one local human whose own account is available without a use grant", async () => {
    if (!available) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "opengeni:local",
      accountExternalId: "default",
      accountName: "OpenGeni Local",
      workspaceExternalSource: "opengeni:local",
      workspaceExternalId: "default",
      workspaceName: "Local workspace",
      subjectId: "dev",
      subjectLabel: "Local user",
    });
    const workspace = access.workspaceGrants.find(
      (grant) => grant.workspaceId === access.defaultWorkspaceId,
    );
    if (!workspace) throw new Error("local workspace grant was not returned");
    const now = new Date().toISOString();
    const connection = await persistProviderOAuthConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "dev",
      visibleToSubjectId: "dev",
      providerDomain: "github.com",
      kind: "oauth2",
      status: "active",
      credentialEncrypted: "test-ciphertext-never-resolved",
      grantedScopes: ["repo"],
      expiresAt: null,
      metadata: {
        credentialRole: "opengeni_github_personal",
        providerFamily: "github",
        providerPrincipalId: "123456789",
        githubUserId: "123456789",
        githubLogin: "local-octocat",
        oauthEnvironment: "local",
        oauthClientMarker: "a".repeat(32),
        credentialBindingId: crypto.randomUUID(),
        connectedAt: now,
        lastVerifiedAt: now,
      },
      createdBySubjectId: "dev",
      updatedBySubjectId: "dev",
      credentialRole: "opengeni_github_personal",
      providerFamily: "github",
      providerPrincipalId: "123456789",
      requireLiveUserAuthority: true,
      requiredLiveUserPermission: "connections:write",
      exclusiveProviderPrincipalPerOwner: true,
    });
    expect(connection?.authorityId).toEqual(expect.any(String));
    if (!connection?.authorityId) throw new Error("local connection authority was not created");

    expect(
      await listOwnedConnectionAccounts(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: "dev",
      }),
    ).toContainEqual({ connectionId: connection.id, originWorkspaceId: workspace.workspaceId });
  }, 60_000);
});
