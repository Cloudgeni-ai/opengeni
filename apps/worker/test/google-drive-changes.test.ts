import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GoogleDriveConnectionMetadata,
  type GoogleDriveSelectedSource,
} from "@opengeni/contracts/google-drive";
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  type GoogleDriveInventoryProviderItem,
} from "@opengeni/documents/google-drive";
import {
  advanceGoogleDriveChangesCursor,
  buildGoogleDriveChangesCursor,
  drainGoogleDriveChanges,
  GoogleDriveChangesProtocolError,
  googleDriveFullReconciliationDue,
  parseGoogleDriveChangesCheckpoint,
  parseGoogleDriveChangesCursor,
  resolveGoogleDriveChangesBoundaryId,
  type GoogleDriveChangesCheckpoint,
} from "../src/activities/google-drive-changes";
import {
  collectGoogleDriveAclEvidence,
  googleDriveSyncDriver,
  mergeGoogleDriveDurableObservationFloors,
  shouldProcessGoogleDriveDurableObservation,
  type GoogleDriveSyncProviderPort,
} from "../src/activities/knowledge-source-sync";

describe("Google Drive object ACL evidence", () => {
  const entry = {
    externalObjectId: "drive-file-1",
    externalVersionId: "42",
    driveId: "shared-drive",
  } as const;

  test("collects bounded multi-page direct, domain, group, and anyone principals", async () => {
    const calls: Array<string | null> = [];
    const evidence = await collectGoogleDriveAclEvidence({
      entry,
      maxProviderRequests: 3,
      now: () => Date.parse("2026-08-14T00:00:00.000Z"),
      listPermissions: async ({ pageToken }) => {
        calls.push(pageToken);
        return pageToken === null
          ? {
              permissions: [
                {
                  id: "permission-user",
                  type: "user",
                  role: "reader",
                  emailAddress: "reader@example.com",
                  domain: null,
                  allowFileDiscovery: null,
                  expirationTime: null,
                  inherited: false,
                },
                {
                  id: "permission-group",
                  type: "group",
                  role: "reader",
                  emailAddress: "group@example.com",
                  domain: null,
                  allowFileDiscovery: null,
                  expirationTime: null,
                  inherited: true,
                },
              ],
              nextPageToken: "page-2",
              denied: false,
            }
          : {
              permissions: [
                {
                  id: "permission-domain",
                  type: "domain",
                  role: "commenter",
                  emailAddress: null,
                  domain: "example.com",
                  allowFileDiscovery: false,
                  expirationTime: "2026-08-15T00:00:00.000Z",
                  inherited: true,
                },
                {
                  id: "permission-anyone",
                  type: "anyone",
                  role: "reader",
                  emailAddress: null,
                  domain: null,
                  allowFileDiscovery: false,
                  expirationTime: null,
                  inherited: false,
                },
              ],
              nextPageToken: null,
              denied: false,
            };
      },
    });

    expect(calls).toEqual([null, "page-2"]);
    expect(evidence).toMatchObject({
      eligibility: "eligible",
      providerRevision: "42",
      driveId: "shared-drive",
      observedAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-15T02:00:00.000Z",
      providerRequests: 2,
    });
    expect(evidence.aclRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.principals).toHaveLength(4);
    expect(evidence.principals).toContainEqual(
      expect.objectContaining({
        type: "group",
        permissionId: "permission-group",
        inherited: true,
      }),
    );
    expect(evidence.principals).toContainEqual(
      expect.objectContaining({
        type: "domain",
        domain: "example.com",
        expirationTime: "2026-08-15T00:00:00.000Z",
      }),
    );
  });

  test("falls back to source-owner-only evidence when permissions are hidden but file access remains", async () => {
    const evidence = await collectGoogleDriveAclEvidence({
      entry,
      maxProviderRequests: 2,
      now: () => Date.parse("2026-08-14T00:00:00.000Z"),
      listPermissions: async () => ({ permissions: [], nextPageToken: null, denied: true }),
      getFile: async () => file(entry.externalObjectId, [source.id]),
    });

    expect(evidence).toMatchObject({
      eligibility: "eligible",
      providerRequests: 2,
      principals: [],
    });
    expect(evidence.aclRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  test("denies when both permission listing and current file access are gone", async () => {
    const evidence = await collectGoogleDriveAclEvidence({
      entry,
      maxProviderRequests: 2,
      now: () => Date.parse("2026-08-14T00:00:00.000Z"),
      listPermissions: async () => ({ permissions: [], nextPageToken: null, denied: true }),
      getFile: async () => null,
    });

    expect(evidence).toMatchObject({
      eligibility: "denied",
      providerRequests: 2,
      principals: [],
    });
  });

  test("fails closed on repeated pagination cursors", async () => {
    await expect(
      collectGoogleDriveAclEvidence({
        entry,
        maxProviderRequests: 3,
        listPermissions: async () => ({
          permissions: [],
          nextPageToken: "repeat",
          denied: false,
        }),
      }),
    ).rejects.toThrow("provider_payload_invalid");
  });

  test("fails closed before exceeding the provider request budget", async () => {
    await expect(
      collectGoogleDriveAclEvidence({
        entry,
        maxProviderRequests: 1,
        listPermissions: async () => ({
          permissions: [],
          nextPageToken: "page-2",
          denied: false,
        }),
      }),
    ).rejects.toThrow("resource_limit");
  });
});

const source: GoogleDriveSelectedSource = {
  id: "folder-root",
  name: "Knowledge",
  mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  driveId: "shared-drive",
  destination: {
    authorityKind: "workspace",
    authorityAccountId: "00000000-0000-4000-8000-000000000126",
    authorityWorkspaceId: "00000000-0000-4000-8000-000000000126",
    authoritySubjectId: null,
    collectionId: null,
  },
  syncCadence: "hourly",
  syncEnabled: true,
  configGeneration: 1,
  readPolicy: "allow",
  selectedAt: "2026-08-10T00:00:00.000Z",
};

const myDriveSource: GoogleDriveSelectedSource = {
  ...source,
  id: "root",
  name: "My Drive",
  driveId: null,
};

function file(
  id: string,
  parents: string[],
  mimeType = "text/plain",
  driveId: string | null = source.driveId,
): GoogleDriveInventoryProviderItem {
  return {
    id,
    name: `${id}.txt`,
    mimeType,
    driveId,
    parents,
    modifiedTime: "2026-08-10T00:00:00.000Z",
    createdTime: "2026-08-09T00:00:00.000Z",
    version: "7",
    md5Checksum: null,
    size: "10",
    webViewLink: `https://drive.google.com/open?id=${id}`,
    trashed: false,
  };
}

function cursorFor(
  selectedSource: GoogleDriveSelectedSource = source,
  boundaryId = selectedSource.id,
  pageToken = "start-1",
) {
  return buildGoogleDriveChangesCursor({
    connectionId: "00000000-0000-4000-8000-000000000127",
    googlePermissionId: "permission-1",
    sourceId: selectedSource.id,
    driveId: selectedSource.driveId,
    boundaryId,
    pageToken,
    previousGeneration: 0,
    reconciledAt: new Date("2026-08-10T00:00:00Z"),
    fullReconciliationIntervalMs: 86_400_000,
  });
}

function drainDefaults(overrides: {
  selectedSource?: GoogleDriveSelectedSource;
  boundaryId?: string;
  checkpoint?: GoogleDriveChangesCheckpoint | null;
  maxItems?: number;
  maxProviderRequests?: number;
  maxElapsedMs?: number;
  maxInvocationElapsedMs?: number;
  listChanges: Parameters<typeof drainGoogleDriveChanges>[0]["listChanges"];
  getFile?: Parameters<typeof drainGoogleDriveChanges>[0]["getFile"];
  observedExternalObjectIds?: Parameters<
    typeof drainGoogleDriveChanges
  >[0]["observedExternalObjectIds"];
  now?: () => number;
}) {
  const selectedSource = overrides.selectedSource ?? source;
  return drainGoogleDriveChanges({
    source: selectedSource,
    cursor: cursorFor(selectedSource, overrides.boundaryId ?? selectedSource.id),
    checkpoint: overrides.checkpoint ?? null,
    maxItems: overrides.maxItems ?? 10,
    maxProviderRequests: overrides.maxProviderRequests ?? 10,
    maxElapsedMs: overrides.maxElapsedMs ?? 10_000,
    maxInvocationElapsedMs: overrides.maxInvocationElapsedMs ?? 1_000,
    maxFileBytes: 1_000,
    listChanges: overrides.listChanges,
    getFile: overrides.getFile ?? (async () => null),
    observedExternalObjectIds: overrides.observedExternalObjectIds ?? (async () => new Set()),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

const metadata = GoogleDriveConnectionMetadata.parse({
  credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
  credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
  googlePermissionId: "permission-1",
  googleEmail: "drive@example.com",
  googleDisplayName: "Drive User",
  verifiedAt: "2026-08-10T00:00:00.000Z",
  accessMode: "readonly",
});

function driverFor(
  selectedSource: GoogleDriveSelectedSource,
  provider: GoogleDriveSyncProviderPort,
  observedExternalObjectIds: (ids: string[]) => Promise<Set<string>> = async () => new Set(),
  limitOverrides: Partial<{
    maxItems: number;
    maxBytes: number;
    maxFileBytes: number;
    maxProviderRequests: number;
    maxElapsedSeconds: number;
  }> = {},
) {
  return googleDriveSyncDriver({
    actionProviderCoordinationKey: "google-drive:permission-1:my-drive",
    metadata,
    selectedSource,
    connectionId: "00000000-0000-4000-8000-000000000127",
    accountId: "00000000-0000-4000-8000-000000000126",
    workspaceId: "00000000-0000-4000-8000-000000000126",
    initiatingSubjectId: "user:drive-test",
    authorization: undefined,
    fullReconciliationIntervalMs: 86_400_000,
    observedExternalObjectIds,
    provider,
    limits: {
      maxItems: 10,
      maxBytes: 1_000,
      maxFileBytes: 1_000,
      maxProviderRequests: 10,
      maxElapsedSeconds: 10,
      ...limitOverrides,
    },
  });
}

describe("Google Drive Changes cursor and reconciliation planner", () => {
  test("binds cursors to the exact connection, permission, source, Shared Drive, and boundary", () => {
    const cursor = cursorFor();
    expect(
      parseGoogleDriveChangesCursor(cursor, {
        connectionId: cursor.connectionId,
        googlePermissionId: cursor.googlePermissionId,
        sourceId: cursor.sourceId,
        driveId: cursor.driveId,
      }),
    ).toEqual(cursor);
    expect(
      parseGoogleDriveChangesCursor(cursor, {
        connectionId: cursor.connectionId,
        googlePermissionId: cursor.googlePermissionId,
        sourceId: "other-source",
        driveId: cursor.driveId,
      }),
    ).toBeNull();
    expect(
      parseGoogleDriveChangesCursor(cursor, {
        connectionId: cursor.connectionId,
        googlePermissionId: cursor.googlePermissionId,
        sourceId: cursor.sourceId,
        driveId: "other-drive",
      }),
    ).toBeNull();
    expect(parseGoogleDriveChangesCursor({ ...cursor, boundaryId: "" }, cursor)).toBeNull();
    expect(googleDriveFullReconciliationDue(cursor, new Date("2026-08-10T23:59:59Z"))).toBe(false);
    expect(googleDriveFullReconciliationDue(cursor, new Date("2026-08-11T00:00:00Z"))).toBe(true);
  });

  test("resolves the My Drive root alias to the actual folder ID and fails closed", async () => {
    const calls: string[] = [];
    expect(
      await resolveGoogleDriveChangesBoundaryId({
        source: myDriveSource,
        getFile: async (id) => {
          calls.push(id);
          return file("actual-root-id", [], GOOGLE_DRIVE_FOLDER_MIME_TYPE, null);
        },
      }),
    ).toBe("actual-root-id");
    expect(calls).toEqual(["root"]);
    await expect(
      resolveGoogleDriveChangesBoundaryId({
        source: myDriveSource,
        getFile: async () => null,
      }),
    ).rejects.toBeInstanceOf(GoogleDriveChangesProtocolError);
  });

  test("drains paginated changes and resolves nested ancestry with provider mocks", async () => {
    const pages = new Map([
      [
        "start-1",
        {
          changes: [{ fileId: "direct", removed: false, file: file("direct", [source.id]) }],
          nextPageToken: "page-2",
          newStartPageToken: null,
        },
      ],
      [
        "page-2",
        {
          changes: [{ fileId: "nested", removed: false, file: file("nested", ["child"]) }],
          nextPageToken: null,
          newStartPageToken: "start-2",
        },
      ],
    ]);
    const result = await drainDefaults({
      listChanges: async (token) => pages.get(token)!,
      getFile: async (id) => (id === "child" ? file("child", [source.id], source.mimeType) : null),
    });
    expect(result.status).toBe("complete");
    expect(result.newStartPageToken).toBe("start-2");
    expect(result.requiresFullReconciliation).toBe(false);
    expect(result.entries.map((entry) => entry.externalObjectId).sort()).toEqual([
      "direct",
      "nested",
    ]);
    expect(result.providerRequests).toBe(3);
    expect(result.budget).toMatchObject({ examinedItems: 2, providerRequests: 3 });
  });

  test("imports a new direct My Drive child using the actual root boundary before advancing", async () => {
    const cursor = cursorFor(myDriveSource, "actual-root-id");
    const result = await drainGoogleDriveChanges({
      source: myDriveSource,
      cursor,
      checkpoint: null,
      maxItems: 10,
      maxProviderRequests: 10,
      maxElapsedMs: 10_000,
      maxInvocationElapsedMs: 1_000,
      maxFileBytes: 1_000,
      listChanges: async () => ({
        changes: [
          {
            fileId: "new-root-file",
            removed: false,
            file: file("new-root-file", ["actual-root-id"], "text/plain", null),
          },
        ],
        nextPageToken: null,
        newStartPageToken: "start-2",
      }),
      getFile: async () => null,
      observedExternalObjectIds: async () => new Set(),
    });
    expect(result.entries.map((entry) => entry.externalObjectId)).toEqual(["new-root-file"]);
    expect(result.requiresFullReconciliation).toBe(false);
    expect(advanceGoogleDriveChangesCursor(cursor, result.newStartPageToken!)).toMatchObject({
      boundaryId: "actual-root-id",
      pageToken: "start-2",
      cursorGeneration: 2,
    });
  });

  test("escalates moved and removed My Drive objects to full repair", async () => {
    const result = await drainDefaults({
      selectedSource: myDriveSource,
      boundaryId: "actual-root-id",
      listChanges: async () => ({
        changes: [
          {
            fileId: "moved-root-file",
            removed: false,
            file: file("moved-root-file", ["outside-parent"], "text/plain", null),
          },
          { fileId: "removed-root-file", removed: true, file: null },
        ],
        nextPageToken: null,
        newStartPageToken: "start-2",
      }),
      getFile: async (id) =>
        id === "outside-parent"
          ? file("outside-parent", [], GOOGLE_DRIVE_FOLDER_MIME_TYPE, null)
          : null,
      observedExternalObjectIds: async (ids) => new Set(ids),
    });
    expect(result.entries).toEqual([]);
    expect(result.requiresFullReconciliation).toBe(true);
    expect(result.newStartPageToken).toBe("start-2");
  });

  test("fails safe to full repair when My Drive ancestry cannot be resolved", async () => {
    const result = await drainDefaults({
      selectedSource: myDriveSource,
      boundaryId: "actual-root-id",
      listChanges: async () => ({
        changes: [
          {
            fileId: "unknown-root-file",
            removed: false,
            file: file("unknown-root-file", ["missing-parent"], "text/plain", null),
          },
        ],
        nextPageToken: null,
        newStartPageToken: "start-2",
      }),
    });
    expect(result.entries).toEqual([]);
    expect(result.requiresFullReconciliation).toBe(true);
  });

  test("sizes each changes page to the remaining cumulative item budget", async () => {
    const pageSizes: number[] = [];
    const result = await drainDefaults({
      maxItems: 2,
      listChanges: async (token, pageSize) => {
        pageSizes.push(pageSize);
        return token === "start-1"
          ? {
              changes: [{ fileId: "first", removed: false, file: file("first", [source.id]) }],
              nextPageToken: "page-2",
              newStartPageToken: null,
            }
          : {
              changes: [{ fileId: "second", removed: false, file: file("second", [source.id]) }],
              nextPageToken: "page-3",
              newStartPageToken: null,
            };
      },
    });
    expect(result.status).toBe("paused");
    expect(result.stopReason).toBe("item_limit");
    expect(result.hardLimitReached).toBe(true);
    expect(result.entries.map((entry) => entry.externalObjectId)).toEqual(["first", "second"]);
    expect(result.checkpoint?.pageToken).toBe("page-3");
    expect(result.checkpoint?.budget.examinedItems).toBe(2);
    expect(pageSizes).toEqual([2, 1]);
  });

  test("counts removal-only pages and refuses a provider call after item exhaustion", async () => {
    let calls = 0;
    const first = await drainDefaults({
      maxItems: 1,
      listChanges: async () => {
        calls += 1;
        return {
          changes: [{ fileId: "removed", removed: true, file: null }],
          nextPageToken: "page-2",
          newStartPageToken: null,
        };
      },
    });
    expect(first).toMatchObject({
      status: "paused",
      stopReason: "item_limit",
      hardLimitReached: true,
      providerRequests: 1,
      budget: { examinedItems: 1, providerRequests: 1 },
    });
    const resumed = await drainDefaults({
      maxItems: 1,
      checkpoint: first.checkpoint,
      listChanges: async () => {
        calls += 1;
        throw new Error("provider call must not occur after item exhaustion");
      },
    });
    expect(resumed).toMatchObject({
      status: "paused",
      stopReason: "item_limit",
      hardLimitReached: true,
      providerRequests: 1,
    });
    expect(calls).toBe(1);
  });

  test("preserves provider-request exhaustion across a resumed checkpoint", async () => {
    let calls = 0;
    const first = await drainDefaults({
      maxProviderRequests: 1,
      listChanges: async () => {
        calls += 1;
        return { changes: [], nextPageToken: "page-2", newStartPageToken: null };
      },
    });
    expect(first).toMatchObject({
      status: "paused",
      stopReason: "api_request_limit",
      hardLimitReached: true,
      providerRequests: 1,
    });
    const resumed = await drainDefaults({
      maxProviderRequests: 1,
      checkpoint: first.checkpoint,
      listChanges: async () => {
        calls += 1;
        throw new Error("provider call must not occur after request exhaustion");
      },
    });
    expect(resumed).toMatchObject({
      status: "paused",
      stopReason: "api_request_limit",
      hardLimitReached: true,
      providerRequests: 1,
    });
    expect(calls).toBe(1);
  });

  test("rejects malformed or over-budget cumulative checkpoints", () => {
    const limits = { maxItems: 2, maxProviderRequests: 2, maxElapsedMs: 100 };
    const valid = {
      version: 2,
      pageToken: "page-2",
      requiresFullReconciliation: false,
      seenPageTokenHashes: ["a".repeat(64)],
      budget: { examinedItems: 1, providerRequests: 1, elapsedMs: 10 },
    } satisfies GoogleDriveChangesCheckpoint;
    expect(parseGoogleDriveChangesCheckpoint(valid, limits)).toEqual(valid);
    expect(
      parseGoogleDriveChangesCheckpoint(
        { ...valid, budget: { ...valid.budget, providerRequests: 3 } },
        limits,
      ),
    ).toBeNull();
    expect(
      parseGoogleDriveChangesCheckpoint(
        { ...valid, seenPageTokenHashes: ["a".repeat(64), "a".repeat(64)] },
        limits,
      ),
    ).toBeNull();
  });

  test("preserves cumulative elapsed time while allowing a bounded invocation resume", async () => {
    let firstClockIndex = 0;
    const firstClock = [0, 0, 31];
    let calls = 0;
    const first = await drainDefaults({
      maxElapsedMs: 100,
      maxInvocationElapsedMs: 30,
      now: () => firstClock[Math.min(firstClockIndex++, firstClock.length - 1)]!,
      listChanges: async () => {
        calls += 1;
        return { changes: [], nextPageToken: "page-2", newStartPageToken: null };
      },
    });
    expect(first).toMatchObject({
      status: "paused",
      stopReason: "elapsed_time_limit",
      hardLimitReached: false,
      elapsedMs: 31,
    });

    let secondClockIndex = 0;
    const secondClock = [31, 31, 40];
    const resumed = await drainDefaults({
      checkpoint: first.checkpoint,
      maxElapsedMs: 100,
      maxInvocationElapsedMs: 30,
      now: () => secondClock[Math.min(secondClockIndex++, secondClock.length - 1)]!,
      listChanges: async (token) => {
        calls += 1;
        expect(token).toBe("page-2");
        return { changes: [], nextPageToken: null, newStartPageToken: "start-2" };
      },
    });
    expect(resumed).toMatchObject({
      status: "complete",
      elapsedMs: 40,
      budget: { elapsedMs: 40, providerRequests: 2 },
    });
    expect(calls).toBe(2);
  });

  test("refuses a provider call after the cumulative elapsed budget is exhausted", async () => {
    let clockIndex = 0;
    const clock = [0, 0, 31];
    let calls = 0;
    const exhausted = await drainDefaults({
      maxElapsedMs: 31,
      maxInvocationElapsedMs: 30,
      now: () => clock[Math.min(clockIndex++, clock.length - 1)]!,
      listChanges: async () => {
        calls += 1;
        return { changes: [], nextPageToken: "page-2", newStartPageToken: null };
      },
    });
    expect(exhausted).toMatchObject({
      status: "paused",
      stopReason: "elapsed_time_limit",
      hardLimitReached: true,
      elapsedMs: 31,
    });
    const resumed = await drainDefaults({
      checkpoint: exhausted.checkpoint,
      maxElapsedMs: 31,
      maxInvocationElapsedMs: 30,
      now: () => 31,
      listChanges: async () => {
        calls += 1;
        throw new Error("provider call must not occur after elapsed exhaustion");
      },
    });
    expect(resumed).toMatchObject({
      status: "paused",
      stopReason: "elapsed_time_limit",
      hardLimitReached: true,
      elapsedMs: 31,
    });
    expect(calls).toBe(1);
  });

  test("rejects repeated page tokens before making an unbounded second call", async () => {
    let calls = 0;
    await expect(
      drainDefaults({
        listChanges: async () => {
          calls += 1;
          return { changes: [], nextPageToken: "start-1", newStartPageToken: null };
        },
      }),
    ).rejects.toBeInstanceOf(GoogleDriveChangesProtocolError);
    expect(calls).toBe(1);
  });

  test("rejects a provider page that exceeds the requested remaining item budget", async () => {
    await expect(
      drainDefaults({
        maxItems: 1,
        listChanges: async () => ({
          changes: [
            { fileId: "one", removed: true, file: null },
            { fileId: "two", removed: true, file: null },
          ],
          nextPageToken: null,
          newStartPageToken: "start-2",
        }),
      }),
    ).rejects.toBeInstanceOf(GoogleDriveChangesProtocolError);
  });

  test("escalates removals and reparenting of known objects to an authoritative full repair", async () => {
    const result = await drainDefaults({
      listChanges: async () => ({
        changes: [
          { fileId: "deleted", removed: true, file: null },
          { fileId: "moved", removed: false, file: file("moved", ["outside"]) },
        ],
        nextPageToken: null,
        newStartPageToken: "start-2",
      }),
      observedExternalObjectIds: async (ids) => new Set(ids),
    });
    expect(result.status).toBe("complete");
    expect(result.entries).toEqual([]);
    expect(result.requiresFullReconciliation).toBe(true);
    expect(result.newStartPageToken).toBe("start-2");
  });

  test("removes a same-window stale entry and forces repair after a later move", async () => {
    const result = await drainDefaults({
      listChanges: async () => ({
        changes: [
          { fileId: "same-window", removed: false, file: file("same-window", [source.id]) },
          { fileId: "same-window", removed: false, file: file("same-window", ["outside"]) },
        ],
        nextPageToken: null,
        newStartPageToken: "start-2",
      }),
    });
    expect(result.entries).toEqual([]);
    expect(result.requiresFullReconciliation).toBe(true);
  });

  test("carries cumulative delta budgets into the full-reconciliation checkpoint", async () => {
    const fullPageSizes: number[] = [];
    const provider: GoogleDriveSyncProviderPort = {
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
      getStartPageToken: async () => {
        throw new Error("delta-to-full must use the terminal changes token");
      },
      listChanges: async () => ({
        changes: [{ fileId: "removed", removed: true, file: null }],
        nextPageToken: null,
        newStartPageToken: "start-2",
      }),
      getFile: async () => null,
      listChildren: async (request) => {
        fullPageSizes.push(request.pageSize);
        return {
          items: [file("full-item", [source.id])],
          nextPageToken: "full-page-2",
          incompleteSearch: false,
        };
      },
    };
    const providerCursor = {
      ...cursorFor(),
      nextFullReconciliationAt: "2099-01-01T00:00:00.000Z",
    };
    const driver = driverFor(source, provider, async (ids) => new Set(ids), {
      maxItems: 2,
      maxProviderRequests: 2,
    });
    const result = await driver.inventory(null, providerCursor);
    expect(result).toMatchObject({
      status: "paused",
      stopReason: "elapsed_time_limit",
      hardLimitReached: false,
      providerRequests: 1,
      cursorInvalidated: false,
      checkpoint: {
        version: 3,
        kind: "google_drive_full_reconciliation",
        boundaryId: source.id,
        startPageToken: "start-2",
        budgetBeforeInventory: { examinedItems: 1, providerRequests: 1, elapsedMs: 0 },
        inventoryElapsedMs: 0,
        inventoryCheckpoint: null,
        revisionFloors: [],
      },
    });

    const full = await driver.inventory(result.checkpoint, providerCursor);
    expect(full).toMatchObject({
      status: "paused",
      stopReason: "item_limit",
      hardLimitReached: true,
      providerRequests: 2,
      checkpoint: {
        version: 3,
        kind: "google_drive_full_reconciliation",
        budgetBeforeInventory: { examinedItems: 1, providerRequests: 1, elapsedMs: 0 },
        inventoryCheckpoint: {
          totals: { itemCount: 1, apiRequestCount: 1 },
        },
        revisionFloors: [["full-item", "7"]],
      },
    });
    expect(full.entries.map((entry) => entry.externalObjectId)).toEqual(["full-item"]);
    expect(fullPageSizes).toEqual([1]);
    expect(full.providerCursor).toEqual(providerCursor);
  });

  test("preserves delta revision floors through full repair and checkpoint replay", async () => {
    let fullCalls = 0;
    const deltaFile = { ...file("doc-1", [source.id]), name: "delta-new.txt", version: "2" };
    const staleFullFile = { ...file("doc-1", [source.id]), name: "full-stale.txt", version: "1" };
    const provider: GoogleDriveSyncProviderPort = {
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
      getStartPageToken: async () => {
        throw new Error("delta-to-full must use the terminal changes token");
      },
      listChanges: async () => ({
        changes: [
          { fileId: deltaFile.id, removed: false, file: deltaFile },
          {
            fileId: "changed-folder",
            removed: false,
            file: file("changed-folder", [source.id], GOOGLE_DRIVE_FOLDER_MIME_TYPE),
          },
        ],
        nextPageToken: null,
        newStartPageToken: "start-after-v2",
      }),
      getFile: async () => null,
      listChildren: async () => {
        fullCalls += 1;
        return { items: [staleFullFile], nextPageToken: null, incompleteSearch: false };
      },
    };
    const providerCursor = {
      ...cursorFor(),
      nextFullReconciliationAt: "2099-01-01T00:00:00.000Z",
    };
    const driver = driverFor(source, provider);

    const handoff = await driver.inventory(null, providerCursor);
    expect(handoff).toMatchObject({
      status: "paused",
      entries: [
        {
          externalObjectId: "doc-1",
          externalVersionId: "2",
          title: "delta-new.txt",
        },
      ],
      checkpoint: {
        version: 3,
        kind: "google_drive_full_reconciliation",
        startPageToken: "start-after-v2",
        revisionFloors: [["doc-1", "2"]],
      },
      providerCursor,
    });

    const repaired = await driver.inventory(handoff.checkpoint, providerCursor);
    expect(repaired).toMatchObject({
      status: "complete",
      entries: [],
      authoritativeFullScan: true,
      providerCursor: { pageToken: "start-after-v2", cursorGeneration: 2 },
    });

    const replayed = await driver.inventory(handoff.checkpoint, providerCursor);
    expect(replayed).toMatchObject({
      status: "complete",
      entries: [],
      authoritativeFullScan: true,
      providerCursor: { pageToken: "start-after-v2", cursorGeneration: 2 },
    });
    expect(fullCalls).toBe(2);
  });

  test("keeps the durable version-8 floor when a lost full-page checkpoint replays version 7", async () => {
    const baseTime = Date.parse("2026-08-11T00:00:00.000Z");
    const clock = [baseTime, baseTime, baseTime, baseTime, baseTime + 30_000, baseTime + 30_000];
    let clockIndex = 0;
    let providerVersion = "8";
    const provider: GoogleDriveSyncProviderPort = {
      now: () => clock[Math.min(clockIndex++, clock.length - 1)]!,
      getStartPageToken: async () => {
        throw new Error("the durable pre-page checkpoint already owns the start token");
      },
      listChanges: async () => {
        throw new Error("the durable pre-page checkpoint must stay on the full path");
      },
      getFile: async () => null,
      listChildren: async () => ({
        items: [
          {
            ...file("full-only-doc", [source.id]),
            name: providerVersion === "8" ? "version-8.txt" : "stale.txt",
            version: providerVersion,
          },
        ],
        nextPageToken: "full-page-2",
        incompleteSearch: false,
      }),
    };
    const prePageCheckpoint = {
      version: 3,
      kind: "google_drive_full_reconciliation",
      connectionId: "00000000-0000-4000-8000-000000000127",
      googlePermissionId: "permission-1",
      sourceId: source.id,
      driveId: source.driveId,
      boundaryId: source.id,
      startPageToken: "start-after-full",
      cursorInvalidated: false,
      budgetBeforeInventory: { examinedItems: 0, providerRequests: 0, elapsedMs: 0 },
      inventoryElapsedMs: 0,
      inventoryCheckpoint: null,
      revisionFloors: [],
    };
    const driver = driverFor(source, provider, undefined, { maxElapsedSeconds: 60 });

    const accepted8 = await driver.inventory(prePageCheckpoint, null);
    expect(accepted8).toMatchObject({
      status: "paused",
      stopReason: "elapsed_time_limit",
      entries: [
        { externalObjectId: "full-only-doc", externalVersionId: "8", title: "version-8.txt" },
      ],
      checkpoint: { revisionFloors: [["full-only-doc", "8"]] },
    });

    // Model the process death by discarding accepted8.checkpoint and replaying
    // the exact same durable pre-page checkpoint against a stale provider page.
    providerVersion = "7";
    clockIndex = 0;
    const replayed7 = await driver.inventory(prePageCheckpoint, null);
    expect(replayed7).toMatchObject({
      status: "paused",
      stopReason: "elapsed_time_limit",
      entries: [{ externalObjectId: "full-only-doc", externalVersionId: "7", title: "stale.txt" }],
      checkpoint: { revisionFloors: [["full-only-doc", "7"]] },
    });

    const durableFloor = {
      externalObjectId: "full-only-doc",
      providerRevision: "8",
      metadataHash: "a".repeat(64),
      disposition: "stale" as const,
      currentVersion: {
        providerRevision: "8",
        metadataHash: "a".repeat(64),
        sourceLifecycleGeneration: 1,
        objectLifecycleGeneration: 1,
        currentObjectLifecycleGeneration: 1,
        objectLifecycleState: "active",
        aclGeneration: 1,
        indexObligationStatus: "indexed",
      },
    };
    expect(
      shouldProcessGoogleDriveDurableObservation({
        entry: replayed7.entries[0]!,
        observation: durableFloor,
        sourceLifecycleGeneration: 1,
        aclGeneration: 1,
      }),
    ).toBe(false);
    expect(
      mergeGoogleDriveDurableObservationFloors(replayed7.checkpoint, [durableFloor], 10),
    ).toMatchObject({ revisionFloors: [["full-only-doc", "8"]] });
    expect(() =>
      shouldProcessGoogleDriveDurableObservation({
        entry: replayed7.entries[0]!,
        observation: { ...durableFloor, currentVersion: null },
        sourceLifecycleGeneration: 1,
        aclGeneration: 1,
      }),
    ).toThrow("provider_payload_invalid");
  });

  test("fails before worker mutation when an equal revision conflicts with authoritative metadata", () => {
    const metadataHash8 = "a".repeat(64);
    const observation = {
      externalObjectId: "full-only-doc",
      providerRevision: "8",
      metadataHash: metadataHash8,
      disposition: "conflict" as const,
      currentVersion: {
        providerRevision: "8",
        metadataHash: metadataHash8,
        sourceLifecycleGeneration: 1,
        objectLifecycleGeneration: 1,
        currentObjectLifecycleGeneration: 1,
        objectLifecycleState: "active",
        aclGeneration: 1,
        indexObligationStatus: "indexed",
      },
    };
    const mutations: string[] = [];

    expect(() => {
      if (
        shouldProcessGoogleDriveDurableObservation({
          entry: { externalObjectId: "full-only-doc" },
          observation,
          sourceLifecycleGeneration: 1,
          aclGeneration: 1,
        })
      ) {
        mutations.push("metadata");
      }
      mutations.push("checkpoint", "cursor", "settlement");
    }).toThrow("provider_payload_invalid");
    expect(mutations).toEqual([]);
    expect(
      shouldProcessGoogleDriveDurableObservation({
        entry: { externalObjectId: "full-only-doc" },
        observation: { ...observation, disposition: "replayed" },
        sourceLifecycleGeneration: 1,
        aclGeneration: 1,
      }),
    ).toBe(true);
  });

  test("fails closed when fallback revisions conflict during delta-to-full repair", async () => {
    const deltaFile = {
      ...file("fallback-doc", [source.id]),
      version: null,
      modifiedTime: "2026-08-10T00:00:00.000Z",
    };
    const fullFile = {
      ...deltaFile,
      name: "fallback-stale.txt",
      modifiedTime: "2026-08-11T00:00:00.000Z",
    };
    const provider: GoogleDriveSyncProviderPort = {
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
      getStartPageToken: async () => {
        throw new Error("delta-to-full must use the terminal changes token");
      },
      listChanges: async () => ({
        changes: [
          { fileId: deltaFile.id, removed: false, file: deltaFile },
          {
            fileId: "changed-folder",
            removed: false,
            file: file("changed-folder", [source.id], GOOGLE_DRIVE_FOLDER_MIME_TYPE),
          },
        ],
        nextPageToken: null,
        newStartPageToken: "must-not-adopt",
      }),
      getFile: async () => null,
      listChildren: async () => ({
        items: [fullFile],
        nextPageToken: null,
        incompleteSearch: false,
      }),
    };
    const providerCursor = {
      ...cursorFor(),
      nextFullReconciliationAt: "2099-01-01T00:00:00.000Z",
    };
    const driver = driverFor(source, provider);
    const handoff = await driver.inventory(null, providerCursor);
    const repaired = await driver.inventory(handoff.checkpoint, providerCursor);

    expect(repaired).toMatchObject({
      status: "paused",
      stopReason: "incomplete_search",
      entries: [],
      authoritativeFullScan: false,
      providerCursor,
      checkpoint: {
        version: 3,
        revisionFloors: [["fallback-doc", "2026-08-10T00:00:00.000Z"]],
      },
    });
  });

  test("does not resume a changes checkpoint bound to another connection", async () => {
    const requestedTokens: string[] = [];
    const provider: GoogleDriveSyncProviderPort = {
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
      getStartPageToken: async () => {
        throw new Error("a valid cursor should keep this run on the changes path");
      },
      listChanges: async (pageToken) => {
        requestedTokens.push(pageToken);
        return { changes: [], nextPageToken: null, newStartPageToken: "start-2" };
      },
      getFile: async () => null,
      listChildren: async () => {
        throw new Error("a valid cursor should not full-repair without a repair trigger");
      },
    };
    const providerCursor = {
      ...cursorFor(),
      nextFullReconciliationAt: "2099-01-01T00:00:00.000Z",
    };
    const result = await driverFor(source, provider).inventory(
      {
        version: 2,
        kind: "google_drive_changes",
        connectionId: "00000000-0000-4000-8000-000000000999",
        googlePermissionId: "permission-1",
        sourceId: source.id,
        driveId: source.driveId,
        changesCheckpoint: {
          version: 2,
          pageToken: "attacker-page",
          requiresFullReconciliation: false,
          seenPageTokenHashes: [],
          budget: { examinedItems: 0, providerRequests: 0, elapsedMs: 0 },
        },
      },
      providerCursor,
    );
    expect(requestedTokens).toEqual(["start-1"]);
    expect(result).toMatchObject({
      status: "complete",
      providerCursor: { pageToken: "start-2", cursorGeneration: 2 },
    });
  });

  test("replays unsettled Changes before replacing a legacy full checkpoint", async () => {
    const requestedTokens: string[] = [];
    const provider: GoogleDriveSyncProviderPort = {
      now: () => Date.parse("2026-08-11T12:00:00.000Z"),
      getStartPageToken: async () => {
        throw new Error("the unsettled Changes window must replay first");
      },
      listChanges: async (pageToken) => {
        requestedTokens.push(pageToken);
        return {
          changes: [
            {
              fileId: "legacy-delta",
              removed: false,
              file: { ...file("legacy-delta", [source.id]), version: "2" },
            },
          ],
          nextPageToken: null,
          newStartPageToken: "start-after-legacy",
        };
      },
      getFile: async () => null,
      listChildren: async () => {
        throw new Error("the replacement full checkpoint must settle the delta first");
      },
    };
    const providerCursor = {
      ...cursorFor(),
      nextFullReconciliationAt: "2026-08-11T00:00:00.000Z",
    };
    const result = await driverFor(source, provider).inventory(
      {
        version: 2,
        kind: "google_drive_full_reconciliation",
        connectionId: providerCursor.connectionId,
        googlePermissionId: providerCursor.googlePermissionId,
        sourceId: providerCursor.sourceId,
        driveId: providerCursor.driveId,
        boundaryId: providerCursor.boundaryId,
        startPageToken: "legacy-terminal",
        cursorInvalidated: false,
        budgetBeforeInventory: { examinedItems: 1, providerRequests: 1, elapsedMs: 0 },
        inventoryElapsedMs: 0,
        inventoryCheckpoint: null,
      },
      providerCursor,
    );

    expect(requestedTokens).toEqual(["start-1"]);
    expect(result).toMatchObject({
      status: "paused",
      entries: [{ externalObjectId: "legacy-delta", externalVersionId: "2" }],
      checkpoint: {
        version: 3,
        kind: "google_drive_full_reconciliation",
        startPageToken: "start-after-legacy",
        revisionFloors: [["legacy-delta", "2"]],
      },
      providerCursor,
    });
  });

  test("captures a start token, resolves My Drive root, then stores the actual boundary", async () => {
    const calls: string[] = [];
    const provider: GoogleDriveSyncProviderPort = {
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
      getStartPageToken: async () => {
        calls.push("start");
        return "start-1";
      },
      listChanges: async () => {
        throw new Error("initial repair must not drain changes");
      },
      getFile: async (id) => {
        calls.push(`file:${id}`);
        return file("actual-root-id", [], GOOGLE_DRIVE_FOLDER_MIME_TYPE, null);
      },
      listChildren: async (request) => {
        calls.push(`list:${request.folderId}`);
        return { items: [], nextPageToken: null, incompleteSearch: false };
      },
    };
    const result = await driverFor(myDriveSource, provider).inventory(null, null);
    expect(result).toMatchObject({
      status: "complete",
      authoritativeFullScan: true,
      providerRequests: 3,
      hardLimitReached: false,
      providerCursor: {
        kind: "google_drive_changes",
        sourceId: "root",
        boundaryId: "actual-root-id",
        pageToken: "start-1",
      },
    });
    expect(calls).toEqual(["start", "file:root", "list:root"]);
  });
});
