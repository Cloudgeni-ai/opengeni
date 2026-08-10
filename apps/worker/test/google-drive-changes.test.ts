import { describe, expect, test } from "bun:test";
import type { GoogleDriveSelectedSource } from "@opengeni/contracts/google-drive";
import type { GoogleDriveInventoryProviderItem } from "@opengeni/documents/google-drive";
import {
  buildGoogleDriveChangesCursor,
  drainGoogleDriveChanges,
  googleDriveFullReconciliationDue,
  parseGoogleDriveChangesCursor,
} from "../src/activities/google-drive-changes";

const source: GoogleDriveSelectedSource = {
  id: "folder-root",
  name: "Knowledge",
  mimeType: "application/vnd.google-apps.folder",
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

function file(
  id: string,
  parents: string[],
  mimeType = "text/plain",
): GoogleDriveInventoryProviderItem {
  return {
    id,
    name: `${id}.txt`,
    mimeType,
    driveId: "shared-drive",
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

describe("Google Drive Changes cursor and reconciliation planner", () => {
  test("binds cursors to the exact connection, permission, source, and Shared Drive", () => {
    const cursor = buildGoogleDriveChangesCursor({
      connectionId: "00000000-0000-4000-8000-000000000127",
      googlePermissionId: "permission-1",
      sourceId: source.id,
      driveId: "shared-drive",
      pageToken: "start-1",
      previousGeneration: 0,
      reconciledAt: new Date("2026-08-10T00:00:00.000Z"),
      fullReconciliationIntervalMs: 86_400_000,
    });
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
    expect(googleDriveFullReconciliationDue(cursor, new Date("2026-08-10T23:59:59Z"))).toBe(false);
    expect(googleDriveFullReconciliationDue(cursor, new Date("2026-08-11T00:00:00Z"))).toBe(true);
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
    const result = await drainGoogleDriveChanges({
      source,
      cursor: buildGoogleDriveChangesCursor({
        connectionId: "00000000-0000-4000-8000-000000000127",
        googlePermissionId: "permission-1",
        sourceId: source.id,
        driveId: source.driveId,
        pageToken: "start-1",
        previousGeneration: 0,
        reconciledAt: new Date("2026-08-10T00:00:00Z"),
        fullReconciliationIntervalMs: 86_400_000,
      }),
      checkpoint: null,
      maxItems: 10,
      maxProviderRequests: 10,
      maxElapsedMs: 10_000,
      maxFileBytes: 1_000,
      listChanges: async (token) => pages.get(token)!,
      getFile: async (id) => (id === "child" ? file("child", [source.id], source.mimeType) : null),
      observedExternalObjectIds: async () => new Set(),
    });
    expect(result.status).toBe("complete");
    expect(result.newStartPageToken).toBe("start-2");
    expect(result.requiresFullReconciliation).toBe(false);
    expect(result.entries.map((entry) => entry.externalObjectId).sort()).toEqual([
      "direct",
      "nested",
    ]);
    expect(result.providerRequests).toBe(3);
  });

  test("sizes each changes page to the remaining item budget", async () => {
    const pageSizes: number[] = [];
    const result = await drainGoogleDriveChanges({
      source,
      cursor: buildGoogleDriveChangesCursor({
        connectionId: "00000000-0000-4000-8000-000000000127",
        googlePermissionId: "permission-1",
        sourceId: source.id,
        driveId: source.driveId,
        pageToken: "start-1",
        previousGeneration: 0,
        reconciledAt: new Date("2026-08-10T00:00:00Z"),
        fullReconciliationIntervalMs: 86_400_000,
      }),
      checkpoint: null,
      maxItems: 2,
      maxProviderRequests: 10,
      maxElapsedMs: 10_000,
      maxFileBytes: 1_000,
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
      getFile: async () => null,
      observedExternalObjectIds: async () => new Set(),
    });
    expect(result.status).toBe("paused");
    expect(result.entries.map((entry) => entry.externalObjectId)).toEqual(["first", "second"]);
    expect(result.checkpoint?.pageToken).toBe("page-3");
    expect(pageSizes).toEqual([2, 1]);
  });

  test("escalates removals and reparenting of known objects to an authoritative full repair", async () => {
    const result = await drainGoogleDriveChanges({
      source,
      cursor: buildGoogleDriveChangesCursor({
        connectionId: "00000000-0000-4000-8000-000000000127",
        googlePermissionId: "permission-1",
        sourceId: source.id,
        driveId: source.driveId,
        pageToken: "start-1",
        previousGeneration: 0,
        reconciledAt: new Date("2026-08-10T00:00:00Z"),
        fullReconciliationIntervalMs: 86_400_000,
      }),
      checkpoint: null,
      maxItems: 10,
      maxProviderRequests: 10,
      maxElapsedMs: 10_000,
      maxFileBytes: 1_000,
      listChanges: async () => ({
        changes: [
          { fileId: "deleted", removed: true, file: null },
          { fileId: "moved", removed: false, file: file("moved", ["outside"]) },
        ],
        nextPageToken: null,
        newStartPageToken: "start-2",
      }),
      getFile: async () => null,
      observedExternalObjectIds: async (ids) => new Set(ids),
    });
    expect(result.status).toBe("complete");
    expect(result.entries).toEqual([]);
    expect(result.requiresFullReconciliation).toBe(true);
    expect(result.newStartPageToken).toBe("start-2");
  });
});
