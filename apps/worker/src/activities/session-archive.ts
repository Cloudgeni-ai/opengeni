import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createZstdCompress } from "node:zlib";
import {
  SESSION_ARCHIVE_EXPORT_TABLES,
  SESSION_ARCHIVE_FORMAT,
  SESSION_ARCHIVE_FORMAT_VERSION,
  SESSION_ARCHIVE_TRANSCRIPT_FORMAT,
  abandonSessionArchive,
  beginSessionArchive,
  claimSessionArchiveObjectDeletions,
  completeSessionArchive,
  completeSessionArchiveObjectDeletion,
  listSessionArchiveCandidates,
  listUnfinishedSessionArchives,
  purgeArchivedSessionContent,
  readSessionArchiveRows,
  readSessionArchiveSessionRow,
  readSessionArchiveTranscriptEvents,
  type Database,
  type SessionArchiveManifest,
  type SessionArchiveScope,
} from "@opengeni/db";
import {
  uploadWorkspaceArchiveSpool,
  WorkspaceArchiveStorageError,
  type ObjectStorage,
} from "@opengeni/storage";
import type { ControlActivityServices } from "./types";

/**
 * Content-free public classification of a failed session archive. Telemetry
 * only exports reviewed error classes and codes, so a raw error name or
 * storage code would be reduced to a generic "OperationError".
 */
export function sessionArchiveFailureCode(error: unknown): string {
  if (error instanceof WorkspaceArchiveStorageError) {
    switch (error.code) {
      case "archive_object_missing":
        return "session_archive_object_missing";
      case "archive_hash_mismatch":
        return "session_archive_hash_mismatch";
      default:
        return "session_archive_storage_failed";
    }
  }
  return "session_archive_failed";
}

export const SESSION_ARCHIVE_CANDIDATES_PER_PASS = 25;
/**
 * Soft budget for one archive pass. It shares a workflow (and the Schedule's
 * skip-overlap cadence) with content compaction and delta folding, so a long
 * archive pass would starve them while a backlog drains. Matching the storage
 * pass budget gives both an equal share; unfinished work resumes next pass.
 */
export const SESSION_ARCHIVE_TIME_BUDGET_MS = 10 * 60 * 1_000;
export const SESSION_ARCHIVE_STALE_SECONDS = 2 * 60 * 60;
export const SESSION_ARCHIVE_EXPORT_PAGE_ROWS = 200;
export const SESSION_ARCHIVE_PURGE_BATCH_ROWS = 2_000;

type Spool = {
  path: string;
  byteSize: number;
  sha256: string;
  open: () => AsyncIterable<Uint8Array>;
  dispose: () => Promise<void>;
};

/** Stream JSON lines through zstd into a private file, metering the compressed bytes. */
export async function writeCompressedJsonLines(
  path: string,
  produce: (write: (line: string) => Promise<void>) => Promise<void>,
): Promise<Spool> {
  const zstd = createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 9 } });
  const hash = createHash("sha256");
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      byteSize += chunk.length;
      callback(null, chunk);
    },
  });
  const piping = pipeline(zstd, meter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  const write = async (line: string) => {
    if (!zstd.write(`${line}\n`)) await once(zstd, "drain");
  };
  try {
    await produce(write);
    zstd.end();
    await piping;
  } catch (error) {
    zstd.destroy(error instanceof Error ? error : new Error(String(error)));
    await piping.catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  }
  return {
    path,
    byteSize,
    sha256: hash.digest("hex"),
    open: () => createReadStream(path),
    dispose: async () => rm(path, { force: true }),
  };
}

export function sessionArchiveObjectKeys(scope: SessionArchiveScope, archiveId: string) {
  const prefix = `session-archives/${scope.workspaceId}/${scope.sessionId}/${archiveId}`;
  return {
    bundle: `${prefix}/bundle.jsonl.zst`,
    transcript: `${prefix}/transcript.jsonl.zst`,
  };
}

/** Write the full-fidelity bundle: header, every exported row as exact JSON, footer. */
async function writeBundle(db: Database, scope: SessionArchiveScope, path: string) {
  const rowCounts: Record<string, number> = {};
  const sessionRow = await readSessionArchiveSessionRow(db, scope);
  const spool = await writeCompressedJsonLines(path, async (write) => {
    await write(
      `{"format":${JSON.stringify(SESSION_ARCHIVE_FORMAT)},"version":${SESSION_ARCHIVE_FORMAT_VERSION},` +
        `"createdAt":${JSON.stringify(new Date().toISOString())},` +
        `"tables":${JSON.stringify(SESSION_ARCHIVE_EXPORT_TABLES.map((spec) => spec.table))},` +
        `"session":${sessionRow}}`,
    );
    for (const spec of SESSION_ARCHIVE_EXPORT_TABLES) {
      let after: string[] | null = null;
      let count = 0;
      for (;;) {
        const page = await readSessionArchiveRows(db, scope, spec, {
          after,
          limit: SESSION_ARCHIVE_EXPORT_PAGE_ROWS,
        });
        for (const row of page.rows) {
          await write(`{"table":${JSON.stringify(spec.table)},"row":${row}}`);
        }
        count += page.rows.length;
        if (page.rows.length < SESSION_ARCHIVE_EXPORT_PAGE_ROWS) break;
        after = page.last;
      }
      rowCounts[spec.table] = count;
    }
    await write(`{"end":true,"rowCounts":${JSON.stringify(rowCounts)}}`);
  });
  return { spool, rowCounts };
}

/** Write the readable transcript: public SessionEvent objects, one per line. */
async function writeTranscript(db: Database, scope: SessionArchiveScope, path: string) {
  let events = 0;
  const spool = await writeCompressedJsonLines(path, async (write) => {
    await write(
      JSON.stringify({
        format: SESSION_ARCHIVE_TRANSCRIPT_FORMAT,
        version: SESSION_ARCHIVE_FORMAT_VERSION,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
      }),
    );
    let afterSequence = 0;
    for (;;) {
      const page = await readSessionArchiveTranscriptEvents(db, scope, {
        afterSequence,
        limit: 500,
      });
      for (const event of page) await write(JSON.stringify({ event }));
      events += page.length;
      if (page.length < 500) break;
      afterSequence = page.at(-1)!.sequence;
    }
    await write(JSON.stringify({ end: true, events }));
  });
  return { spool, events };
}

export type ArchiveSessionOutcome = "archived" | "skipped" | "failed";

export type SessionArchiveActivityOptions = {
  candidatesPerPass?: number;
  timeBudgetMs?: number;
  now?: () => number;
  upload?: (storage: ObjectStorage, key: string, spool: Spool) => Promise<void>;
};

export type ArchiveIdleSessionsResult = {
  enabled: boolean;
  archived: number;
  skipped: number;
  failed: number;
  abandoned: number;
  purgedRows: number;
  objectsDeleted: number;
};

/**
 * The idle-session archiver. Off unless the deployment enables it; recovery of
 * unfinished archives and deletion of removed sessions' objects always run so
 * that disabling the feature never strands work.
 */
export function createSessionArchiveActivities(
  services: () => Promise<ControlActivityServices>,
  options: SessionArchiveActivityOptions = {},
) {
  const candidatesPerPass = options.candidatesPerPass ?? SESSION_ARCHIVE_CANDIDATES_PER_PASS;
  const timeBudgetMs = options.timeBudgetMs ?? SESSION_ARCHIVE_TIME_BUDGET_MS;
  const now = options.now ?? Date.now;
  const upload = options.upload ?? uploadWorkspaceArchiveSpool;

  async function archiveOne(
    db: Database,
    storage: ObjectStorage,
    scope: SessionArchiveScope,
    idleSeconds: number,
  ): Promise<ArchiveSessionOutcome> {
    const keys = sessionArchiveObjectKeys(scope, randomUUID());
    const begun = await beginSessionArchive(db, scope, {
      idleSeconds,
      objectKeys: [keys.bundle, keys.transcript],
    });
    if (!begun) return "skipped";
    const directory = await mkdtemp(join(tmpdir(), "opengeni-session-archive-"));
    try {
      const bundle = await writeBundle(db, scope, join(directory, "bundle.jsonl.zst"));
      const transcript = await writeTranscript(db, scope, join(directory, "transcript.jsonl.zst"));
      await upload(storage, keys.bundle, bundle.spool);
      await upload(storage, keys.transcript, transcript.spool);
      const manifest: SessionArchiveManifest = {
        format: SESSION_ARCHIVE_FORMAT,
        version: SESSION_ARCHIVE_FORMAT_VERSION,
        objectKeys: [keys.bundle, keys.transcript],
        bundle: { key: keys.bundle, bytes: bundle.spool.byteSize, sha256: bundle.spool.sha256 },
        transcript: {
          key: keys.transcript,
          bytes: transcript.spool.byteSize,
          sha256: transcript.spool.sha256,
          events: transcript.events,
        },
        sha256: bundle.spool.sha256,
        rowCounts: bundle.rowCounts,
        createdAt: new Date(now()).toISOString(),
      };
      if (!(await completeSessionArchive(db, scope, manifest))) {
        throw new Error("session archive state changed before completion");
      }
      return "archived";
    } catch (error) {
      await abandonSessionArchive(db, scope).catch(() => undefined);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function purgeUntilDone(
    db: Database,
    scope: SessionArchiveScope,
    deadline: number,
  ): Promise<number> {
    let purged = 0;
    while (now() < deadline) {
      const step = await purgeArchivedSessionContent(db, scope, {
        batchSize: SESSION_ARCHIVE_PURGE_BATCH_ROWS,
      });
      purged += step.deleted;
      if (step.complete) break;
    }
    return purged;
  }

  async function archiveIdleSessions(): Promise<ArchiveIdleSessionsResult> {
    const { db, objectStorage, observability, settings } = await services();
    const deadline = now() + timeBudgetMs;
    const result: ArchiveIdleSessionsResult = {
      enabled: settings.sessionArchiveEnabled,
      archived: 0,
      skipped: 0,
      failed: 0,
      abandoned: 0,
      purgedRows: 0,
      objectsDeleted: 0,
    };
    if (objectStorage) {
      for (const deletion of await claimSessionArchiveObjectDeletions(db, {
        claimTimeoutSeconds: 600,
        limit: 200,
      })) {
        try {
          await objectStorage.deleteObject(deletion.objectKey);
          if (await completeSessionArchiveObjectDeletion(db, deletion.objectKey)) {
            result.objectsDeleted += 1;
          }
        } catch (error) {
          observability.warn("session archive object deletion failed; it will be retried", {
            workspaceId: deletion.workspaceId,
            sessionId: deletion.sessionId,
            errorName: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    }

    for (const unfinished of await listUnfinishedSessionArchives(db, {
      staleSeconds: SESSION_ARCHIVE_STALE_SECONDS,
      limit: 25,
    })) {
      if (now() >= deadline) break;
      if (unfinished.state === "archiving") {
        if (await abandonSessionArchive(db, unfinished)) result.abandoned += 1;
      } else {
        result.purgedRows += await purgeUntilDone(db, unfinished, deadline);
      }
    }

    if (!settings.sessionArchiveEnabled) return result;
    if (!objectStorage) {
      observability.warn("session archive is enabled but object storage is not configured");
      return result;
    }
    const idleSeconds = settings.sessionArchiveIdleDays * 24 * 60 * 60;
    // Keep taking batches until the budget ends or nothing new qualifies, so a
    // large backlog (for example right after enabling) drains steadily. A
    // session that failed or was skipped is not retried in the same pass.
    const attempted = new Set<string>();
    for (;;) {
      if (now() >= deadline) break;
      const candidates = (
        await listSessionArchiveCandidates(db, {
          idleSeconds,
          limit: candidatesPerPass + attempted.size,
        })
      ).filter((candidate) => !attempted.has(candidate.sessionId));
      if (candidates.length === 0) break;
      for (const scope of candidates.slice(0, candidatesPerPass)) {
        if (now() >= deadline) break;
        attempted.add(scope.sessionId);
        try {
          const outcome = await archiveOne(db, objectStorage, scope, idleSeconds);
          if (outcome === "skipped") {
            result.skipped += 1;
            continue;
          }
          result.archived += 1;
          result.purgedRows += await purgeUntilDone(db, scope, deadline);
        } catch (error) {
          result.failed += 1;
          observability.warn("session archive failed; the session stays live", {
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
            // Content-free classification only: database errors can echo row values.
            errorClass: "SessionArchiveOperationError",
            errorCode: sessionArchiveFailureCode(error),
          });
        }
      }
    }
    if (result.archived + result.failed + result.abandoned + result.objectsDeleted > 0) {
      observability.info("session archive pass finished", { ...result });
    }
    return result;
  }

  return { archiveIdleSessions };
}
