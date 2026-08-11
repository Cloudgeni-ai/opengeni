import { createHash } from "node:crypto";
import type { GoogleDriveSelectedSource } from "@opengeni/contracts/google-drive";
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  planGoogleDriveTransfer,
  type GoogleDriveInventoryEntry,
  type GoogleDriveInventoryProviderItem,
} from "@opengeni/documents/google-drive";

const MAX_TOKEN_CHARS = 4096;
const MAX_BOUNDARY_ID_CHARS = 1024;
const MAX_ANCESTOR_DEPTH = 100;

export type GoogleDriveSyncBudget = {
  examinedItems: number;
  providerRequests: number;
  elapsedMs: number;
};

export type GoogleDriveChangesCursor = {
  version: 1;
  kind: "google_drive_changes";
  connectionId: string;
  googlePermissionId: string;
  sourceId: string;
  driveId: string | null;
  boundaryId: string;
  pageToken: string;
  cursorGeneration: number;
  lastFullReconciliationAt: string;
  nextFullReconciliationAt: string;
};

export type GoogleDriveChangesCheckpoint = {
  version: 2;
  pageToken: string;
  requiresFullReconciliation: boolean;
  seenPageTokenHashes: string[];
  budget: GoogleDriveSyncBudget;
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

export type GoogleDriveChangesStopReason =
  | "item_limit"
  | "api_request_limit"
  | "elapsed_time_limit";

export type GoogleDriveChangesDrainResult = {
  status: "complete" | "paused";
  stopReason: GoogleDriveChangesStopReason | null;
  entries: GoogleDriveInventoryEntry[];
  checkpoint: GoogleDriveChangesCheckpoint | null;
  newStartPageToken: string | null;
  requiresFullReconciliation: boolean;
  providerRequests: number;
  elapsedMs: number;
  budget: GoogleDriveSyncBudget;
  hardLimitReached: boolean;
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
    typeof value.boundaryId !== "string" ||
    value.boundaryId.length < 1 ||
    value.boundaryId.length > MAX_BOUNDARY_ID_CHARS ||
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
  boundaryId: string;
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
    boundaryId: boundedBoundaryId(input.boundaryId),
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

export async function resolveGoogleDriveChangesBoundaryId(input: {
  source: GoogleDriveSelectedSource;
  getFile: (fileId: string) => Promise<GoogleDriveInventoryProviderItem | null>;
}): Promise<string> {
  if (input.source.id !== "root" || input.source.driveId !== null) {
    return boundedBoundaryId(input.source.id);
  }
  const root = await input.getFile("root");
  if (!root || root.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE || root.trashed) {
    throw new GoogleDriveChangesProtocolError("google_drive_root_boundary_invalid");
  }
  return boundedBoundaryId(root.id);
}

export function parseGoogleDriveChangesCheckpoint(
  value: unknown,
  limits: { maxItems: number; maxProviderRequests: number; maxElapsedMs: number },
): GoogleDriveChangesCheckpoint | null {
  try {
    return validatedCheckpoint(value, limits);
  } catch {
    return null;
  }
}

export async function drainGoogleDriveChanges(input: {
  source: GoogleDriveSelectedSource;
  cursor: GoogleDriveChangesCursor;
  checkpoint: GoogleDriveChangesCheckpoint | null;
  maxItems: number;
  maxProviderRequests: number;
  maxElapsedMs: number;
  maxInvocationElapsedMs: number;
  maxFileBytes: number;
  listChanges: (pageToken: string, pageSize: number) => Promise<GoogleDriveChangesPage>;
  getFile: (fileId: string) => Promise<GoogleDriveInventoryProviderItem | null>;
  observedExternalObjectIds: (ids: string[]) => Promise<Set<string>>;
  now?: () => number;
}): Promise<GoogleDriveChangesDrainResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const checkpoint = input.checkpoint ? validatedCheckpoint(input.checkpoint, input) : null;
  let pageToken = boundedToken(checkpoint?.pageToken ?? input.cursor.pageToken);
  let requiresFullReconciliation = checkpoint?.requiresFullReconciliation ?? false;
  const seenPageTokenHashes = new Set(checkpoint?.seenPageTokenHashes ?? []);
  const initialBudget = checkpoint?.budget ?? emptyBudget();
  const budget = { ...initialBudget };
  const entries = new Map<string, GoogleDriveInventoryEntry>();

  while (true) {
    const invocationElapsedMs = Math.max(0, now() - startedAt);
    budget.elapsedMs = initialBudget.elapsedMs + invocationElapsedMs;
    const stopReason = limitReason(budget, input, invocationElapsedMs);
    if (stopReason) {
      return {
        status: "paused",
        stopReason,
        entries: [...entries.values()],
        checkpoint: {
          version: 2,
          pageToken,
          requiresFullReconciliation,
          seenPageTokenHashes: [...seenPageTokenHashes],
          budget: { ...budget },
        },
        newStartPageToken: null,
        requiresFullReconciliation,
        providerRequests: budget.providerRequests,
        elapsedMs: budget.elapsedMs,
        budget: { ...budget },
        hardLimitReached:
          stopReason !== "elapsed_time_limit" || budget.elapsedMs >= input.maxElapsedMs,
      };
    }

    const pageTokenHash = createHash("sha256").update(pageToken).digest("hex");
    if (seenPageTokenHashes.has(pageTokenHash)) {
      throw new GoogleDriveChangesProtocolError("google_drive_changes_page_token_cycle");
    }
    seenPageTokenHashes.add(pageTokenHash);
    budget.providerRequests += 1;
    const pageSize = Math.min(100, input.maxItems - budget.examinedItems);
    let page: GoogleDriveChangesPage;
    try {
      page = await input.listChanges(pageToken, pageSize);
    } catch (error) {
      budget.elapsedMs = initialBudget.elapsedMs + Math.max(0, now() - startedAt);
      if (error instanceof GoogleDriveCursorInvalidError) error.budget = { ...budget };
      throw error;
    }
    if (page.changes.length > pageSize) {
      throw new GoogleDriveChangesProtocolError("google_drive_changes_page_exceeds_item_budget");
    }
    budget.examinedItems += page.changes.length;

    const repairCandidates = new Set<string>();
    for (const change of page.changes) {
      if (change.removed || !change.file || change.file.trashed) {
        repairCandidates.add(change.fileId);
        continue;
      }
      const membership = await isInsideSource({
        file: change.file,
        boundaryId: input.cursor.boundaryId,
        getFile: async (fileId) => {
          const ancestryElapsedMs = Math.max(0, now() - startedAt);
          budget.elapsedMs = initialBudget.elapsedMs + ancestryElapsedMs;
          if (
            budget.providerRequests >= input.maxProviderRequests ||
            budget.elapsedMs >= input.maxElapsedMs ||
            ancestryElapsedMs >= input.maxInvocationElapsedMs
          ) {
            return null;
          }
          budget.providerRequests += 1;
          const parent = await input.getFile(fileId);
          budget.elapsedMs = initialBudget.elapsedMs + Math.max(0, now() - startedAt);
          return parent;
        },
      });
      if (change.file.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
        entries.delete(change.fileId);
        if (membership !== "outside") requiresFullReconciliation = true;
        else repairCandidates.add(change.fileId);
        continue;
      }
      if (membership === "inside") {
        entries.set(change.fileId, toInventoryEntry(change.file, input.source, input.maxFileBytes));
      } else if (membership === "unknown") {
        entries.delete(change.fileId);
        requiresFullReconciliation = true;
      } else {
        repairCandidates.add(change.fileId);
      }
    }
    if (repairCandidates.size > 0) {
      for (const fileId of repairCandidates) {
        if (entries.delete(fileId)) requiresFullReconciliation = true;
      }
      const observed = await input.observedExternalObjectIds([...repairCandidates]);
      if (observed.size > 0) requiresFullReconciliation = true;
    }
    if (page.nextPageToken) {
      pageToken = boundedToken(page.nextPageToken);
      continue;
    }
    if (!page.newStartPageToken) {
      throw new GoogleDriveChangesProtocolError("google_drive_changes_terminal_token_missing");
    }
    budget.elapsedMs = initialBudget.elapsedMs + Math.max(0, now() - startedAt);
    return {
      status: "complete",
      stopReason: null,
      entries: [...entries.values()],
      checkpoint: null,
      newStartPageToken: boundedToken(page.newStartPageToken),
      requiresFullReconciliation,
      providerRequests: budget.providerRequests,
      elapsedMs: budget.elapsedMs,
      budget: { ...budget },
      hardLimitReached: false,
    };
  }
}

async function isInsideSource(input: {
  file: GoogleDriveInventoryProviderItem;
  boundaryId: string;
  getFile: (fileId: string) => Promise<GoogleDriveInventoryProviderItem | null>;
}): Promise<"inside" | "outside" | "unknown"> {
  if (input.file.id === input.boundaryId) return "inside";
  let parents = input.file.parents;
  const seen = new Set<string>([input.file.id]);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (parents.includes(input.boundaryId)) return "inside";
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

function validatedCheckpoint(
  value: unknown,
  limits: { maxItems: number; maxProviderRequests: number; maxElapsedMs: number },
): GoogleDriveChangesCheckpoint {
  if (!value || typeof value !== "object") {
    throw new Error("google_drive_changes_checkpoint_invalid");
  }
  const checkpoint = value as Record<string, unknown>;
  const budget = checkpoint.budget;
  if (
    checkpoint.version !== 2 ||
    typeof checkpoint.requiresFullReconciliation !== "boolean" ||
    !Array.isArray(checkpoint.seenPageTokenHashes) ||
    checkpoint.seenPageTokenHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
    new Set(checkpoint.seenPageTokenHashes).size !== checkpoint.seenPageTokenHashes.length ||
    checkpoint.seenPageTokenHashes.length > limits.maxProviderRequests ||
    !budget ||
    typeof budget !== "object"
  ) {
    throw new Error("google_drive_changes_checkpoint_invalid");
  }
  if (typeof checkpoint.pageToken !== "string") {
    throw new Error("google_drive_changes_checkpoint_invalid");
  }
  boundedToken(checkpoint.pageToken);
  const budgetRow = budget as Record<string, unknown>;
  for (const [key, maximum] of [
    ["examinedItems", limits.maxItems],
    ["providerRequests", limits.maxProviderRequests],
    ["elapsedMs", limits.maxElapsedMs],
  ] as const) {
    const budgetValue = budgetRow[key];
    if (
      !Number.isSafeInteger(budgetValue) ||
      Number(budgetValue) < 0 ||
      Number(budgetValue) > maximum
    ) {
      throw new Error("google_drive_changes_checkpoint_budget_invalid");
    }
  }
  if (checkpoint.seenPageTokenHashes.length > Number(budgetRow.providerRequests)) {
    throw new Error("google_drive_changes_checkpoint_request_history_invalid");
  }
  return value as GoogleDriveChangesCheckpoint;
}

function limitReason(
  budget: GoogleDriveSyncBudget,
  input: {
    maxItems: number;
    maxProviderRequests: number;
    maxElapsedMs: number;
    maxInvocationElapsedMs: number;
  },
  invocationElapsedMs: number,
): GoogleDriveChangesStopReason | null {
  if (budget.examinedItems >= input.maxItems) return "item_limit";
  if (budget.providerRequests >= input.maxProviderRequests) return "api_request_limit";
  if (
    budget.elapsedMs >= input.maxElapsedMs ||
    invocationElapsedMs >= input.maxInvocationElapsedMs
  ) {
    return "elapsed_time_limit";
  }
  return null;
}

function emptyBudget(): GoogleDriveSyncBudget {
  return { examinedItems: 0, providerRequests: 0, elapsedMs: 0 };
}

function boundedToken(value: string): string {
  if (value.length < 1 || value.length > MAX_TOKEN_CHARS) {
    throw new Error("google_drive_changes_token_invalid");
  }
  return value;
}

function boundedBoundaryId(value: string): string {
  if (value.length < 1 || value.length > MAX_BOUNDARY_ID_CHARS) {
    throw new Error("google_drive_changes_boundary_invalid");
  }
  return value;
}

export class GoogleDriveCursorInvalidError extends Error {
  budget: GoogleDriveSyncBudget | null = null;

  constructor() {
    super("google_drive_changes_cursor_invalid");
    this.name = "GoogleDriveCursorInvalidError";
  }
}

export class GoogleDriveChangesProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleDriveChangesProtocolError";
  }
}
