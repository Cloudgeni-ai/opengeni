import { describe, expect, test } from "bun:test";
import type { GoogleDriveSelectedSource } from "@opengeni/contracts/google-drive";
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  GOOGLE_DRIVE_SHORTCUT_MIME_TYPE,
  GoogleDriveInventoryProviderError,
  googleDriveKnowledgeScope,
  googleDriveKnowledgeSourceIdentity,
  inventoryGoogleDriveSource,
  planGoogleDriveTransfer,
  type GoogleDriveInventoryLimits,
  type GoogleDriveInventoryProviderItem,
} from "../src/google-drive";

const workspaceId = "00000000-0000-4000-8000-000000000125";
const subjectId = "user:drive-owner";

const source: GoogleDriveSelectedSource = {
  id: "folder-root",
  name: "Knowledge",
  mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  driveId: "shared-drive",
  targetScope: "workspace",
  syncCadence: "hourly",
  readPolicy: "allow",
  selectedAt: "2026-08-02T00:00:00.000Z",
};

const limits: GoogleDriveInventoryLimits = {
  maxItems: 100,
  maxKnownBytes: 10_000,
  maxApiRequests: 20,
  maxElapsedMs: 10_000,
  maxFileBytes: 5_000,
  maxFolders: 20,
  pageSize: 100,
};

function item(
  input: Partial<GoogleDriveInventoryProviderItem> &
    Pick<GoogleDriveInventoryProviderItem, "id" | "name" | "mimeType">,
): GoogleDriveInventoryProviderItem {
  return {
    driveId: "shared-drive",
    parents: ["folder-root"],
    modifiedTime: "2026-08-02T00:00:00.000Z",
    createdTime: "2026-08-01T00:00:00.000Z",
    version: "1",
    md5Checksum: null,
    size: null,
    webViewLink: `https://drive.google.com/open?id=${input.id}`,
    trashed: false,
    ...input,
  };
}

describe("Google Drive scoped source identity", () => {
  test("maps the picker scopes to the three fixed knowledge authorities", () => {
    expect(googleDriveKnowledgeScope("organization", workspaceId, subjectId)).toEqual({
      kind: "organization",
      workspaceId: null,
      subjectId: null,
    });
    expect(googleDriveKnowledgeScope("workspace", workspaceId, subjectId)).toEqual({
      kind: "workspace",
      workspaceId,
      subjectId: null,
    });
    expect(googleDriveKnowledgeScope("user", workspaceId, subjectId)).toEqual({
      kind: "personal",
      workspaceId,
      subjectId,
    });
  });

  test("preserves stable Google tenant and selected boundary identity", () => {
    expect(
      googleDriveKnowledgeSourceIdentity({
        googlePermissionId: "permission-123",
        source,
        workspaceId,
        initiatingSubjectId: subjectId,
      }),
    ).toEqual({
      providerKey: "google-drive",
      externalTenantId: "permission-123",
      externalSourceId: "folder-root",
      sourceKind: "google-drive-folder",
      sourceUri: "https://drive.google.com/drive/folders/folder-root",
      scope: { kind: "workspace", workspaceId, subjectId: null },
    });
  });
});

describe("Google Drive transfer planning", () => {
  test("uses deterministic dependency-free PDF exports for Workspace-native files", () => {
    expect(
      planGoogleDriveTransfer(
        item({
          id: "doc-1",
          name: "Quarterly plan",
          mimeType: "application/vnd.google-apps.document",
        }),
        limits.maxFileBytes,
      ),
    ).toEqual({
      action: "export",
      contentType: "application/pdf",
      filename: "Quarterly plan.pdf",
      declaredBytes: null,
    });
    expect(
      planGoogleDriveTransfer(
        item({
          id: "sheet-1",
          name: "Forecast",
          mimeType: "application/vnd.google-apps.spreadsheet",
        }),
        limits.maxFileBytes,
      ),
    ).toMatchObject({ action: "export", contentType: "application/pdf", filename: "Forecast.pdf" });
    expect(
      planGoogleDriveTransfer(
        item({
          id: "slides-1",
          name: "Launch",
          mimeType: "application/vnd.google-apps.presentation",
        }),
        limits.maxFileBytes,
      ),
    ).toMatchObject({ action: "export", contentType: "application/pdf", filename: "Launch.pdf" });
    expect(
      planGoogleDriveTransfer(
        item({
          id: "drawing-1",
          name: "System map",
          mimeType: "application/vnd.google-apps.drawing",
        }),
        limits.maxFileBytes,
      ),
    ).toMatchObject({ action: "export", filename: "System map.pdf" });
  });

  test("fails unsupported, shortcut, and oversized items independently", () => {
    expect(
      planGoogleDriveTransfer(
        item({ id: "form", name: "Survey", mimeType: "application/vnd.google-apps.form" }),
        limits.maxFileBytes,
      ),
    ).toEqual({ action: "skip", reason: "unsupported_native_type" });
    expect(
      planGoogleDriveTransfer(
        item({ id: "shortcut", name: "Alias", mimeType: GOOGLE_DRIVE_SHORTCUT_MIME_TYPE }),
        limits.maxFileBytes,
      ),
    ).toEqual({ action: "skip", reason: "shortcut_unsupported" });
    expect(
      planGoogleDriveTransfer(
        item({ id: "zip", name: "Archive.zip", mimeType: "application/zip", size: "10" }),
        limits.maxFileBytes,
      ),
    ).toEqual({ action: "skip", reason: "unsupported_file_type" });
    expect(
      planGoogleDriveTransfer(
        item({ id: "pdf", name: "Large.pdf", mimeType: "application/pdf", size: "5001" }),
        limits.maxFileBytes,
      ),
    ).toEqual({ action: "skip", reason: "file_too_large" });
    expect(
      planGoogleDriveTransfer(
        item({
          id: "office",
          name: "Dependency.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: "10",
        }),
        limits.maxFileBytes,
      ),
    ).toEqual({ action: "skip", reason: "unsupported_file_type" });
    expect(
      planGoogleDriveTransfer(
        item({
          id: "generic-text",
          name: "Notes.txt",
          mimeType: "application/octet-stream",
          size: "10",
        }),
        limits.maxFileBytes,
      ),
    ).toMatchObject({ action: "download", contentType: "text/plain" });
    expect(
      planGoogleDriveTransfer(
        item({
          id: "trash-folder",
          name: "Deleted folder",
          mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
          trashed: true,
        }),
        limits.maxFileBytes,
      ),
    ).toEqual({ action: "skip", reason: "trashed" });
  });
});

describe("bounded Google Drive inventory", () => {
  test("walks paginated folders, isolates poison items, and preserves stable versions", async () => {
    const requests: string[] = [];
    const result = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits,
      listChildren: async ({ folderId, pageToken }) => {
        requests.push(`${folderId}:${pageToken ?? "first"}`);
        if (folderId === "folder-root" && pageToken === null) {
          return {
            items: [
              item({ id: "child", name: "Child", mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE }),
              item({
                id: "doc-1",
                name: "Plan",
                mimeType: "application/vnd.google-apps.document",
                version: "7",
              }),
            ],
            nextPageToken: "next",
            incompleteSearch: false,
          };
        }
        if (folderId === "folder-root") {
          return {
            items: [
              item({ id: "archive", name: "Archive.zip", mimeType: "application/zip", size: "12" }),
            ],
            nextPageToken: null,
            incompleteSearch: false,
          };
        }
        return {
          items: [
            item({
              id: "notes",
              name: "Notes.txt",
              mimeType: "text/plain",
              size: "20",
              version: null,
              md5Checksum: "abc123",
            }),
          ],
          nextPageToken: null,
          incompleteSearch: false,
        };
      },
    });

    expect(result.status).toBe("complete");
    expect(result.checkpoint).toBeNull();
    expect(requests).toEqual(["folder-root:first", "folder-root:next", "child:first"]);
    expect(result.entries.map((entry) => [entry.externalObjectId, entry.transfer.action])).toEqual([
      ["child", "traverse"],
      ["doc-1", "export"],
      ["archive", "skip"],
      ["notes", "download"],
    ]);
    expect(
      result.entries.find((entry) => entry.externalObjectId === "doc-1")?.externalVersionId,
    ).toBe("7");
    expect(
      result.entries.find((entry) => entry.externalObjectId === "notes")?.externalVersionId,
    ).toBe("abc123");
    expect(result.totals).toMatchObject({
      itemCount: 4,
      folderCount: 2,
      plannedFileCount: 2,
      skippedItemCount: 1,
      exportFileCount: 1,
      downloadFileCount: 1,
      apiRequestCount: 3,
      knownBytes: "20",
    });
  });

  test("buffers the unprocessed page so a byte-limit resume makes no duplicate request", async () => {
    let requests = 0;
    const first = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits: { ...limits, maxKnownBytes: 1 },
      listChildren: async () => {
        requests += 1;
        return {
          items: [
            item({ id: "one", name: "One.txt", mimeType: "text/plain", size: "1" }),
            item({ id: "two", name: "Two.txt", mimeType: "text/plain", size: "1" }),
          ],
          nextPageToken: null,
          incompleteSearch: false,
        };
      },
    });
    expect(first.status).toBe("paused");
    expect(first.stopReason).toBe("known_byte_limit");
    expect(first.entries.map((entry) => entry.externalObjectId)).toEqual(["one"]);
    expect(requests).toBe(1);

    const resumed = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits: { ...limits, maxKnownBytes: 2 },
      checkpoint: first.checkpoint,
      listChildren: async () => {
        requests += 1;
        throw new Error("buffered resume must not refetch the page");
      },
    });
    expect(resumed.status).toBe("complete");
    expect(resumed.entries.map((entry) => entry.externalObjectId)).toEqual(["two"]);
    expect(resumed.run.itemCount).toBe(1);
    expect(resumed.run.apiRequestCount).toBe(0);
    expect(requests).toBe(1);
  });

  test("does not advance an incomplete or failed provider page", async () => {
    const incomplete = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits,
      listChildren: async () => ({
        items: [item({ id: "hidden", name: "Hidden.txt", mimeType: "text/plain", size: "1" })],
        nextPageToken: "next",
        incompleteSearch: true,
      }),
    });
    expect(incomplete.stopReason).toBe("incomplete_search");
    expect(incomplete.entries).toEqual([]);
    expect(incomplete.checkpoint?.pendingFolders[0]).toMatchObject({
      folderId: "folder-root",
      pageToken: null,
      loaded: false,
    });

    const failed = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits,
      listChildren: async () => {
        throw new GoogleDriveInventoryProviderError("rate_limited");
      },
    });
    expect(failed.stopReason).toBe("provider_error");
    expect(failed.issues).toEqual([
      { code: "provider_error", folderId: "folder-root", providerCode: "rate_limited" },
    ]);
    expect(failed.totals.apiRequestCount).toBe(1);
    expect(failed.totals.itemCount).toBe(0);
  });

  test("leaves the byte-limit item buffered until the caller explicitly raises the bound", async () => {
    const first = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits: { ...limits, maxKnownBytes: 5 },
      listChildren: async () => ({
        items: [item({ id: "ten", name: "Ten.txt", mimeType: "text/plain", size: "10" })],
        nextPageToken: null,
        incompleteSearch: false,
      }),
    });
    expect(first.stopReason).toBe("known_byte_limit");
    expect(first.entries).toEqual([]);
    expect(first.checkpoint?.pendingFolders[0]?.bufferedItems).toHaveLength(1);

    const resumed = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits: { ...limits, maxKnownBytes: 10 },
      checkpoint: first.checkpoint,
      listChildren: async () => {
        throw new Error("buffered resume must not refetch the page");
      },
    });
    expect(resumed.status).toBe("complete");
    expect(resumed.entries.map((entry) => entry.externalObjectId)).toEqual(["ten"]);
    expect(resumed.totals.knownBytes).toBe("10");
  });

  test("rejects a checkpoint whose serialized totals do not match its folder graph", async () => {
    const first = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source,
      workspaceId,
      initiatingSubjectId: subjectId,
      limits: { ...limits, maxItems: 1 },
      listChildren: async () => ({
        items: [item({ id: "one", name: "One.txt", mimeType: "text/plain", size: "1" })],
        nextPageToken: "next",
        incompleteSearch: false,
      }),
    });
    const tampered = structuredClone(first.checkpoint!);
    tampered.totals.folderCount += 1;
    await expect(
      inventoryGoogleDriveSource({
        googlePermissionId: "permission-123",
        source,
        workspaceId,
        initiatingSubjectId: subjectId,
        limits: { ...limits, maxItems: 2 },
        checkpoint: tampered,
        listChildren: async () => {
          throw new Error("invalid checkpoint must fail before provider access");
        },
      }),
    ).rejects.toThrow("checkpoint totals are inconsistent");
  });

  test("compares checkpoint authority fields without delimiter collisions", async () => {
    const first = await inventoryGoogleDriveSource({
      googlePermissionId: "permission-123",
      source: { ...source, targetScope: "personal" },
      workspaceId: "workspace",
      initiatingSubjectId: "subject:a:b",
      limits: { ...limits, maxItems: 1 },
      listChildren: async () => ({
        items: [item({ id: "one", name: "One.txt", mimeType: "text/plain", size: "1" })],
        nextPageToken: "next",
        incompleteSearch: false,
      }),
    });
    const tampered = structuredClone(first.checkpoint!);
    tampered.scope = {
      kind: "personal",
      workspaceId: "workspace:subject",
      subjectId: "a:b",
    };
    await expect(
      inventoryGoogleDriveSource({
        googlePermissionId: "permission-123",
        source: { ...source, targetScope: "personal" },
        workspaceId: "workspace",
        initiatingSubjectId: "subject:a:b",
        limits: { ...limits, maxItems: 2 },
        checkpoint: tampered,
        listChildren: async () => {
          throw new Error("authority mismatch must fail before provider access");
        },
      }),
    ).rejects.toThrow("does not match the selected source");
  });
});
