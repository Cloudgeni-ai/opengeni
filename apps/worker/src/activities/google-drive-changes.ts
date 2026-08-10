import type { GoogleDriveSelectedSource } from "@opengeni/contracts/google-drive";
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  planGoogleDriveTransfer,
  type GoogleDriveInventoryEntry,
  type GoogleDriveInventoryProviderItem,
} from "@opengeni/documents/google-drive";

const MAX_TOKEN_CHARS = 4096;
const MAX_ANCESTOR_DEPTH = 100;

export type GoogleDriveChangesCursor = {
  version: 1;
  kind: "google_drive_changes";
  connectionId: string;
  googlePermissionId: string;
  sourceId: string;
  driveId: string | null;
  pageToken: string;
  cursorGeneration: number;
  lastFullReconciliationAt: string;
  nextFullReconciliationAt: string;
};

export type GoogleDriveChangesCheckpoint = {
  version: 1;
  pageToken: string;
  requiresFullReconciliation: boolean;
};

export type GoogleDriveChange = {
  fileId: string;
  removed: boolean;
  file: GoogleDriveInventoryProviderItem | null;
};

export type GoogleDriveChangesPage = {
  changes: GoogleDriveChange[];
  nextPageToken: string | null;
  newStartPageToken: string | null;
};

export type GoogleDriveChangesDrainResult = {
  status: "complete" | "paused";
  entries: GoogleDriveInventoryEntry[];
  checkpoint: GoogleDriveChangesCheckpoint | null;
  newStartPageToken: string | null;
  requiresFullReconciliation: boolean;
  providerRequests: number;
  elapsedMs: number;
};

export function parseGoogleDriveChangesCursor(
  value: Record<string, unknown> | null,
  expected: {
    connectionId: string;
    googlePermissionId: string;
    sourceId: string;
    driveId: string | null;
  },
): GoogleDriveChangesCursor | null {
  if (!value || value.version !== 1 || value.kind !== "google_drive_changes") return null;
  if (
    value.connectionId !== expected.connectionId ||
    value.googlePermissionId !== expected.googlePermissionId ||
    value.sourceId !== expected.sourceId ||
    value.driveId !== expected.driveId ||
    typeof value.pageToken !== "string" ||
    value.pageToken.length < 1 ||
    value.pageToken.length > MAX_TOKEN_CHARS ||
    typeof value.cursorGeneration !== "number" ||
    !Number.isSafeInteger(value.cursorGeneration) ||
    value.cursorGeneration < 1 ||
    typeof value.lastFullReconciliationAt !== "string" ||
    !Number.isFinite(Date.parse(value.lastFullReconciliationAt)) ||
    typeof value.nextFullReconciliationAt !== "string" ||
    !Number.isFinite(Date.parse(value.nextFullReconciliationAt))
  ) {
    return null;
  }
  return value as GoogleDriveChangesCursor;
}

export function buildGoogleDriveChangesCursor(input: {
  connectionId: string;
  googlePermissionId: string;
  sourceId: string;
  driveId: string | null;
  pageToken: string;
  previousGeneration: number;
  reconciledAt: Date;
  fullReconciliationIntervalMs: number;
}): GoogleDriveChangesCursor {
  return {
    version: 1,
    kind: "google_drive_changes",
    connectionId: input.connectionId,
    googlePermissionId: input.googlePermissionId,
    sourceId: input.sourceId,
    driveId: input.driveId,
    pageToken: boundedToken(input.pageToken),
    cursorGeneration: input.previousGeneration + 1,
    lastFullReconciliationAt: input.reconciledAt.toISOString(),
    nextFullReconciliationAt: new Date(
      input.reconciledAt.getTime() + input.fullReconciliationIntervalMs,
    ).toISOString(),
  };
}

export function advanceGoogleDriveChangesCursor(
  cursor: GoogleDriveChangesCursor,
  pageToken: string,
): GoogleDriveChangesCursor {
  return {
    ...cursor,
    pageToken: boundedToken(pageToken),
    cursorGeneration: cursor.cursorGeneration + 1,
  };
}

export function googleDriveFullReconciliationDue(cursor: GoogleDriveChangesCursor, now: Date) {
  return Date.parse(cursor.nextFullReconciliationAt) <= now.getTime();
}

export async function drainGoogleDriveChanges(input: {
  source: GoogleDriveSelectedSource;
  cursor: GoogleDriveChangesCursor;
  checkpoint: GoogleDriveChangesCheckpoint | null;
  maxItems: number;
  maxProviderRequests: number;
  maxElapsedMs: number;
  maxFileBytes: number;
  listChanges: (pageToken: string, pageSize: number) => Promise<GoogleDriveChangesPage>;
  getFile: (fileId: string) => Promise<GoogleDriveInventoryProviderItem | null>;
  observedExternalObjectIds: (ids: string[]) => Promise<Set<string>>;
}): Promise<GoogleDriveChangesDrainResult> {
  const startedAt = Date.now();
  let pageToken = boundedToken(input.checkpoint?.pageToken ?? input.cursor.pageToken);
  let requiresFullReconciliation = input.checkpoint?.requiresFullReconciliation ?? false;
  let providerRequests = 0;
  const entries = new Map<string, GoogleDriveInventoryEntry>();

  while (true) {
    if (
      entries.size >= input.maxItems ||
      providerRequests >= input.maxProviderRequests ||
      Date.now() - startedAt >= input.maxElapsedMs
    ) {
      return {
        status: "paused",
        entries: [...entries.values()],
        checkpoint: { version: 1, pageToken, requiresFullReconciliation },
        newStartPageToken: null,
        requiresFullReconciliation,
        providerRequests,
        elapsedMs: Date.now() - startedAt,
      };
    }
    providerRequests += 1;
    const page = await input.listChanges(pageToken, Math.min(100, input.maxItems - entries.size));
    const repairCandidates = new Set<string>();
    for (const change of page.changes) {
      if (change.removed || !change.file || change.file.trashed) {
        repairCandidates.add(change.fileId);
        continue;
      }
      const membership = await isInsideSource({
        file: change.file,
        source: input.source,
        getFile: async (fileId) => {
          if (providerRequests >= input.maxProviderRequests) return null;
          providerRequests += 1;
          return await input.getFile(fileId);
        },
      });
      if (change.file.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
        if (membership !== "outside") requiresFullReconciliation = true;
        else repairCandidates.add(change.fileId);
        continue;
      }
      if (membership === "inside") {
        entries.set(change.fileId, toInventoryEntry(change.file, input.source, input.maxFileBytes));
      } else if (membership === "unknown") {
        requiresFullReconciliation = true;
      } else {
        repairCandidates.add(change.fileId);
      }
    }
    if (repairCandidates.size > 0) {
      const observed = await input.observedExternalObjectIds([...repairCandidates]);
      if (observed.size > 0) requiresFullReconciliation = true;
    }
    if (page.nextPageToken) {
      pageToken = boundedToken(page.nextPageToken);
      continue;
    }
    if (!page.newStartPageToken) throw new Error("google_drive_changes_terminal_token_missing");
    return {
      status: "complete",
      entries: [...entries.values()],
      checkpoint: null,
      newStartPageToken: boundedToken(page.newStartPageToken),
      requiresFullReconciliation,
      providerRequests,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

async function isInsideSource(input: {
  file: GoogleDriveInventoryProviderItem;
  source: GoogleDriveSelectedSource;
  getFile: (fileId: string) => Promise<GoogleDriveInventoryProviderItem | null>;
}): Promise<"inside" | "outside" | "unknown"> {
  if (input.file.id === input.source.id) return "inside";
  let parents = input.file.parents;
  const seen = new Set<string>([input.file.id]);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (parents.includes(input.source.id)) return "inside";
    const next = parents.find((parent) => !seen.has(parent));
    if (!next) return "outside";
    seen.add(next);
    const parent = await input.getFile(next);
    if (!parent) return "unknown";
    parents = parent.parents;
  }
  return "unknown";
}

function toInventoryEntry(
  file: GoogleDriveInventoryProviderItem,
  source: GoogleDriveSelectedSource,
  maxFileBytes: number,
): GoogleDriveInventoryEntry {
  return {
    externalObjectId: file.id,
    externalVersionId: file.version ?? file.modifiedTime ?? file.md5Checksum,
    sourceId: source.id,
    parentFolderId: file.parents[0] ?? source.id,
    driveId: file.driveId ?? source.driveId,
    title: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    sourceUri:
      file.webViewLink ?? `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
    transfer: planGoogleDriveTransfer(file, maxFileBytes),
  };
}

function boundedToken(value: string): string {
  if (value.length < 1 || value.length > MAX_TOKEN_CHARS) {
    throw new Error("google_drive_changes_token_invalid");
  }
  return value;
}
