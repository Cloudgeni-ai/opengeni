import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { stopArchivedSessionWork } from "@opengeni/core";
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
  readSessionArchiveTablePages,
  readSessionArchiveTree,
  readSessionArchiveSessionRow,
  readSessionArchiveTranscriptEvents,
  readPendingSessionContentRestore,
  restoreArchivedSessionContent,
  sessionArchiveObjectKeys,
  type Database,
  type SessionArchiveManifest,
  type SessionArchiveObject,
  type SessionArchiveRestoreTable,
  type SessionArchiveScope,
} from "@opengeni/db";
import {
  downloadWorkspaceArchiveSpool,
  readCompressedJsonLines,
  uploadWorkspaceArchiveSpool,
  writeCompressedJsonLines,
  WorkspaceArchiveStorageError,
  type ObjectStorage,
  type WorkspaceArchiveSpool,
} from "@opengeni/storage";
import type { ControlActivityServices } from "./types";

export { sessionArchiveObjectKeys, writeCompressedJsonLines };

type Spool = WorkspaceArchiveSpool;

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
      let count = 0;
      for await (const rows of readSessionArchiveTablePages(db, scope, spec, {
        pageRows: SESSION_ARCHIVE_EXPORT_PAGE_ROWS,
      })) {
        for (const row of rows) {
          await write(`{"table":${JSON.stringify(spec.table)},"row":${row}}`);
        }
        count += rows.length;
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

/** One Archive a person made: the chat, who archived it and when. */
export type ArchivedSessionRequest = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
  archivedAt: string;
};

/** A chat whose stored content should be restored, with its sub-chats archived with it. */
export type SessionArchiveRestoreRequest = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
};

export type SessionArchiveActivityOptions = {
  candidatesPerPass?: number;
  timeBudgetMs?: number;
  now?: () => number;
  upload?: (storage: ObjectStorage, key: string, spool: Spool) => Promise<void>;
  /** Fetch a stored object to a private file, verified against its size and digest. */
  download?: (
    storage: ObjectStorage,
    object: SessionArchiveObject,
  ) => Promise<{ path: string; dispose: () => Promise<void> }>;
};

/**
 * One table's rows from a downloaded bundle, as their exact JSON, checked
 * against the count the bundle's footer records for that table.
 */
export async function* sessionArchiveBundleRows(
  path: string,
  table: SessionArchiveRestoreTable,
): AsyncGenerator<string> {
  const prefix = `{"table":${JSON.stringify(table)},"row":`;
  let count = 0;
  let footer: { rowCounts?: Record<string, number> } | null = null;
  for await (const line of readCompressedJsonLines(path)) {
    if (line.startsWith(prefix) && line.endsWith("}")) {
      count += 1;
      yield line.slice(prefix.length, -1);
    } else if (line.startsWith('{"end":true')) {
      footer = JSON.parse(line) as { rowCounts?: Record<string, number> };
    }
  }
  if (footer?.rowCounts?.[table] !== undefined && footer.rowCounts[table] !== count) {
    throw new Error(`session archive bundle is incomplete: ${table} has ${count} rows`);
  }
  if (!footer) throw new Error("session archive bundle has no footer");
}

/** The bundle's header names its format and the session it belongs to. */
async function verifyBundleHeader(path: string, sessionId: string): Promise<void> {
  for await (const line of readCompressedJsonLines(path)) {
    const header = JSON.parse(line) as {
      format?: unknown;
      version?: unknown;
      session?: { id?: unknown };
    };
    if (
      header.format !== SESSION_ARCHIVE_FORMAT ||
      header.version !== SESSION_ARCHIVE_FORMAT_VERSION ||
      header.session?.id !== sessionId
    ) {
      throw new Error("session archive bundle does not belong to this session");
    }
    return;
  }
  throw new Error("session archive bundle is empty");
}

export type ArchiveIdleSessionsResult = {
  enabled: boolean;
  archived: number;
  skipped: number;
  failed: number;
  abandoned: number;
  restored: number;
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
  const download =
    options.download ??
    (async (storage: ObjectStorage, object: SessionArchiveObject) =>
      await downloadWorkspaceArchiveSpool(storage, object.key, {
        bytes: object.bytes,
        sha256: object.sha256,
      }));

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

  /**
   * Restore one stored chat whose restore was requested: download and verify
   * its bundle, then put the purged rows back and make it live in one
   * transaction. "skipped" when there was nothing to restore (done already).
   */
  async function restoreOne(
    db: Database,
    storage: ObjectStorage,
    scope: SessionArchiveScope,
  ): Promise<"restored" | "skipped"> {
    const pending = await readPendingSessionContentRestore(db, scope);
    if (!pending) return "skipped";
    const spool = await download(storage, pending.bundle);
    try {
      await verifyBundleHeader(spool.path, scope.sessionId);
      const result = await restoreArchivedSessionContent(db, scope, {
        sha256: pending.sha256,
        rows: (table) => sessionArchiveBundleRows(spool.path, table),
      });
      if (result.status === "manifest_changed") {
        throw ApplicationFailure.retryable(
          "the stored archive changed while it was being restored",
          "session_archive_restore_retry",
        );
      }
      return result.status === "restored" ? "restored" : "skipped";
    } finally {
      await spool.dispose();
    }
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
      restored: 0,
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
      // One session's failure must not stop the pass: it is retried next pass,
      // and new archives still proceed.
      try {
        if (unfinished.state === "archiving") {
          if (await abandonSessionArchive(db, unfinished)) result.abandoned += 1;
        } else if (unfinished.state === "restoring") {
          // A restore whose own workflow was lost.
          if (objectStorage && (await restoreOne(db, objectStorage, unfinished)) === "restored") {
            result.restored += 1;
          }
        } else {
          result.purgedRows += await purgeUntilDone(db, unfinished, deadline);
        }
      } catch (error) {
        result.failed += 1;
        observability.warn("session archive recovery failed; it will be retried", {
          workspaceId: unfinished.workspaceId,
          sessionId: unfinished.sessionId,
          errorClass: "SessionArchiveOperationError",
          errorCode: sessionArchiveFailureCode(error),
        });
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
            await stopSettlingArchive(scope);
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
    if (
      result.archived + result.failed + result.abandoned + result.restored + result.objectsDeleted >
      0
    ) {
      observability.info("session archive pass finished", { ...result });
    }
    return result;
  }

  /**
   * An archived chat the listing returned but that could not be stored yet
   * still has work running (its own stop step was lost, or a migration
   * archived it): stop that work, in it and its sub-chats, so a later pass
   * stores it. A sub-chat does this for itself too, because the chat above it
   * may be stored already and never come back to it.
   */
  async function stopSettlingArchive(scope: SessionArchiveScope): Promise<void> {
    const { db } = await services();
    const tree = await readSessionArchiveTree(db, scope);
    const root = tree.find((row) => row.id === scope.sessionId);
    if (!root?.archivedAt || root.contentArchiveState !== null || !root.archiveRequestedBy) return;
    await stopArchivedSessionWorkActivity({
      ...scope,
      subjectId: root.archiveRequestedBy,
      archivedAt: root.archivedAt.toISOString(),
    });
  }

  /**
   * After an Archive's undo window: retire the chat's one-time waits, pause
   * its goals and cancel its running work, so it can be stored. Returns
   * whether the chat still waits to be stored (false once undone or stored).
   */
  async function stopArchivedSessionWorkActivity(
    input: ArchivedSessionRequest,
  ): Promise<{ pending: boolean }> {
    const { db, bus, wakeSessionWorkflow } = await services();
    return await stopArchivedSessionWork(
      {
        db,
        bus,
        workflowClient: {
          // Committed wakes are drained from their durable outbox.
          requestSessionWorkflowWakeDispatch: async () => undefined,
          wakeSessionWorkflow: async (wake) => {
            if (wakeSessionWorkflow) return await wakeSessionWorkflow(wake);
          },
        },
        schedulePromptPostCommit: (task) => {
          void task().catch(() => undefined);
        },
      },
      input,
    );
  }

  /**
   * Store an archived chat and its sub-chats now instead of waiting for the
   * maintenance pass. Fails (to be retried) while something in them still
   * runs; succeeds once every one is stored, or when the Archive was undone.
   */
  async function storeArchivedSession(input: ArchivedSessionRequest): Promise<{ stored: number }> {
    const { db, objectStorage, settings } = await services();
    // The maintenance pass stores it later when this deployment can.
    if (!settings.sessionArchiveEnabled || !objectStorage) return { stored: 0 };
    const idleSeconds = settings.sessionArchiveIdleDays * 24 * 60 * 60;
    const tree = await readSessionArchiveTree(db, input);
    const root = tree.find((row) => row.id === input.sessionId);
    if (!root || root.archivedAt === null) return { stored: 0 };
    let stored = 0;
    let waiting = 0;
    // Sub-chats first: a running sub-chat keeps its parent live.
    const ordered = [...tree].sort(
      (a, b) => Number(a.id === input.sessionId) - Number(b.id === input.sessionId),
    );
    for (const row of ordered) {
      if (row.contentArchiveState === "archived" || row.archivedAt === null) continue;
      const scope = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: row.id,
      };
      const outcome =
        row.contentArchiveState === "archiving"
          ? "skipped"
          : await archiveOne(db, objectStorage, scope, idleSeconds);
      if (outcome === "archived") {
        stored += 1;
        await purgeUntilDone(db, scope, now() + timeBudgetMs);
      } else waiting += 1;
    }
    if (waiting > 0) {
      throw ApplicationFailure.retryable(
        `${waiting} archived chat(s) still have work to finish before they can be stored`,
        "session_archive_pending",
      );
    }
    return { stored };
  }

  /**
   * Restore a chat and the sub-chats archived with it whose restore was
   * requested (see unarchiveSession). Each chat is restored in its own
   * transaction; a failure leaves that chat stored and is retried.
   */
  async function restoreArchivedSessions(
    input: SessionArchiveRestoreRequest,
  ): Promise<{ restored: number }> {
    const { db, objectStorage } = await services();
    if (!objectStorage) {
      throw ApplicationFailure.retryable(
        "object storage is not configured, so stored chats cannot be restored",
        "session_archive_restore_unavailable",
      );
    }
    const tree = await readSessionArchiveTree(db, input);
    let restored = 0;
    let failed = 0;
    for (const row of tree) {
      if (row.contentArchiveState !== "archived" || row.contentRestoreRequestedAt === null)
        continue;
      try {
        const outcome = await restoreOne(db, objectStorage, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: row.id,
        });
        if (outcome === "restored") restored += 1;
      } catch (error) {
        failed += 1;
        const { observability } = await services();
        observability.warn("session archive restore failed; it will be retried", {
          workspaceId: input.workspaceId,
          sessionId: row.id,
          errorClass: "SessionArchiveOperationError",
          errorCode: sessionArchiveFailureCode(error),
        });
      }
    }
    if (failed > 0) {
      throw ApplicationFailure.retryable(
        `${failed} archived chat(s) could not be restored yet`,
        "session_archive_restore_retry",
      );
    }
    return { restored };
  }

  return {
    archiveIdleSessions,
    stopArchivedSessionWork: stopArchivedSessionWorkActivity,
    storeArchivedSession,
    restoreArchivedSessions,
  };
}
