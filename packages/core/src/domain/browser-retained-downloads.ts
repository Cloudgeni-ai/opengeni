import { randomUUID } from "node:crypto";
import type { BrowserDownload, BrowserDownloadListResponse } from "@opengeni/contracts";
import {
  completeFileUpload,
  createFileUpload,
  currentSessionRlsActorContext,
  getBrowserDownloadPrivateOwner,
  getFileUpload,
  listRetainedBrowserDownloads,
  recordRetainedBrowserDownload,
  withSessionRlsActorContext,
  type Database,
} from "@opengeni/db";
import { retryWhileMissing, type ObjectStorage } from "@opengeni/storage";
import type { Settings } from "@opengeni/config";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import { errorMessage } from "@opengeni/contracts/values";

/** How long a retention upload may take before its authority expires. */
const RETENTION_UPLOAD_TTL_SECONDS = 20 * 60;

/** The part of a running browser's controller that retention needs. */
export type RetainedDownloadSource = {
  listDownloads(): Promise<BrowserDownloadListResponse>;
  exportDownload(
    downloadId: string,
    request: {
      operationId: string;
      downloadId: string;
      upload: { url: string; requiredHeaders: Record<string, string>; expiresAt: string };
    },
  ): Promise<{ sizeBytes: number; sha256: string }>;
};

export type RetainBrowserDownloadsResult = {
  retained: string[];
  failed: { downloadId: string | null; error: string }[];
};

/** Workspace-safe stored filename: no path separators or unusual characters. */
export function sanitizeWorkspaceFilename(filename: string): string {
  const trimmed = filename.trim().replace(/[/\\]/g, "_");
  const safe = trimmed
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return safe || "file";
}

/**
 * Runs `fn` able to read and write files private to `owner`. Callers must
 * already have authorized the browser's chat; a shared chat (null) runs as is.
 */
export async function withBrowserDownloadFileOwner<T>(
  owner: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!owner) return await fn();
  const current = currentSessionRlsActorContext();
  return await withSessionRlsActorContext(
    { ...(current ?? { subjectId: owner }), privateFileOwnerSubjectId: owner },
    fn,
  );
}

/**
 * Keep every completed download of a running browser as a ready file before
 * its working directory goes away (suspension removes it), so the download
 * can still be listed and saved into the task's workspace afterwards,
 * wherever the task runs then. A private chat's downloads stay private to its
 * owner, whoever's request stops the browser. Downloads kept earlier are
 * skipped. Each download is best effort: a failure is returned and never
 * blocks the browser's own lifecycle change.
 */
export async function retainCompletedBrowserDownloads(
  deps: { db: Database; settings: Settings; objectStorage: ObjectStorage },
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string | null;
    browserSessionId: string;
    /** The browser's chat, which decides whether kept files are private. */
    sourceSessionId: string;
    source: RetainedDownloadSource;
    /** Network endpoint the browser's controller uploads to. */
    uploadAudience: "public" | "sandbox";
  },
): Promise<RetainBrowserDownloadsResult> {
  let owner: string | null;
  try {
    owner = await getBrowserDownloadPrivateOwner(deps.db, input);
  } catch (error) {
    return {
      retained: [],
      failed: [{ downloadId: null, error: errorMessage(error) }],
    };
  }
  return await withBrowserDownloadFileOwner(owner, () =>
    retainCompletedBrowserDownloadsAs(deps, input, owner),
  );
}

async function retainCompletedBrowserDownloadsAs(
  deps: { db: Database; settings: Settings; objectStorage: ObjectStorage },
  input: Parameters<typeof retainCompletedBrowserDownloads>[1],
  privateOwnerSubjectId: string | null,
): Promise<RetainBrowserDownloadsResult> {
  const { db, objectStorage } = deps;
  const result: RetainBrowserDownloadsResult = { retained: [], failed: [] };
  const fail = (downloadId: string | null, error: unknown) =>
    result.failed.push({
      downloadId,
      error: errorMessage(error),
    });
  const scope = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    browserSessionId: input.browserSessionId,
  };
  let completed: BrowserDownload[];
  let kept: Set<string>;
  try {
    completed = (await input.source.listDownloads()).downloads.filter(
      (download) =>
        download.browserSessionId === input.browserSessionId &&
        download.status === "completed" &&
        download.sha256 !== null,
    );
    if (completed.length === 0) return result;
    kept = new Set(
      (await listRetainedBrowserDownloads(db, scope)).map((entry) => entry.download.id),
    );
  } catch (error) {
    fail(null, error);
    return result;
  }
  for (const download of completed) {
    if (kept.has(download.id)) continue;
    try {
      const sha256 = download.sha256!;
      if (download.receivedBytes > objectStorage.maxSinglePutSizeBytes) {
        throw new Error(
          `download exceeds the storage single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
        );
      }
      await requireLimit(deps, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        action: "file:upload",
        quantity: download.receivedBytes,
      });
      const fileId = randomUUID();
      const safeFilename = sanitizeWorkspaceFilename(download.filename);
      const contentType = "application/octet-stream";
      const objectKey = `workspaces/${input.workspaceId}/files/${fileId}/original/${safeFilename}`;
      const created = await createFileUpload(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        fileId,
        privateOwnerSubjectId,
        filename: download.filename,
        safeFilename,
        contentType,
        sizeBytes: download.receivedBytes,
        sha256,
        bucket: objectStorage.bucket,
        objectKey,
        expiresAt: new Date(Date.now() + RETENTION_UPLOAD_TTL_SECONDS * 1_000),
      });
      const put = await objectStorage.createPutUrl({
        key: objectKey,
        contentType,
        sha256,
        expiresInSeconds: RETENTION_UPLOAD_TTL_SECONDS,
        audience: input.uploadAudience,
      });
      const receipt = await input.source.exportDownload(download.id, {
        operationId: randomUUID(),
        downloadId: download.id,
        upload: {
          url: put.url,
          requiredHeaders: put.requiredHeaders,
          expiresAt: put.expiresAt.toISOString(),
        },
      });
      if (receipt.sizeBytes !== download.receivedBytes || receipt.sha256 !== sha256) {
        throw new Error("the browser exported different download bytes");
      }
      const head = await retryWhileMissing(async () =>
        (await objectStorage.fileExists(created.file))
          ? await objectStorage.headFile(created.file)
          : null,
      );
      if (
        !head ||
        Number(head.ContentLength ?? -1) !== download.receivedBytes ||
        (head.ContentType !== undefined && head.ContentType !== contentType) ||
        head.Metadata?.sha256 !== sha256
      ) {
        throw new Error("the retained download object failed verification");
      }
      let file = created.file;
      try {
        file = await completeFileUpload(db, input.workspaceId, created.uploadId);
      } catch (error) {
        const current = await getFileUpload(db, input.workspaceId, created.uploadId);
        if (current?.status !== "completed" || current.file.status !== "ready") throw error;
        file = current.file;
      }
      await recordWorkspaceUsage(deps, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        eventType: "file.uploaded",
        quantity: file.sizeBytes,
        unit: "byte",
        sourceResourceType: "file",
        sourceResourceId: file.id,
        idempotencyKey: `file.uploaded:${input.workspaceId}:${file.id}`,
      });
      await recordRetainedBrowserDownload(db, {
        ...scope,
        download,
        fileId,
        uploadId: created.uploadId,
      });
      result.retained.push(download.id);
    } catch (error) {
      fail(download.id, error);
    }
  }
  return result;
}
