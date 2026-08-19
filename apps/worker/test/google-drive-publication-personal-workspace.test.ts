import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
} from "@opengeni/contracts/google-drive";
import {
  createConnection,
  createDb,
  ensureManagedAccessForUser,
  getConnectionMetadata,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { resolveGoogleDrivePublicationTarget } from "../src/activities/google-drive-publication";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("google-drive-publication-personal-workspace");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const destination = {
  folderId: "folder-1",
  folderName: "Publications",
  driveId: null,
  location: "my_drive" as const,
  selectedAt: "2026-08-14T00:00:00.000Z",
};

async function seedOwnerWithDriveConnection(): Promise<{
  accountId: string;
  personalWorkspaceId: string;
  legacyWorkspaceId: string;
  subjectId: string;
  delegation: McpPersonalConnectionDelegation;
  legacyDelegation: McpPersonalConnectionDelegation;
}> {
  if (!client) throw new Error("test database unavailable");
  const userId = `drive-personal-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Drive publication owner",
  });
  const legacyWorkspaceId = context.defaultWorkspaceId!;
  const personalGrant = context.workspaceGrants.find(
    (grant) => grant.workspaceId !== legacyWorkspaceId,
  )!;
  const accountId = personalGrant.accountId;

  const connectionInput = (workspaceId: string) =>
    ({
      accountId,
      workspaceId,
      subjectId,
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2" as const,
      status: "active" as const,
      credentialEncrypted: Buffer.from("token"),
      grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE],
      metadata: {
        credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
        credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
        googlePermissionId: "permission-1",
        googleEmail: `${userId}@example.test`,
        googleDisplayName: null,
        verifiedAt: "2026-08-14T00:00:00.000Z",
        accessMode: "file_only",
        outputDestination: destination,
      },
      createdBySubjectId: subjectId,
    }) as const;

  const personalConnection = await createConnection(
    client.db,
    connectionInput(personalGrant.workspaceId),
  );
  const legacyConnection = await createConnection(client.db, connectionInput(legacyWorkspaceId));

  const delegationFor = (connectionId: string): McpPersonalConnectionDelegation => ({
    serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
    connectionId,
    ownerSubjectId: subjectId,
    providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
    kind: "oauth2",
    outputDestination: destination,
  });

  return {
    accountId,
    personalWorkspaceId: personalGrant.workspaceId,
    legacyWorkspaceId,
    subjectId,
    delegation: delegationFor(personalConnection.id),
    legacyDelegation: delegationFor(legacyConnection.id),
  };
}

describe("Google Drive publication in a managed human's personal workspace", () => {
  test("resolves the owner's frozen publication target through the real default ports", async () => {
    if (!client) return;
    const seed = await seedOwnerWithDriveConnection();

    // Baseline: the legacy Better Auth workspace has a real
    // `workspace_memberships` row, so this always worked.
    expect(
      await resolveGoogleDrivePublicationTarget(
        client.db,
        { accountId: seed.accountId, workspaceId: seed.legacyWorkspaceId },
        [seed.legacyDelegation],
      ),
    ).not.toBeNull();

    // The personal workspace deliberately has no membership row. Its owner
    // must still resolve, through the organization membership pointer.
    const resolved = await resolveGoogleDrivePublicationTarget(
      client.db,
      { accountId: seed.accountId, workspaceId: seed.personalWorkspaceId },
      [seed.delegation],
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.ownerSubjectId).toBe(seed.subjectId);
    expect(resolved?.connectionId).toBe(seed.delegation.connectionId);
    expect(resolved?.originWorkspaceId).toBe(seed.personalWorkspaceId);
  }, 180_000);

  test("another human never resolves a publication target in someone else's personal workspace", async () => {
    if (!client) return;
    const owner = await seedOwnerWithDriveConnection();
    const intruder = await seedOwnerWithDriveConnection();

    expect(
      await resolveGoogleDrivePublicationTarget(
        client.db,
        { accountId: owner.accountId, workspaceId: owner.personalWorkspaceId },
        [{ ...owner.delegation, ownerSubjectId: intruder.subjectId }],
      ),
    ).toBeNull();
  }, 180_000);

  // The test above is denied downstream by connection ownership, so it stays
  // green even with the authority probe bypassed entirely. This one isolates
  // the probe: the connection genuinely BELONGS to the intruder and sits in the
  // owner's personal workspace, so `getConnection` succeeds and the ONLY fence
  // left is the workspace-authority probe.
  test("an intruder-owned connection in another's personal workspace is denied by the authority probe alone", async () => {
    if (!client) return;
    const owner = await seedOwnerWithDriveConnection();
    const intruder = await seedOwnerWithDriveConnection();

    const planted = await createConnection(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      subjectId: intruder.subjectId,
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2",
      status: "active",
      credentialEncrypted: Buffer.from("token"),
      grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE],
      metadata: {
        credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
        credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
        googlePermissionId: "permission-planted",
        googleEmail: "planted@example.test",
        googleDisplayName: null,
        verifiedAt: "2026-08-14T00:00:00.000Z",
        accessMode: "file_only",
        outputDestination: destination,
      },
      createdBySubjectId: intruder.subjectId,
    });
    const plantedDelegation: McpPersonalConnectionDelegation = {
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      connectionId: planted.id,
      ownerSubjectId: intruder.subjectId,
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2",
      outputDestination: destination,
    };

    // Control: with the probe forced true the row IS reachable, proving every
    // downstream check passes and the probe is the only fence under test.
    expect(
      await resolveGoogleDrivePublicationTarget(
        client.db,
        { accountId: owner.accountId, workspaceId: owner.personalWorkspaceId },
        [plantedDelegation],
        { getConnection: getConnectionMetadata, getMembership: async () => true },
      ),
    ).not.toBeNull();

    // Real resolver: denied by the probe.
    expect(
      await resolveGoogleDrivePublicationTarget(
        client.db,
        { accountId: owner.accountId, workspaceId: owner.personalWorkspaceId },
        [plantedDelegation],
      ),
    ).toBeNull();
  }, 180_000);
});
