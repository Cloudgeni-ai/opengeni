import type { ScopedKnowledgeScope } from "@opengeni/contracts";
import type {
  GoogleDriveSelectedSource,
  GoogleDriveTargetScope,
} from "@opengeni/contracts/google-drive";

export const GOOGLE_DRIVE_PROVIDER_KEY = "google-drive" as const;
export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder" as const;
export const GOOGLE_DRIVE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut" as const;

const GOOGLE_DRIVE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";
const GOOGLE_DRIVE_MAX_ID_CHARS = 256;
const GOOGLE_DRIVE_MAX_NAME_CHARS = 1024;
const GOOGLE_DRIVE_MAX_MIME_CHARS = 256;
const GOOGLE_DRIVE_MAX_PAGE_TOKEN_CHARS = 4096;
const GOOGLE_DRIVE_MAX_PAGE_ITEMS = 100;
const GOOGLE_DRIVE_MAX_CHECKPOINT_FOLDERS = 2_000;
const GOOGLE_DRIVE_MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;

const GOOGLE_DRIVE_NATIVE_EXPORTS = new Map<string, { contentType: string; extension: string }>([
  [
    "application/vnd.google-apps.document",
    {
      contentType: "application/pdf",
      extension: ".pdf",
    },
  ],
  [
    "application/vnd.google-apps.spreadsheet",
    {
      contentType: "application/pdf",
      extension: ".pdf",
    },
  ],
  [
    "application/vnd.google-apps.presentation",
    {
      contentType: "application/pdf",
      extension: ".pdf",
    },
  ],
  ["application/vnd.google-apps.drawing", { contentType: "application/pdf", extension: ".pdf" }],
]);

const DEPENDENCY_FREE_ORDINARY_CONTENT_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);

const GENERIC_BINARY_CONTENT_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);

const DEPENDENCY_FREE_EXTENSION_CONTENT_TYPES = new Map([
  [".csv", "text/csv"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".markdown", "text/markdown"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".text", "text/plain"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/x-yaml"],
  [".yml", "application/x-yaml"],
]);

export type GoogleDriveKnowledgeSourceIdentity = {
  providerKey: typeof GOOGLE_DRIVE_PROVIDER_KEY;
  externalTenantId: string;
  externalSourceId: string;
  sourceKind: "google-drive-my-drive" | "google-drive-shared-drive" | "google-drive-folder";
  sourceUri: string;
  scope: ScopedKnowledgeScope;
};

/**
 * Normalized item metadata expected from a bounded Drive files.list adapter.
 * The adapter owns provider JSON validation; this planner owns traversal,
 * checkpointing, resource limits, stable identity, and transfer classification.
 */
export type GoogleDriveInventoryProviderItem = {
  id: string;
  name: string;
  mimeType: string;
  driveId: string | null;
  parents: string[];
  modifiedTime: string | null;
  createdTime: string | null;
  version: string | null;
  md5Checksum: string | null;
  size: string | null;
  webViewLink: string | null;
  trashed: boolean;
};

export type GoogleDriveInventoryPage = {
  items: GoogleDriveInventoryProviderItem[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
};

export type GoogleDriveInventoryLimits = {
  /** Hard cumulative provider-item discovery limit for this checkpoint. */
  maxItems: number;
  /** Hard cumulative known-byte limit for ordinary file downloads. */
  maxKnownBytes: number;
  /** Hard cumulative Drive list request/cost limit for this checkpoint. */
  maxApiRequests: number;
  /** Wall-clock budget for one invocation; checkpoint counters remain cumulative. */
  maxElapsedMs: number;
  /** Per-file byte ceiling. Unknown/export sizes must be enforced again while streaming. */
  maxFileBytes: number;
  /** Cycle/graph explosion guard for traversed folders. */
  maxFolders: number;
  /** Requested Drive page size. */
  pageSize: number;
};

export type GoogleDriveTransferSkipReason =
  | "file_too_large"
  | "folder_limit"
  | "folder_loop"
  | "shortcut_unsupported"
  | "trashed"
  | "unsupported_file_type"
  | "unsupported_native_type";

export type GoogleDriveTransferPlan =
  | { action: "traverse" }
  | {
      action: "export";
      contentType: string;
      filename: string;
      declaredBytes: null;
    }
  | {
      action: "download";
      contentType: string;
      filename: string;
      declaredBytes: string | null;
    }
  | { action: "skip"; reason: GoogleDriveTransferSkipReason };

export type GoogleDriveInventoryEntry = {
  externalObjectId: string;
  externalVersionId: string | null;
  sourceId: string;
  parentFolderId: string;
  driveId: string | null;
  title: string;
  mimeType: string;
  modifiedTime: string | null;
  createdTime: string | null;
  sourceUri: string;
  transfer: GoogleDriveTransferPlan;
};

export type GoogleDriveInventoryIssue = {
  code: "incomplete_search" | "invalid_page" | "provider_error";
  folderId: string;
  providerCode: string | null;
};

export type GoogleDriveInventoryStopReason =
  | "api_request_limit"
  | "elapsed_time_limit"
  | "incomplete_search"
  | "item_limit"
  | "known_byte_limit"
  | "provider_error";

export type GoogleDriveInventoryTotals = {
  itemCount: number;
  folderCount: number;
  plannedFileCount: number;
  skippedItemCount: number;
  exportFileCount: number;
  downloadFileCount: number;
  unknownSizeFileCount: number;
  apiRequestCount: number;
  knownBytes: string;
};

type GoogleDriveInventoryFrame = {
  folderId: string;
  driveId: string | null;
  pageToken: string | null;
  loaded: boolean;
  bufferedItems: GoogleDriveInventoryProviderItem[];
  nextPageToken: string | null;
};

export type GoogleDriveInventoryCheckpoint = {
  version: 2;
  googlePermissionId: string;
  externalTenantId: string;
  sourceId: string;
  sourceDriveId: string | null;
  scope: ScopedKnowledgeScope;
  pendingFolders: GoogleDriveInventoryFrame[];
  seenFolderIds: string[];
  totals: GoogleDriveInventoryTotals;
};

export type GoogleDriveInventoryResult = {
  status: "complete" | "paused";
  stopReason: GoogleDriveInventoryStopReason | null;
  source: GoogleDriveKnowledgeSourceIdentity;
  entries: GoogleDriveInventoryEntry[];
  issues: GoogleDriveInventoryIssue[];
  totals: GoogleDriveInventoryTotals;
  run: GoogleDriveInventoryTotals & { elapsedMs: number };
  checkpoint: GoogleDriveInventoryCheckpoint | null;
};

export type GoogleDriveListChildren = (input: {
  folderId: string;
  driveId: string | null;
  pageToken: string | null;
  pageSize: number;
}) => Promise<GoogleDriveInventoryPage>;

export class GoogleDriveInventoryProviderError extends Error {
  constructor(readonly providerCode: string) {
    super(providerCode);
    this.name = "GoogleDriveInventoryProviderError";
  }
}

export function googleDriveKnowledgeScope(
  targetScope: GoogleDriveTargetScope,
  workspaceId: string,
  initiatingSubjectId: string,
): ScopedKnowledgeScope {
  const boundedWorkspaceId = boundedText(workspaceId, "workspaceId", 256);
  const boundedSubjectId = boundedText(initiatingSubjectId, "initiatingSubjectId", 1024);
  if (targetScope === "organization") {
    return { kind: "organization", workspaceId: null, subjectId: null };
  }
  if (targetScope === "workspace") {
    return { kind: "workspace", workspaceId: boundedWorkspaceId, subjectId: null };
  }
  // Google Drive connections are workspace-bound today. Preserve that boundary
  // for personal knowledge rather than silently widening it across workspaces.
  return {
    kind: "personal",
    workspaceId: boundedWorkspaceId,
    subjectId: boundedSubjectId,
  };
}

export function googleDriveKnowledgeSourceIdentity(input: {
  googlePermissionId: string;
  source: Pick<GoogleDriveSelectedSource, "id" | "driveId" | "targetScope">;
  workspaceId: string;
  initiatingSubjectId: string;
}): GoogleDriveKnowledgeSourceIdentity {
  const sourceId = driveId(input.source.id, "source.id");
  const externalTenantId = normalizedGooglePermissionId(input.googlePermissionId);
  const sourceDriveId = nullableDriveId(input.source.driveId, "source.driveId");
  return {
    providerKey: GOOGLE_DRIVE_PROVIDER_KEY,
    externalTenantId,
    externalSourceId: sourceId,
    sourceKind:
      sourceId === "root"
        ? "google-drive-my-drive"
        : sourceDriveId === sourceId
          ? "google-drive-shared-drive"
          : "google-drive-folder",
    sourceUri: googleDriveSourceUri(sourceId),
    scope: googleDriveKnowledgeScope(
      input.source.targetScope,
      input.workspaceId,
      input.initiatingSubjectId,
    ),
  };
}

export function planGoogleDriveTransfer(
  item: GoogleDriveInventoryProviderItem,
  maxFileBytes: number,
): GoogleDriveTransferPlan {
  const normalized = validatedProviderItem(item);
  const byteLimit = safePositiveInteger(maxFileBytes, "maxFileBytes");
  if (normalized.trashed) {
    return { action: "skip", reason: "trashed" };
  }
  if (normalized.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
    return { action: "traverse" };
  }
  if (normalized.mimeType === GOOGLE_DRIVE_SHORTCUT_MIME_TYPE) {
    return { action: "skip", reason: "shortcut_unsupported" };
  }
  const nativeExport = GOOGLE_DRIVE_NATIVE_EXPORTS.get(normalized.mimeType);
  if (nativeExport) {
    return {
      action: "export",
      contentType: nativeExport.contentType,
      filename: exportedFilename(normalized.name, nativeExport.extension),
      declaredBytes: null,
    };
  }
  if (normalized.mimeType.startsWith(GOOGLE_DRIVE_NATIVE_MIME_PREFIX)) {
    return { action: "skip", reason: "unsupported_native_type" };
  }
  const declaredBytes = fileSize(normalized.size);
  if (declaredBytes !== null && declaredBytes > BigInt(byteLimit)) {
    return { action: "skip", reason: "file_too_large" };
  }
  const contentType = dependencyFreeOrdinaryContentType(normalized.name, normalized.mimeType);
  if (!contentType) {
    return { action: "skip", reason: "unsupported_file_type" };
  }
  return {
    action: "download",
    contentType,
    filename: safeFilename(normalized.name),
    declaredBytes: declaredBytes?.toString() ?? null,
  };
}

export async function inventoryGoogleDriveSource(input: {
  googlePermissionId: string;
  source: GoogleDriveSelectedSource;
  workspaceId: string;
  initiatingSubjectId: string;
  limits: GoogleDriveInventoryLimits;
  listChildren: GoogleDriveListChildren;
  checkpoint?: GoogleDriveInventoryCheckpoint | null;
  now?: (() => number) | undefined;
}): Promise<GoogleDriveInventoryResult> {
  const limits = validatedLimits(input.limits);
  const googlePermissionId = normalizedGooglePermissionId(input.googlePermissionId);
  const source = googleDriveKnowledgeSourceIdentity({
    googlePermissionId,
    source: input.source,
    workspaceId: input.workspaceId,
    initiatingSubjectId: input.initiatingSubjectId,
  });
  const checkpointIdentity: GoogleDriveInventoryCheckpointIdentity = {
    googlePermissionId,
    externalTenantId: source.externalTenantId,
    sourceId: source.externalSourceId,
    sourceDriveId: nullableDriveId(input.source.driveId, "source.driveId"),
    scope: source.scope,
  };
  const now = input.now ?? Date.now;
  const startedAt = now();
  const checkpoint = input.checkpoint
    ? validatedCheckpoint(input.checkpoint, checkpointIdentity, limits)
    : initialCheckpoint(checkpointIdentity);
  const initialTotals = cloneTotals(checkpoint.totals);
  const entries: GoogleDriveInventoryEntry[] = [];
  const issues: GoogleDriveInventoryIssue[] = [];
  let stopReason: GoogleDriveInventoryStopReason | null = null;

  while (checkpoint.pendingFolders.length > 0) {
    if (now() - startedAt >= limits.maxElapsedMs) {
      stopReason = "elapsed_time_limit";
      break;
    }
    const frame = checkpoint.pendingFolders[0]!;
    if (frame.loaded && frame.bufferedItems.length === 0) {
      if (frame.nextPageToken) {
        frame.pageToken = frame.nextPageToken;
        frame.nextPageToken = null;
        frame.loaded = false;
      } else {
        checkpoint.pendingFolders.shift();
      }
      continue;
    }
    if (checkpoint.totals.itemCount >= limits.maxItems) {
      stopReason = "item_limit";
      break;
    }

    if (!frame.loaded) {
      if (checkpoint.totals.apiRequestCount >= limits.maxApiRequests) {
        stopReason = "api_request_limit";
        break;
      }
      const remainingItems = limits.maxItems - checkpoint.totals.itemCount;
      const requestedPageSize = Math.min(limits.pageSize, remainingItems);
      let page: GoogleDriveInventoryPage;
      try {
        page = await input.listChildren({
          folderId: frame.folderId,
          driveId: frame.driveId,
          pageToken: frame.pageToken,
          pageSize: requestedPageSize,
        });
      } catch (error) {
        checkpoint.totals.apiRequestCount += 1;
        issues.push({
          code: "provider_error",
          folderId: frame.folderId,
          providerCode: providerErrorCode(error),
        });
        stopReason = "provider_error";
        break;
      }
      checkpoint.totals.apiRequestCount += 1;
      if (!validPage(page, requestedPageSize)) {
        issues.push({ code: "invalid_page", folderId: frame.folderId, providerCode: null });
        stopReason = "provider_error";
        break;
      }
      if (page.incompleteSearch) {
        issues.push({ code: "incomplete_search", folderId: frame.folderId, providerCode: null });
        stopReason = "incomplete_search";
        break;
      }
      frame.loaded = true;
      frame.bufferedItems = page.items.map(validatedProviderItem);
      frame.nextPageToken = page.nextPageToken;
      if (now() - startedAt >= limits.maxElapsedMs) {
        stopReason = "elapsed_time_limit";
        break;
      }
    }

    if (frame.bufferedItems.length === 0) {
      if (frame.nextPageToken) {
        frame.pageToken = frame.nextPageToken;
        frame.nextPageToken = null;
        frame.loaded = false;
      } else {
        checkpoint.pendingFolders.shift();
      }
      continue;
    }

    const item = validatedProviderItem(frame.bufferedItems[0]!);
    let transfer = planGoogleDriveTransfer(item, limits.maxFileBytes);
    if (transfer.action === "download" && transfer.declaredBytes !== null) {
      const nextKnownBytes = BigInt(checkpoint.totals.knownBytes) + BigInt(transfer.declaredBytes);
      if (nextKnownBytes > BigInt(limits.maxKnownBytes)) {
        stopReason = "known_byte_limit";
        break;
      }
    }

    frame.bufferedItems.shift();
    checkpoint.totals.itemCount += 1;
    const effectiveDriveId = item.driveId ?? frame.driveId;
    if (transfer.action === "traverse") {
      if (checkpoint.seenFolderIds.includes(item.id)) {
        transfer = { action: "skip", reason: "folder_loop" };
      } else if (checkpoint.seenFolderIds.length >= limits.maxFolders) {
        transfer = { action: "skip", reason: "folder_limit" };
      } else {
        checkpoint.seenFolderIds.push(item.id);
        checkpoint.totals.folderCount += 1;
        checkpoint.pendingFolders.push({
          folderId: item.id,
          driveId: effectiveDriveId,
          pageToken: null,
          loaded: false,
          bufferedItems: [],
          nextPageToken: null,
        });
      }
    }

    if (transfer.action === "skip") {
      checkpoint.totals.skippedItemCount += 1;
    } else if (transfer.action === "download") {
      checkpoint.totals.plannedFileCount += 1;
      checkpoint.totals.downloadFileCount += 1;
      if (transfer.declaredBytes === null) {
        checkpoint.totals.unknownSizeFileCount += 1;
      } else {
        checkpoint.totals.knownBytes = (
          BigInt(checkpoint.totals.knownBytes) + BigInt(transfer.declaredBytes)
        ).toString();
      }
    } else if (transfer.action === "export") {
      checkpoint.totals.plannedFileCount += 1;
      checkpoint.totals.exportFileCount += 1;
      checkpoint.totals.unknownSizeFileCount += 1;
    }

    entries.push({
      externalObjectId: item.id,
      externalVersionId: item.version ?? item.md5Checksum ?? item.modifiedTime,
      sourceId: source.externalSourceId,
      parentFolderId: frame.folderId,
      driveId: effectiveDriveId,
      title: item.name,
      mimeType: item.mimeType,
      modifiedTime: item.modifiedTime,
      createdTime: item.createdTime,
      sourceUri: item.webViewLink ?? googleDriveFileUri(item.id),
      transfer,
    });
  }

  const elapsedMs = Math.max(0, now() - startedAt);
  const complete = checkpoint.pendingFolders.length === 0;
  const outputCheckpoint = complete ? null : cloneCheckpoint(checkpoint);
  if (outputCheckpoint) assertCheckpointBytes(outputCheckpoint);
  return {
    status: complete ? "complete" : "paused",
    stopReason: complete ? null : stopReason,
    source,
    entries,
    issues,
    totals: cloneTotals(checkpoint.totals),
    run: {
      ...subtractTotals(checkpoint.totals, initialTotals),
      elapsedMs,
    },
    checkpoint: outputCheckpoint,
  };
}

type GoogleDriveInventoryCheckpointIdentity = Pick<
  GoogleDriveInventoryCheckpoint,
  "googlePermissionId" | "externalTenantId" | "sourceId" | "sourceDriveId" | "scope"
>;

function initialCheckpoint(
  identity: GoogleDriveInventoryCheckpointIdentity,
): GoogleDriveInventoryCheckpoint {
  return {
    version: 2,
    googlePermissionId: identity.googlePermissionId,
    externalTenantId: identity.externalTenantId,
    sourceId: identity.sourceId,
    sourceDriveId: identity.sourceDriveId,
    scope: cloneScope(identity.scope),
    pendingFolders: [
      {
        folderId: identity.sourceId,
        driveId: identity.sourceDriveId,
        pageToken: null,
        loaded: false,
        bufferedItems: [],
        nextPageToken: null,
      },
    ],
    seenFolderIds: [identity.sourceId],
    totals: emptyTotals(),
  };
}

function validatedCheckpoint(
  value: GoogleDriveInventoryCheckpoint,
  identity: GoogleDriveInventoryCheckpointIdentity,
  limits: GoogleDriveInventoryLimits,
): GoogleDriveInventoryCheckpoint {
  if (!value || typeof value !== "object" || value.version !== 2) {
    throw new Error("unsupported Google Drive inventory checkpoint");
  }
  if (
    value.googlePermissionId !== identity.googlePermissionId ||
    value.externalTenantId !== identity.externalTenantId ||
    value.sourceId !== identity.sourceId ||
    value.sourceDriveId !== identity.sourceDriveId ||
    !sameScope(value.scope, identity.scope)
  ) {
    throw new Error("Google Drive inventory checkpoint does not match the selected source");
  }
  const checkpoint = cloneCheckpoint(value);
  if (checkpoint.pendingFolders.length === 0) {
    throw new Error("Google Drive inventory checkpoint is already complete");
  }
  if (
    checkpoint.pendingFolders.length > GOOGLE_DRIVE_MAX_CHECKPOINT_FOLDERS ||
    checkpoint.seenFolderIds.length > GOOGLE_DRIVE_MAX_CHECKPOINT_FOLDERS ||
    checkpoint.seenFolderIds.length > limits.maxFolders
  ) {
    throw new Error("Google Drive inventory checkpoint exceeds the folder limit");
  }
  if (!checkpoint.seenFolderIds.includes(identity.sourceId)) {
    throw new Error("Google Drive inventory checkpoint lost its source boundary");
  }
  if (new Set(checkpoint.seenFolderIds).size !== checkpoint.seenFolderIds.length) {
    throw new Error("Google Drive inventory checkpoint contains duplicate folder identity");
  }
  for (const folderId of checkpoint.seenFolderIds) driveId(folderId, "checkpoint.folderId");
  const pendingFolderIds = new Set<string>();
  for (const frame of checkpoint.pendingFolders) {
    driveId(frame.folderId, "checkpoint.pending.folderId");
    if (
      !checkpoint.seenFolderIds.includes(frame.folderId) ||
      pendingFolderIds.has(frame.folderId)
    ) {
      throw new Error("Google Drive inventory checkpoint contains an invalid pending folder");
    }
    pendingFolderIds.add(frame.folderId);
    nullableDriveId(frame.driveId, "checkpoint.pending.driveId");
    pageToken(frame.pageToken, "checkpoint.pending.pageToken");
    pageToken(frame.nextPageToken, "checkpoint.pending.nextPageToken");
    if (
      typeof frame.loaded !== "boolean" ||
      frame.bufferedItems.length > GOOGLE_DRIVE_MAX_PAGE_ITEMS
    ) {
      throw new Error("Google Drive inventory checkpoint contains an invalid page frame");
    }
    if (!frame.loaded && (frame.bufferedItems.length > 0 || frame.nextPageToken !== null)) {
      throw new Error("Google Drive inventory checkpoint contains an uncommitted page frame");
    }
    frame.bufferedItems = frame.bufferedItems.map(validatedProviderItem);
  }
  validatedTotals(checkpoint.totals);
  if (
    checkpoint.totals.folderCount !== checkpoint.seenFolderIds.length ||
    checkpoint.totals.plannedFileCount !==
      checkpoint.totals.exportFileCount + checkpoint.totals.downloadFileCount ||
    checkpoint.totals.unknownSizeFileCount > checkpoint.totals.plannedFileCount ||
    checkpoint.totals.itemCount !==
      checkpoint.totals.skippedItemCount +
        checkpoint.totals.plannedFileCount +
        checkpoint.totals.folderCount -
        1
  ) {
    throw new Error("Google Drive inventory checkpoint totals are inconsistent");
  }
  if (
    checkpoint.totals.itemCount > limits.maxItems ||
    checkpoint.totals.apiRequestCount > limits.maxApiRequests ||
    BigInt(checkpoint.totals.knownBytes) > BigInt(limits.maxKnownBytes)
  ) {
    throw new Error("Google Drive inventory checkpoint exceeds the supplied limits");
  }
  assertCheckpointBytes(checkpoint);
  return checkpoint;
}

function validatedLimits(value: GoogleDriveInventoryLimits): GoogleDriveInventoryLimits {
  const limits = {
    maxItems: safePositiveInteger(value.maxItems, "limits.maxItems"),
    maxKnownBytes: safePositiveInteger(value.maxKnownBytes, "limits.maxKnownBytes"),
    maxApiRequests: safePositiveInteger(value.maxApiRequests, "limits.maxApiRequests"),
    maxElapsedMs: safePositiveInteger(value.maxElapsedMs, "limits.maxElapsedMs"),
    maxFileBytes: safePositiveInteger(value.maxFileBytes, "limits.maxFileBytes"),
    maxFolders: safePositiveInteger(value.maxFolders, "limits.maxFolders"),
    pageSize: safePositiveInteger(value.pageSize, "limits.pageSize"),
  };
  if (limits.pageSize > GOOGLE_DRIVE_MAX_PAGE_ITEMS) {
    throw new Error(`limits.pageSize must be <= ${GOOGLE_DRIVE_MAX_PAGE_ITEMS}`);
  }
  if (limits.maxFolders > GOOGLE_DRIVE_MAX_CHECKPOINT_FOLDERS) {
    throw new Error(`limits.maxFolders must be <= ${GOOGLE_DRIVE_MAX_CHECKPOINT_FOLDERS}`);
  }
  return limits;
}

function validPage(value: GoogleDriveInventoryPage, expectedMaxItems: number): boolean {
  if (
    !value ||
    !Array.isArray(value.items) ||
    value.items.length > expectedMaxItems ||
    value.items.length > GOOGLE_DRIVE_MAX_PAGE_ITEMS
  ) {
    return false;
  }
  try {
    pageToken(value.nextPageToken, "page.nextPageToken");
    value.items.forEach(validatedProviderItem);
    return typeof value.incompleteSearch === "boolean";
  } catch {
    return false;
  }
}

function validatedProviderItem(
  item: GoogleDriveInventoryProviderItem,
): GoogleDriveInventoryProviderItem {
  const id = driveId(item.id, "item.id");
  const name = boundedText(item.name, "item.name", GOOGLE_DRIVE_MAX_NAME_CHARS);
  const mimeType = boundedText(item.mimeType, "item.mimeType", GOOGLE_DRIVE_MAX_MIME_CHARS);
  const parents = Array.isArray(item.parents)
    ? item.parents.map((parent) => driveId(parent, "item.parent"))
    : [];
  if (parents.length > 100) throw new Error("item.parents exceeds the supported bound");
  return {
    id,
    name,
    mimeType,
    driveId: nullableDriveId(item.driveId, "item.driveId"),
    parents,
    modifiedTime: nullableBoundedText(item.modifiedTime, "item.modifiedTime", 128),
    createdTime: nullableBoundedText(item.createdTime, "item.createdTime", 128),
    version: nullableBoundedText(item.version, "item.version", 256),
    md5Checksum: nullableBoundedText(item.md5Checksum, "item.md5Checksum", 128),
    size: fileSize(item.size)?.toString() ?? null,
    webViewLink: nullableHttpsUrl(item.webViewLink, "item.webViewLink"),
    trashed: item.trashed === true,
  };
}

function dependencyFreeOrdinaryContentType(name: string, mimeType: string): string | null {
  const normalizedMime = mimeType.trim().toLowerCase();
  if (normalizedMime.startsWith("text/")) return normalizedMime;
  if (DEPENDENCY_FREE_ORDINARY_CONTENT_TYPES.has(normalizedMime)) return normalizedMime;
  if (!GENERIC_BINARY_CONTENT_TYPES.has(normalizedMime)) return null;
  const lowerName = name.toLowerCase();
  for (const [extension, contentType] of DEPENDENCY_FREE_EXTENSION_CONTENT_TYPES) {
    if (lowerName.endsWith(extension)) return contentType;
  }
  return null;
}

function exportedFilename(name: string, extension: string): string {
  const filename = safeFilename(name);
  return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
}

function safeFilename(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
  return cleaned || "untitled";
}

function googleDriveSourceUri(id: string): string {
  return id === "root"
    ? "https://drive.google.com/drive/my-drive"
    : `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

function googleDriveFileUri(id: string): string {
  return `https://drive.google.com/open?id=${encodeURIComponent(id)}`;
}

function fileSize(value: string | null): bigint | null {
  if (value === null) return null;
  if (!/^\d{1,40}$/u.test(value)) throw new Error("item.size is invalid");
  return BigInt(value);
}

function providerErrorCode(error: unknown): string | null {
  if (!(error instanceof GoogleDriveInventoryProviderError)) return null;
  const normalized = error.providerCode.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(normalized) ? normalized : null;
}

function driveId(value: string, label: string): string {
  const candidate = boundedText(value, label, GOOGLE_DRIVE_MAX_ID_CHARS);
  if (candidate === "root" || /^[A-Za-z0-9_-]+$/u.test(candidate)) return candidate;
  throw new Error(`${label} is invalid`);
}

function normalizedGooglePermissionId(value: string): string {
  return boundedText(value, "googlePermissionId", GOOGLE_DRIVE_MAX_ID_CHARS);
}

function nullableDriveId(value: string | null, label: string): string | null {
  return value === null ? null : driveId(value, label);
}

function pageToken(value: string | null, label: string): string | null {
  if (value === null) return null;
  return boundedText(value, label, GOOGLE_DRIVE_MAX_PAGE_TOKEN_CHARS);
}

function boundedText(value: string, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

function nullableBoundedText(value: string | null, label: string, maxChars: number): string | null {
  return value === null ? null : boundedText(value, label, maxChars);
}

function nullableHttpsUrl(value: string | null, label: string): string | null {
  if (value === null) return null;
  const bounded = boundedText(value, label, 4096);
  const parsed = new URL(bounded);
  if (parsed.protocol !== "https:") throw new Error(`${label} must use https`);
  return parsed.toString();
}

function safePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function validatedTotals(totals: GoogleDriveInventoryTotals): void {
  for (const [key, value] of Object.entries(totals)) {
    if (key === "knownBytes") continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`checkpoint.totals.${key} is invalid`);
    }
  }
  if (!/^\d+$/u.test(totals.knownBytes)) {
    throw new Error("checkpoint.totals.knownBytes is invalid");
  }
}

function emptyTotals(): GoogleDriveInventoryTotals {
  return {
    itemCount: 0,
    folderCount: 1,
    plannedFileCount: 0,
    skippedItemCount: 0,
    exportFileCount: 0,
    downloadFileCount: 0,
    unknownSizeFileCount: 0,
    apiRequestCount: 0,
    knownBytes: "0",
  };
}

function cloneTotals(value: GoogleDriveInventoryTotals): GoogleDriveInventoryTotals {
  return { ...value };
}

function subtractTotals(
  value: GoogleDriveInventoryTotals,
  initial: GoogleDriveInventoryTotals,
): GoogleDriveInventoryTotals {
  return {
    itemCount: value.itemCount - initial.itemCount,
    folderCount: value.folderCount - initial.folderCount,
    plannedFileCount: value.plannedFileCount - initial.plannedFileCount,
    skippedItemCount: value.skippedItemCount - initial.skippedItemCount,
    exportFileCount: value.exportFileCount - initial.exportFileCount,
    downloadFileCount: value.downloadFileCount - initial.downloadFileCount,
    unknownSizeFileCount: value.unknownSizeFileCount - initial.unknownSizeFileCount,
    apiRequestCount: value.apiRequestCount - initial.apiRequestCount,
    knownBytes: (BigInt(value.knownBytes) - BigInt(initial.knownBytes)).toString(),
  };
}

function cloneProviderItem(
  value: GoogleDriveInventoryProviderItem,
): GoogleDriveInventoryProviderItem {
  return { ...value, parents: [...value.parents] };
}

function cloneScope(scope: ScopedKnowledgeScope): ScopedKnowledgeScope {
  return { ...scope };
}

function cloneCheckpoint(value: GoogleDriveInventoryCheckpoint): GoogleDriveInventoryCheckpoint {
  return {
    version: 2,
    googlePermissionId: value.googlePermissionId,
    externalTenantId: value.externalTenantId,
    sourceId: value.sourceId,
    sourceDriveId: value.sourceDriveId,
    scope: cloneScope(value.scope),
    pendingFolders: value.pendingFolders.map((frame) => ({
      ...frame,
      bufferedItems: frame.bufferedItems.map(cloneProviderItem),
    })),
    seenFolderIds: [...value.seenFolderIds],
    totals: cloneTotals(value.totals),
  };
}

function sameScope(
  left: ScopedKnowledgeScope | null | undefined,
  right: ScopedKnowledgeScope,
): boolean {
  return (
    !!left &&
    typeof left === "object" &&
    left.kind === right.kind &&
    left.workspaceId === right.workspaceId &&
    left.subjectId === right.subjectId
  );
}

function assertCheckpointBytes(checkpoint: GoogleDriveInventoryCheckpoint): void {
  if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > GOOGLE_DRIVE_MAX_CHECKPOINT_BYTES) {
    throw new Error("Google Drive inventory checkpoint exceeds the serialized byte limit");
  }
}
