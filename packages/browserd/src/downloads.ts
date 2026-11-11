import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  BrowserDownload,
  BrowserDownloadExportReceipt,
  BrowserDownloadExportRequest,
  type BrowserDownload as BrowserDownloadValue,
  type BrowserDownloadExportReceipt as BrowserDownloadExportReceiptValue,
  type BrowserDownloadExportRequest as BrowserDownloadExportRequestValue,
} from "@opengeni/contracts";
import { Database } from "bun:sqlite";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_EXPORT_ENTRIES = 10_000;
const GUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u;

type DownloadRow = {
  sequence: number;
  id: string;
  guid: string;
  target_id: string | null;
  filename: string;
  status: BrowserDownloadValue["status"];
  received_bytes: number;
  total_bytes: number | null;
  sha256: string | null;
  version: number;
  started_at: string;
  settled_at: string | null;
  failure_code: string | null;
  /** The completed file's name in `files/` as Chromium chose it, or null for
   * a download Chromium saved under its GUID. */
  file_name: string | null;
};

type DownloadExportRow = {
  sequence: number;
  operation_id: string;
  download_id: string;
  request_digest: string;
  state: "prepared" | "completed";
  receipt_json: string | null;
};

export type BrowserDownloadBeginEvent = {
  guid: string;
  targetId: string | null;
  suggestedFilename: string;
};

export type BrowserDownloadProgressEvent = {
  guid: string;
  state: "inProgress" | "completed" | "canceled";
  receivedBytes: number;
  totalBytes: number | null;
  /** Where Chromium saved the completed file, when it reports it. */
  filePath?: string | null;
  /** For a browser that belongs to the person (attached Chrome): where their
   * own Chrome saved the completed file, or null when it could not be found.
   * The store copies that file and never moves, changes or removes it. */
  personFilePath?: string | null;
  /** Resolves once every browser event Chromium emitted before this call has
   * reached the store, for example a round trip on the event connection. */
  eventBarrier?: () => Promise<void>;
};

export type BrowserDownloadProgressResult = {
  cancelReason: "download_quota_exceeded" | null;
};

/** A file's identity on its file system: device and inode. */
type FileIdentity = string;

/** What the store saw when Chromium finished a download: the identity of
 * the file then at its name (null when Chromium cancelled it or no file was
 * there), in the order the store saw it. A conflict means the download's
 * file was replaced or shared, so its bytes cannot be attributed. */
type Observation = {
  sequence: number;
  identity: FileIdentity | null;
  conflict: boolean;
};

/** A completed download whose bytes are kept but not yet settled. Chromium
 * renames a later download over an earlier file of the same name, and file
 * systems differ in which names are the same. So until every download that
 * could have done that before the bytes were kept has settled without a
 * conflict, or shown it was still receiving data, they may be another
 * download's. */
type HeldCompletion = {
  fileName: string | null;
  sizeBytes: number;
  sha256: string;
  /** Those downloads, known once the event barrier has passed. */
  waitFor: Set<string> | null;
};

export type BrowserDownloadStoreOptions = {
  rootDirectory: string;
  browserSessionId: string;
  controllerGeneration: string;
  now?: () => Date;
  createId?: () => string;
  maxFileBytes?: number;
  maxSessionBytes?: number;
  maxExportEntries?: number;
};

export type CompletedBrowserDownloadFile = {
  download: BrowserDownloadValue;
  path: string;
};

/** Placement-private download authority. Chromium saves files into `files/`
 * under the names it gives them, as it would in any downloads folder, and
 * reports each completed file's path; downloads from before that were saved
 * under their GUID. A later download with the same name replaces the earlier
 * file there, so each completed download is also kept as its own hard link in
 * `stored/<guid>`, which is what reads, exports and integrity checks use.
 * SQLite retains only bounded metadata and the file's name in `files/`, never
 * a source URL or a public local path. All event and export work is serialized
 * so a completion, cancellation, and caller read cannot observe half-settled
 * state. */
export class BrowserDownloadStore {
  readonly rootDirectory: string;
  readonly filesDirectory: string;
  private readonly storedDirectory: string;
  private readonly browserSessionId: string;
  private readonly controllerGeneration: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxFileBytes: number;
  private readonly maxSessionBytes: number;
  private readonly maxExportEntries: number;
  private readonly database: Database;
  private readonly held = new Map<string, HeldCompletion>();
  private readonly observations = new Map<string, Observation>();
  /** Rejected downloads whose cancellation Chromium did not confirm: they
   * may still finish and rename a file until Chromium reports them. */
  private readonly unconfirmed = new Set<string>();
  private observationSequence = 0;
  /** For each running download, the last observation made before Chromium
   * announced it. A download announced after another's finish was observed
   * renamed its file after that one's. */
  private readonly announcedAfter = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  private exportTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(options: BrowserDownloadStoreOptions, database: Database) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.filesDirectory = join(this.rootDirectory, "files");
    this.storedDirectory = join(this.rootDirectory, "stored");
    this.browserSessionId = requireUuid(options.browserSessionId, "browserSessionId");
    this.controllerGeneration = requireGeneration(options.controllerGeneration);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxFileBytes = positiveSafeInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    );
    this.maxSessionBytes = positiveSafeInteger(
      options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES,
      "maxSessionBytes",
    );
    if (this.maxSessionBytes < this.maxFileBytes) {
      throw new Error("maxSessionBytes must be at least maxFileBytes");
    }
    this.maxExportEntries = positiveSafeInteger(
      options.maxExportEntries ?? DEFAULT_MAX_EXPORT_ENTRIES,
      "maxExportEntries",
    );
    this.database = database;
  }

  static async open(options: BrowserDownloadStoreOptions): Promise<BrowserDownloadStore> {
    const rootDirectory = resolve(options.rootDirectory);
    const filesDirectory = join(rootDirectory, "files");
    const storedDirectory = join(rootDirectory, "stored");
    await mkdir(filesDirectory, { recursive: true, mode: 0o700 });
    await mkdir(storedDirectory, { recursive: true, mode: 0o700 });
    await chmod(rootDirectory, 0o700);
    await chmod(filesDirectory, 0o700);
    await chmod(storedDirectory, 0o700);
    const database = new Database(join(rootDirectory, "downloads.sqlite"), {
      create: true,
      readwrite: true,
      strict: true,
    });
    try {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec(`
        CREATE TABLE IF NOT EXISTS browser_downloads (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          guid TEXT NOT NULL UNIQUE,
          target_id TEXT,
          filename TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('in_progress', 'completed', 'cancelled', 'failed', 'unavailable')
          ),
          received_bytes INTEGER NOT NULL CHECK (received_bytes >= 0),
          total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
          sha256 TEXT,
          version INTEGER NOT NULL CHECK (version > 0),
          started_at TEXT NOT NULL,
          settled_at TEXT,
          failure_code TEXT,
          CHECK (
            (status = 'in_progress' AND settled_at IS NULL)
            OR (status <> 'in_progress' AND settled_at IS NOT NULL)
          ),
          CHECK (
            (status IN ('failed', 'unavailable') AND failure_code IS NOT NULL)
            OR (status NOT IN ('failed', 'unavailable') AND failure_code IS NULL)
          ),
          CHECK (
            (status = 'completed' AND length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
            OR (status <> 'completed' AND sha256 IS NULL)
          )
        );
        CREATE TABLE IF NOT EXISTS browser_download_exports (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL UNIQUE,
          download_id TEXT NOT NULL,
          request_digest TEXT NOT NULL CHECK (
            length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
          ),
          state TEXT NOT NULL CHECK (state IN ('prepared', 'completed')),
          receipt_json TEXT,
          updated_at TEXT NOT NULL,
          CHECK (
            (state = 'completed' AND receipt_json IS NOT NULL)
            OR (state = 'prepared' AND receipt_json IS NULL)
          )
        );
      `);
      const columns = database
        .query<{ name: string }, []>("PRAGMA table_info(browser_downloads)")
        .all();
      if (!columns.some((column) => column.name === "file_name"))
        database.exec("ALTER TABLE browser_downloads ADD COLUMN file_name TEXT");
      const store = new BrowserDownloadStore({ ...options, rootDirectory }, database);
      await store.recover();
      await chmod(join(rootDirectory, "downloads.sqlite"), 0o600);
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  begin(event: BrowserDownloadBeginEvent): Promise<BrowserDownloadValue> {
    return this.enqueue(async () => {
      const guid = requireGuid(event.guid);
      const targetId = event.targetId === null ? null : requireOpaqueId(event.targetId, "targetId");
      const filename = safeFilename(event.suggestedFilename);
      const existing = this.rowByGuid(guid);
      if (existing) {
        if (existing.target_id !== targetId || existing.filename !== filename) {
          throw new Error("download GUID is already bound to another browser event");
        }
        return this.fromRow(existing);
      }
      const id = requireUuid(this.createId(), "download id");
      const startedAt = canonicalTimestamp(this.now(), "download start");
      this.database
        .query<unknown, [string, string, string | null, string, string]>(
          `INSERT INTO browser_downloads (
             id, guid, target_id, filename, status, received_bytes, total_bytes,
             sha256, version, started_at, settled_at, failure_code
           ) VALUES (?, ?, ?, ?, 'in_progress', 0, NULL, NULL, 1, ?, NULL, NULL)`,
        )
        .run(id, guid, targetId, filename, startedAt);
      this.announcedAfter.set(guid, this.observationSequence);
      return this.fromRow(this.requireRowByGuid(guid));
    });
  }

  progress(event: BrowserDownloadProgressEvent): Promise<BrowserDownloadProgressResult> {
    return this.enqueue(async () => {
      const guid = requireGuid(event.guid);
      const receivedBytes = nonnegativeSafeInteger(event.receivedBytes, "receivedBytes");
      const totalBytes =
        event.totalBytes === null ? null : nonnegativeSafeInteger(event.totalBytes, "totalBytes");
      const row = this.requireRowByGuid(guid);
      if (row.status !== "in_progress") {
        // A cancellation request can race a final Chromium write. Once this
        // resource settled as anything other than completed, no late event may
        // resurrect placement-private bytes or leave an orphan behind.
        if (row.status !== "completed") {
          const fileName = event.filePath
            ? downloadedFileName(this.filesDirectory, event.filePath)
            : null;
          if (event.state !== "inProgress") {
            await this.observeChromiumFile(row, event.state === "completed" ? fileName : null);
            await this.resolveHeld();
          }
          await this.discardFiles(
            row.guid,
            fileName,
            this.observations.get(row.guid)?.identity ?? null,
            event.eventBarrier ?? null,
          );
        }
        return { cancelReason: null };
      }
      if (receivedBytes < row.received_bytes) {
        throw new Error("download byte progress moved backwards");
      }
      // A held completion's bytes are already kept; Chromium has nothing more.
      if (this.held.has(guid)) return { cancelReason: null };
      const projectedBytes = this.otherActiveBytes(guid) + receivedBytes;
      if (
        receivedBytes > this.maxFileBytes ||
        (totalBytes !== null && totalBytes > this.maxFileBytes) ||
        projectedBytes > this.maxSessionBytes
      ) {
        // Chromium cannot cancel a download it already completed, so its
        // saved file is removed here; the caller then rejects the download.
        if (event.state === "completed") {
          const fileName = event.filePath
            ? downloadedFileName(this.filesDirectory, event.filePath)
            : null;
          await this.observeChromiumFile(row, fileName);
          await this.discardFiles(
            row.guid,
            fileName,
            this.observations.get(row.guid)?.identity ?? null,
            event.eventBarrier ?? null,
          );
        }
        return { cancelReason: "download_quota_exceeded" };
      }
      if (event.state === "canceled") {
        this.observe(row, null, false);
        await this.removePhysicalFiles(guid);
        this.settle(guid, "cancelled", receivedBytes, totalBytes, null, null);
        await this.resolveHeld();
        return { cancelReason: null };
      }
      if (event.state === "completed") {
        if (event.personFilePath !== undefined) {
          await this.completeFromPersonFile(row, receivedBytes, totalBytes, event.personFilePath);
          await this.resolveHeld();
          return { cancelReason: null };
        }
        await this.complete(
          row,
          receivedBytes,
          totalBytes,
          event.filePath ?? null,
          event.eventBarrier ?? null,
        );
        await this.resolveHeld();
        return { cancelReason: null };
      }
      if (receivedBytes !== row.received_bytes || totalBytes !== row.total_bytes) {
        this.database
          .query<unknown, [number, number | null, string]>(
            `UPDATE browser_downloads
                SET received_bytes = ?, total_bytes = ?, version = version + 1
              WHERE guid = ? AND status = 'in_progress'`,
          )
          .run(receivedBytes, totalBytes, guid);
      }
      // Chromium sets both counts to the final size once all data is saved,
      // before it renames the file; an unknown total is reported as 0.
      if (totalBytes !== null && totalBytes > 0 ? receivedBytes < totalBytes : receivedBytes > 0) {
        this.clearStillReceiving(guid);
        await this.resolveHeld();
      }
      return { cancelReason: null };
    });
  }

  /** Settle a download the caller no longer wants. `confirmed` means
   * Chromium accepted its cancellation, so it ended without saving a file
   * unless its completion was reported first; otherwise it stays a possible
   * writer until Chromium reports how it ended. */
  reject(
    guidInput: string,
    failureCodeInput: string,
    cancellation: "confirmed" | "uncertain" = "uncertain",
  ): Promise<void> {
    return this.enqueue(async () => {
      const guid = requireGuid(guidInput);
      const failureCode = requireFailureCode(failureCodeInput);
      const row = this.requireRowByGuid(guid);
      // A completion Chromium reported before accepting the cancellation was
      // seen already, since its events and replies arrive in order.
      if (cancellation === "confirmed") this.observe(row, null, false);
      else if (!this.observations.has(guid)) this.unconfirmed.add(guid);
      this.held.delete(guid);
      await this.removePhysicalFiles(guid);
      if (row.status === "in_progress") {
        this.settle(guid, "failed", row.received_bytes, row.total_bytes, null, failureCode);
      }
      await this.resolveHeld();
    });
  }

  interruptInProgress(failureCodeInput: string): Promise<void> {
    return this.enqueue(async () => {
      const failureCode = requireFailureCode(failureCodeInput);
      const rows = this.database
        .query<{ guid: string }, []>(
          "SELECT guid FROM browser_downloads WHERE status = 'in_progress' ORDER BY sequence",
        )
        .all();
      this.held.clear();
      this.observations.clear();
      this.unconfirmed.clear();
      this.announcedAfter.clear();
      for (const row of rows) {
        await this.removePhysicalFiles(row.guid);
        const current = this.requireRowByGuid(row.guid);
        this.settle(
          row.guid,
          "failed",
          current.received_bytes,
          current.total_bytes,
          null,
          failureCode,
        );
      }
    });
  }

  list(): Promise<BrowserDownloadValue[]> {
    return this.enqueue(async () =>
      this.database
        .query<DownloadRow, []>("SELECT * FROM browser_downloads ORDER BY sequence DESC")
        .all()
        .map((row) => this.fromRow(row)),
    );
  }

  get(downloadIdInput: string): Promise<BrowserDownloadValue | null> {
    return this.enqueue(async () => {
      const downloadId = requireUuid(downloadIdInput, "download id");
      const row = this.rowById(downloadId);
      return row ? this.fromRow(row) : null;
    });
  }

  completedFile(downloadIdInput: string): Promise<CompletedBrowserDownloadFile> {
    return this.enqueue(async () => {
      const downloadId = requireUuid(downloadIdInput, "download id");
      const row = this.rowById(downloadId);
      if (!row) throw new Error("download does not exist");
      if (row.status !== "completed" || !row.sha256) {
        throw new Error(`download is ${row.status.replace("_", " ")}`);
      }
      const path = this.filePath(row);
      try {
        const facts = await exactRegularFile(path);
        if (facts.size !== row.received_bytes) throw new Error("download size changed");
        const sha256 = await sha256File(path);
        if (sha256 !== row.sha256) throw new Error("download digest changed");
      } catch (error) {
        this.settleExistingCompletedAsUnavailable(row.guid, "download_storage_lost");
        throw error;
      }
      return { download: this.fromRow(this.requireRowByGuid(row.guid)), path };
    });
  }

  /** Publish one exact completed file through caller-supplied short-lived
   * object authority. The durable export fence binds only stable integrity
   * metadata; signed URLs and headers are deliberately never persisted. A
   * prepared export is safe to repeat because it PUTs identical verified bytes
   * to the operation's deterministic object key. */
  export(
    requestInput: BrowserDownloadExportRequestValue,
    upload: (
      path: string,
      authority: BrowserDownloadExportRequestValue["upload"],
      expected: { sizeBytes: number; sha256: string },
    ) => Promise<void>,
  ): Promise<BrowserDownloadExportReceiptValue> {
    const request = BrowserDownloadExportRequest.parse(requestInput);
    return this.enqueueExport(async () => {
      const existing = this.exportRow(request.operationId);
      if (existing?.state === "completed") {
        this.assertExportBinding(existing, request.downloadId);
        return BrowserDownloadExportReceipt.parse({
          ...this.exportReceipt(existing),
          replayed: true,
        });
      }

      const completed = await this.completedFile(request.downloadId);
      const sha256 = completed.download.sha256;
      if (!sha256) throw new Error("completed download has no integrity digest");
      const digest = exportDigest(request.downloadId, completed.download.receivedBytes, sha256);
      if (existing) {
        this.assertExportBinding(existing, request.downloadId, digest);
      } else {
        this.makeSpaceForExport();
        this.database
          .query<unknown, [string, string, string, string]>(
            `INSERT INTO browser_download_exports (
               operation_id, download_id, request_digest, state, receipt_json, updated_at
             ) VALUES (?, ?, ?, 'prepared', NULL, ?)`,
          )
          .run(
            request.operationId,
            request.downloadId,
            digest,
            canonicalTimestamp(this.now(), "download export preparation"),
          );
      }

      await upload(completed.path, request.upload, {
        sizeBytes: completed.download.receivedBytes,
        sha256,
      });
      const verified = await this.completedFile(request.downloadId);
      if (
        verified.download.receivedBytes !== completed.download.receivedBytes ||
        verified.download.sha256 !== sha256
      ) {
        throw new Error("download changed while it was being published");
      }
      const receipt = BrowserDownloadExportReceipt.parse({
        operationId: request.operationId,
        downloadId: request.downloadId,
        sizeBytes: completed.download.receivedBytes,
        sha256,
        replayed: false,
      });
      const result = this.database
        .query<unknown, [string, string, string]>(
          `UPDATE browser_download_exports
              SET state = 'completed', receipt_json = ?, updated_at = ?
            WHERE operation_id = ? AND state = 'prepared'`,
        )
        .run(
          JSON.stringify(receipt),
          canonicalTimestamp(this.now(), "download export completion"),
          request.operationId,
        );
      if (result.changes !== 1) throw new Error("download export lost its operation fence");
      return receipt;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Close the admission gate before draining. Otherwise a callback can enqueue
    // after `tail` was observed but before SQLite is closed.
    this.closed = true;
    await Promise.all([this.tail, this.exportTail]);
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.database.close();
  }

  private async recover(): Promise<void> {
    const settledAt = canonicalTimestamp(this.now(), "download recovery");
    const interrupted = this.database
      .query<{ guid: string }, []>(
        "SELECT guid FROM browser_downloads WHERE status = 'in_progress' ORDER BY sequence",
      )
      .all();
    for (const row of interrupted) await this.removePhysicalFiles(row.guid);
    this.database
      .query<unknown, [string]>(
        `UPDATE browser_downloads
            SET status = 'failed', settled_at = ?, failure_code = 'controller_restarted',
                sha256 = NULL, version = version + 1
          WHERE status = 'in_progress'`,
      )
      .run(settledAt);

    const completed = this.database
      .query<DownloadRow, []>(
        "SELECT * FROM browser_downloads WHERE status = 'completed' ORDER BY sequence",
      )
      .all();
    const retainedFiles = new Set<string>();
    const retainedStored = new Set<string>();
    for (const row of completed) {
      const stored = this.filePath(row);
      try {
        // A download completed before downloads were kept in `stored/` is
        // adopted from the file Chromium saved, provided it still holds the
        // exact bytes that completed.
        if (!(await pathExists(stored))) await keepFile(this.chromiumPath(row), stored);
        const facts = await exactRegularFile(stored);
        if (facts.size !== row.received_bytes) throw new Error("download size changed");
        if ((await sha256File(stored)) !== row.sha256) {
          throw new Error("download digest changed");
        }
        retainedFiles.add(row.file_name ?? row.guid);
        retainedStored.add(row.guid);
      } catch {
        this.settleExistingCompletedAsUnavailable(row.guid, "download_storage_lost");
        await rm(stored, { force: true });
      }
    }
    // A file system may list a kept file under another spelling of its name,
    // so a file a completed download keeps is retained by identity too.
    const kept = await this.keptIdentities();
    for (const entry of await readdir(this.filesDirectory)) {
      const path = join(this.filesDirectory, entry);
      if (retainedFiles.has(entry)) continue;
      const identity = await fileIdentity(path);
      if (identity !== null && kept.has(identity)) continue;
      await rm(path, { recursive: true, force: true });
    }
    for (const entry of await readdir(this.storedDirectory)) {
      if (!retainedStored.has(entry))
        await rm(join(this.storedDirectory, entry), { recursive: true, force: true });
    }
  }

  private async complete(
    row: DownloadRow,
    eventReceivedBytes: number,
    eventTotalBytes: number | null,
    reportedPath: string | null,
    eventBarrier: (() => Promise<void>) | null,
  ): Promise<void> {
    // Chromium names the file; it must be a plain entry of `files/`.
    const fileName =
      reportedPath === null ? null : downloadedFileName(this.filesDirectory, reportedPath);
    let observation: Observation | null = null;
    try {
      if (reportedPath !== null && fileName === null)
        throw new Error("download was saved outside its folder");
      const saved = this.chromiumPath({ guid: row.guid, file_name: fileName });
      const path = this.filePath(row);
      // Keep these bytes before a later download with the same name can
      // replace the file Chromium saved.
      await exactRegularFile(saved);
      observation = this.observe(row, await keepFile(saved, path), false);
      const sizeBytes = (await exactRegularFile(path)).size;
      if (
        sizeBytes > this.maxFileBytes ||
        this.otherActiveBytes(row.guid) + sizeBytes > this.maxSessionBytes
      ) {
        await this.discardFiles(row.guid, fileName, observation.identity, eventBarrier);
        this.settle(
          row.guid,
          "failed",
          Math.max(eventReceivedBytes, sizeBytes),
          eventTotalBytes ?? sizeBytes,
          null,
          "download_quota_exceeded",
        );
        return;
      }
      // The bytes Chromium reports writing are this download's; a file of
      // any other size is another download's that replaced it before it
      // could be kept, so Chromium's file stays for that download.
      if (sizeBytes !== eventReceivedBytes) {
        observation.conflict = true;
        await this.removePhysicalFiles(row.guid);
        this.settle(
          row.guid,
          "failed",
          eventReceivedBytes,
          eventTotalBytes,
          null,
          "download_integrity_failed",
        );
        return;
      }
      const sha256 = await sha256File(path);
      // The kept link shares the file Chromium saved. On Windows a read-only
      // file cannot be replaced, which would fail a later download with the
      // same name, so the read-only mode is applied elsewhere only.
      if (process.platform !== "win32") await chmod(path, 0o400);
      this.held.set(row.guid, { fileName, sizeBytes, sha256, waitFor: null });
      this.database
        .query<unknown, [number, number, string]>(
          `UPDATE browser_downloads
              SET received_bytes = ?, total_bytes = ?, version = version + 1
            WHERE guid = ? AND status = 'in_progress'`,
        )
        .run(sizeBytes, sizeBytes, row.guid);
      // A same-name download that replaced this file before it was kept was
      // announced before that, since Chromium announces a download before
      // writing it. Once every event emitted until now has reached the store,
      // those downloads are known.
      const guid = row.guid;
      if (eventBarrier === null) {
        // Without a barrier, the events already queued are all there is.
        void this.enqueue(() => this.awaitPeers(guid, true)).catch(() => undefined);
      } else {
        void eventBarrier()
          .then(
            () => true,
            () => false,
          )
          .then((ordered) => this.enqueue(() => this.awaitPeers(guid, ordered)))
          .catch(() => undefined);
      }
    } catch {
      if (observation) observation.conflict = true;
      else this.observe(row, null, true);
      await this.discardFiles(row.guid, fileName, observation?.identity ?? null, eventBarrier);
      this.settle(
        row.guid,
        "failed",
        eventReceivedBytes,
        eventTotalBytes,
        null,
        "download_integrity_failed",
      );
    }
  }

  /** Keep a copy of a download the person's own browser saved. Their file is
   * theirs: it is read, never moved, changed or removed, and nothing else
   * shares the copy, so it settles at once. Its size must be the bytes the
   * browser reported; anything else means the file found is not this
   * download's, or changed since. */
  private async completeFromPersonFile(
    row: DownloadRow,
    eventReceivedBytes: number,
    eventTotalBytes: number | null,
    personFilePath: string | null,
  ): Promise<void> {
    this.observe(row, null, false);
    if (personFilePath === null || !isAbsolute(personFilePath)) {
      this.settle(
        row.guid,
        "failed",
        eventReceivedBytes,
        eventTotalBytes,
        null,
        "download_location_unavailable",
      );
      return;
    }
    const path = this.filePath(row);
    try {
      await rm(path, { force: true });
      await copyRegularFile(personFilePath, path);
      const sizeBytes = (await exactRegularFile(path)).size;
      if (
        sizeBytes > this.maxFileBytes ||
        this.otherActiveBytes(row.guid) + sizeBytes > this.maxSessionBytes
      ) {
        await this.removePhysicalFiles(row.guid);
        this.settle(
          row.guid,
          "failed",
          Math.max(eventReceivedBytes, sizeBytes),
          eventTotalBytes ?? sizeBytes,
          null,
          "download_quota_exceeded",
        );
        return;
      }
      if (sizeBytes !== eventReceivedBytes) throw new Error("download size differs");
      const sha256 = await sha256File(path);
      if (process.platform !== "win32") await chmod(path, 0o400);
      this.settle(row.guid, "completed", sizeBytes, sizeBytes, sha256, null);
    } catch {
      await this.removePhysicalFiles(row.guid);
      this.settle(
        row.guid,
        "failed",
        eventReceivedBytes,
        eventTotalBytes,
        null,
        "download_integrity_failed",
      );
    }
  }

  /** Record what Chromium's finished download left at its name. The first
   * observation of a download stands; two downloads seeing the same file
   * conflict, whatever their names, since that file can be only one
   * download's bytes. When this download was announced after the other's
   * finish was observed, it renamed its file after that one's, so the file
   * is this download's and only the other conflicts. */
  private observe(
    row: Pick<DownloadRow, "guid" | "filename">,
    identity: FileIdentity | null,
    conflict: boolean,
  ): Observation {
    const existing = this.observations.get(row.guid);
    if (existing) return existing;
    this.unconfirmed.delete(row.guid);
    const observation: Observation = {
      sequence: ++this.observationSequence,
      identity,
      conflict,
    };
    if (identity !== null) {
      const announcedAfter = this.announcedAfter.get(row.guid);
      for (const [guid, other] of this.observations) {
        if (guid === row.guid || other.identity !== identity) continue;
        other.conflict = true;
        if (announcedAfter === undefined || announcedAfter < other.sequence)
          observation.conflict = true;
      }
    }
    this.observations.set(row.guid, observation);
    return observation;
  }

  /** Observe a finished download the store does not keep: its file's
   * identity when Chromium saved one, or a conflict when it is gone. */
  private async observeChromiumFile(
    row: Pick<DownloadRow, "guid" | "filename">,
    fileName: string | null,
  ): Promise<void> {
    if (this.observations.has(row.guid)) return;
    if (fileName === null) {
      this.observe(row, null, false);
      return;
    }
    const facts = await lstat(join(this.filesDirectory, fileName), { bigint: true }).catch(
      () => null,
    );
    if (!facts?.isFile()) this.observe(row, null, true);
    else this.observe(row, `${facts.dev}:${facts.ino}`, false);
  }

  /** After the event barrier: wait for the same-name downloads that were
   * still running when this one finished, or finished after it. One that
   * finished before it renamed its file before this one's, so it cannot
   * have replaced this one's bytes. */
  private async awaitPeers(guid: string, ordered: boolean): Promise<void> {
    const completion = this.held.get(guid);
    const own = this.observations.get(guid);
    if (!completion || !own) return;
    if (!ordered) own.conflict = true;
    const waitFor = new Set<string>();
    // Any download may be saved as the same file: file systems differ in
    // which names they treat as one, so names prove nothing. Wait for every
    // download that may still rename a file (running and not yet observed,
    // or rejected without a confirmed cancellation) and for every one
    // observed after this one.
    for (const { guid: peer } of this.database
      .query<{ guid: string }, [string]>(
        "SELECT guid FROM browser_downloads WHERE guid <> ? AND status = 'in_progress'",
      )
      .all(guid))
      if (!this.observations.has(peer)) waitFor.add(peer);
    for (const peer of this.unconfirmed) if (peer !== guid) waitFor.add(peer);
    for (const [peer, observation] of this.observations)
      if (peer !== guid && observation.sequence > own.sequence) waitFor.add(peer);
    completion.waitFor = waitFor;
    await this.resolveHeld();
  }

  /** A download Chromium reports still receiving data after this one's
   * event barrier had not renamed its file when this one's was kept: it
   * renames only once all its data is saved. */
  private clearStillReceiving(guid: string): void {
    for (const completion of this.held.values()) completion.waitFor?.delete(guid);
  }

  /** Settle held completions whose peers have settled. A conflict in a
   * download or any download it waits for fails it: its file may be another
   * download's, and nothing tells which. */
  private async resolveHeld(): Promise<void> {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [guid, completion] of [...this.held]) {
        const row = this.rowByGuid(guid);
        const own = this.observations.get(guid);
        if (!row || row.status !== "in_progress" || !own) {
          this.held.delete(guid);
          changed = true;
          continue;
        }
        const peers = [...(completion.waitFor ?? [])];
        if (own.conflict || peers.some((peer) => this.observations.get(peer)?.conflict)) {
          own.conflict = true;
          this.held.delete(guid);
          await this.removePhysicalFiles(guid);
          this.settle(
            guid,
            "failed",
            row.received_bytes,
            row.total_bytes,
            null,
            "download_integrity_failed",
          );
          changed = true;
          continue;
        }
        if (
          completion.waitFor === null ||
          peers.some((peer) => !this.observations.has(peer) || this.held.has(peer))
        )
          continue;
        this.held.delete(guid);
        this.settle(
          guid,
          "completed",
          completion.sizeBytes,
          completion.sizeBytes,
          completion.sha256,
          null,
          completion.fileName,
        );
        changed = true;
      }
    }
    // Observations matter only while some download may still write a file.
    const running = this.database
      .query<{ guid: string }, []>(
        "SELECT guid FROM browser_downloads WHERE status = 'in_progress' LIMIT 1",
      )
      .get();
    if (!running && this.unconfirmed.size === 0) this.observations.clear();
  }

  private settle(
    guid: string,
    status: "completed" | "cancelled" | "failed",
    receivedBytes: number,
    totalBytes: number | null,
    sha256: string | null,
    failureCode: string | null,
    fileName: string | null = null,
  ): void {
    this.database
      .query<
        unknown,
        [string, number, number | null, string | null, string, string | null, string | null, string]
      >(
        `UPDATE browser_downloads
            SET status = ?, received_bytes = ?, total_bytes = ?, sha256 = ?,
                settled_at = ?, failure_code = ?, file_name = ?, version = version + 1
          WHERE guid = ? AND status = 'in_progress'`,
      )
      .run(
        status,
        receivedBytes,
        totalBytes,
        sha256,
        canonicalTimestamp(this.now(), "download settlement"),
        failureCode,
        fileName,
        guid,
      );
    this.announcedAfter.delete(guid);
  }

  private settleExistingCompletedAsUnavailable(guid: string, failureCode: string): void {
    this.database
      .query<unknown, [string, string, string]>(
        `UPDATE browser_downloads
            SET status = 'unavailable', settled_at = ?, failure_code = ?, sha256 = NULL,
                version = version + 1
          WHERE guid = ? AND status = 'completed'`,
      )
      .run(
        canonicalTimestamp(this.now(), "download unavailability"),
        requireFailureCode(failureCode),
        guid,
      );
  }

  private otherActiveBytes(guid: string): number {
    const row = this.database
      .query<{ bytes: number }, [string]>(
        `SELECT COALESCE(SUM(received_bytes), 0) AS bytes
           FROM browser_downloads
          WHERE guid <> ? AND status IN ('in_progress', 'completed')`,
      )
      .get(guid);
    return nonnegativeSafeInteger(row?.bytes ?? 0, "download session bytes");
  }

  private exportRow(operationId: string): DownloadExportRow | null {
    return (
      this.database
        .query<DownloadExportRow, [string]>(
          "SELECT * FROM browser_download_exports WHERE operation_id = ?",
        )
        .get(operationId) ?? null
    );
  }

  private assertExportBinding(
    row: DownloadExportRow,
    downloadId: string,
    requestDigest?: string,
  ): void {
    if (
      row.download_id !== downloadId ||
      (requestDigest !== undefined && row.request_digest !== requestDigest)
    ) {
      throw new Error("download export operation is already bound to another resource");
    }
  }

  private exportReceipt(row: DownloadExportRow): BrowserDownloadExportReceiptValue {
    if (!row.receipt_json) throw new Error("completed download export has no receipt");
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.receipt_json);
    } catch {
      throw new Error("download export receipt is corrupted");
    }
    const receipt = BrowserDownloadExportReceipt.parse(parsed);
    if (receipt.operationId !== row.operation_id || receipt.downloadId !== row.download_id) {
      throw new Error("download export receipt lost its resource binding");
    }
    return receipt;
  }

  private makeSpaceForExport(): void {
    const count = this.database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM browser_download_exports")
      .get()?.count;
    if ((count ?? 0) < this.maxExportEntries) return;
    const removed = this.database
      .query<unknown, []>(
        `DELETE FROM browser_download_exports
          WHERE sequence = (
            SELECT sequence FROM browser_download_exports
             WHERE state = 'completed' ORDER BY sequence LIMIT 1
          )`,
      )
      .run();
    if (removed.changes !== 1) throw new Error("browser download export journal is full");
  }

  private rowByGuid(guid: string): DownloadRow | null {
    return (
      this.database
        .query<DownloadRow, [string]>("SELECT * FROM browser_downloads WHERE guid = ?")
        .get(guid) ?? null
    );
  }

  private requireRowByGuid(guid: string): DownloadRow {
    const row = this.rowByGuid(guid);
    if (!row) throw new Error("download progress arrived before its start event");
    return row;
  }

  private rowById(id: string): DownloadRow | null {
    return (
      this.database
        .query<DownloadRow, [string]>("SELECT * FROM browser_downloads WHERE id = ?")
        .get(id) ?? null
    );
  }

  private fromRow(row: DownloadRow): BrowserDownloadValue {
    return BrowserDownload.parse({
      id: row.id,
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetId: row.target_id,
      filename: row.filename,
      status: row.status,
      receivedBytes: row.received_bytes,
      totalBytes: row.total_bytes,
      sha256: row.sha256,
      version: row.version,
      startedAt: row.started_at,
      settledAt: row.settled_at,
      failureCode: row.failure_code,
    });
  }

  /** The download's own bytes, kept apart from Chromium's folder. */
  private filePath(row: Pick<DownloadRow, "guid">): string {
    return join(this.storedDirectory, requireGuid(row.guid));
  }

  /** The file as Chromium saved it in its downloads folder. */
  private chromiumPath(row: Pick<DownloadRow, "guid" | "file_name">): string {
    return join(this.filesDirectory, row.file_name ?? requireGuid(row.guid));
  }

  /** Remove what a download that is not accepted left behind. Its kept bytes
   * go now. Chromium's named file, the one this download saw finished
   * (`expected`), goes only once every event emitted until now has reached
   * the store, since a download announced before then may have saved its own
   * file under that name; and only when it can be nobody else's. Otherwise
   * recovery sweeps it once nothing owns it. */
  private async discardFiles(
    guid: string,
    fileName: string | null,
    expected: FileIdentity | null,
    eventBarrier: (() => Promise<void>) | null,
  ): Promise<void> {
    await this.removePhysicalFiles(guid);
    if (fileName === null || expected === null) return;
    const remove = () =>
      this.enqueue(() => this.removeChromiumFileIfUnowned(guid, fileName, expected));
    if (eventBarrier === null) {
      // Without a barrier, the events already queued are all there is.
      void remove().catch(() => undefined);
      return;
    }
    void eventBarrier()
      .then(remove)
      .catch(() => undefined);
  }

  /** Remove Chromium's file at `fileName` if it is still the file a discarded
   * download saw, no other download may still save a file, and no completed
   * download keeps it. The file is moved aside before it is removed, so a
   * file Chromium saved there in the meantime is put back. */
  private async removeChromiumFileIfUnowned(
    guid: string,
    fileName: string,
    expected: FileIdentity,
  ): Promise<void> {
    const running = this.database
      .query<{ guid: string }, [string]>(
        "SELECT guid FROM browser_downloads WHERE guid <> ? AND status = 'in_progress' LIMIT 1",
      )
      .get(guid);
    if (running || [...this.unconfirmed].some((peer) => peer !== guid)) return;
    if ((await this.keptIdentities()).has(expected)) return;
    const path = join(this.filesDirectory, fileName);
    if ((await fileIdentity(path)) !== expected) return;
    const aside = join(this.storedDirectory, `.discard-${randomUUID()}`);
    try {
      await rename(path, aside);
    } catch {
      return;
    }
    if ((await fileIdentity(aside)) !== expected) {
      // Not the discarded file: put it back where Chromium saved it, never
      // over a file saved there since. If that fails it stays aside, and
      // recovery sweeps it.
      try {
        await link(aside, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        try {
          await copyFile(aside, path, fsConstants.COPYFILE_EXCL);
        } catch {
          return;
        }
      }
    }
    await rm(aside, { force: true });
  }

  /** The identities of the files completed downloads keep. A kept hard link
   * is the file Chromium saved, under whatever name it has. */
  private async keptIdentities(): Promise<Set<FileIdentity>> {
    const identities = new Set<FileIdentity>();
    for (const row of this.database
      .query<{ guid: string }, []>("SELECT guid FROM browser_downloads WHERE status = 'completed'")
      .all()) {
      const identity = await fileIdentity(this.filePath(row));
      if (identity !== null) identities.add(identity);
    }
    return identities;
  }

  /** Remove what is known of a download's bytes. Chromium removes the partial
   * file of a download it cancels or fails itself; recovery removes every
   * entry of `files/` that no completed download owns. */
  private async removePhysicalFiles(guid: string, fileName: string | null = null): Promise<void> {
    const path = this.chromiumPath({ guid, file_name: null });
    await Promise.all([
      rm(this.filePath({ guid }), { force: true }),
      rm(path, { force: true }),
      rm(`${path}.crdownload`, { force: true }),
      ...(fileName ? [rm(join(this.filesDirectory, fileName), { force: true })] : []),
    ]);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("browser download store is closed"));
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueExport<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("browser download store is closed"));
    const result = this.exportTail.then(operation);
    this.exportTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function exportDigest(downloadId: string, sizeBytes: number, sha256: string): string {
  return createHash("sha256")
    .update(
      `${requireUuid(downloadId, "download id")}\0${nonnegativeSafeInteger(sizeBytes, "download size")}\0${requireSha256(sha256)}`,
    )
    .digest("hex");
}

function requireGuid(value: string): string {
  if (!GUID_PATTERN.test(value)) throw new Error("download GUID is invalid");
  return value;
}

function requireUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value;
}

function requireGeneration(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error("controllerGeneration is invalid");
  }
  return value;
}

function requireOpaqueId(value: string, label: string): string {
  if (value.length < 1 || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireFailureCode(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error("download failure code is invalid");
  }
  return value;
}

function requireSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("download SHA-256 is invalid");
  return value;
}

function safeFilename(value: string): string {
  let bounded = "";
  let bytes = 0;
  for (const character of value.trim().replace(/[\\/\u0000-\u001f\u007f]/gu, "_")) {
    const nextBytes = Buffer.byteLength(character);
    if (bytes + nextBytes > 4_096) break;
    bounded += character;
    bytes += nextBytes;
  }
  return bounded || "download";
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function canonicalTimestamp(value: Date, label: string): string {
  if (!Number.isFinite(value.valueOf())) throw new Error(`${label} is invalid`);
  return value.toISOString();
}

async function exactRegularFile(path: string): Promise<{ size: number }> {
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("download is not a regular file");
  return { size: nonnegativeSafeInteger(facts.size, "download size") };
}

/** A regular file's identity, or null when there is none at `path`. */
async function fileIdentity(path: string): Promise<FileIdentity | null> {
  const facts = await lstat(path, { bigint: true }).catch(() => null);
  return facts?.isFile() ? `${facts.dev}:${facts.ino}` : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Keep `source`'s current bytes at `target` and return the identity of the
 * file they were kept from: a hard link shares them without copying and
 * survives the source name being replaced; a file system without hard links
 * gets an exclusive copy read from one open handle, so the identity is that
 * of the bytes copied even if the name is replaced meanwhile. */
async function keepFile(source: string, target: string): Promise<FileIdentity> {
  await rm(target, { force: true });
  try {
    await link(source, target);
    const facts = await lstat(target, { bigint: true });
    if (!facts.isFile()) throw new Error("download is not a regular file");
    return `${facts.dev}:${facts.ino}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EOPNOTSUPP")
      throw error;
  }
  return await copyRegularFile(source, target);
}

/** Copy a regular file to a new `target` from one open handle, returning the
 * source's identity. The source is only read. */
async function copyRegularFile(source: string, target: string): Promise<FileIdentity> {
  const input = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const facts = await input.stat({ bigint: true });
    if (!facts.isFile()) throw new Error("download is not a regular file");
    const output = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
        }
      }
    } finally {
      await output.close();
    }
    return `${facts.dev}:${facts.ino}`;
  } finally {
    await input.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

/** The name of a file Chromium reports saving directly in `files/`, or null
 * when the path lies anywhere else. */
function downloadedFileName(filesDirectory: string, reportedPath: string): string | null {
  const path = resolve(reportedPath);
  const name = basename(path);
  if (dirname(path) !== filesDirectory || !name || name === "." || name === "..") return null;
  if (name.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}
