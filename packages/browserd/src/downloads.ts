import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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
};

export type BrowserDownloadProgressResult = {
  cancelReason: "download_quota_exceeded" | null;
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

/** Placement-private download authority. Chromium writes GUID-named files into
 * `files/`; SQLite retains only bounded metadata and never a source URL or a
 * public local path. All event and export work is serialized so a completion,
 * cancellation, and caller read cannot observe half-settled state. */
export class BrowserDownloadStore {
  readonly rootDirectory: string;
  readonly filesDirectory: string;
  private readonly browserSessionId: string;
  private readonly controllerGeneration: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxFileBytes: number;
  private readonly maxSessionBytes: number;
  private readonly maxExportEntries: number;
  private readonly database: Database;
  private tail: Promise<void> = Promise.resolve();
  private exportTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(options: BrowserDownloadStoreOptions, database: Database) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.filesDirectory = join(this.rootDirectory, "files");
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
    await mkdir(filesDirectory, { recursive: true, mode: 0o700 });
    await chmod(rootDirectory, 0o700);
    await chmod(filesDirectory, 0o700);
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
        if (row.status !== "completed") await this.removePhysicalFiles(guid);
        return { cancelReason: null };
      }
      if (receivedBytes < row.received_bytes) {
        throw new Error("download byte progress moved backwards");
      }
      const projectedBytes = this.otherActiveBytes(guid) + receivedBytes;
      if (
        receivedBytes > this.maxFileBytes ||
        (totalBytes !== null && totalBytes > this.maxFileBytes) ||
        projectedBytes > this.maxSessionBytes
      ) {
        return { cancelReason: "download_quota_exceeded" };
      }
      if (event.state === "canceled") {
        await this.removePhysicalFiles(guid);
        this.settle(guid, "cancelled", receivedBytes, totalBytes, null, null);
        return { cancelReason: null };
      }
      if (event.state === "completed") {
        await this.complete(row, receivedBytes, totalBytes);
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
      return { cancelReason: null };
    });
  }

  reject(guidInput: string, failureCodeInput: string): Promise<void> {
    return this.enqueue(async () => {
      const guid = requireGuid(guidInput);
      const failureCode = requireFailureCode(failureCodeInput);
      const row = this.requireRowByGuid(guid);
      await this.removePhysicalFiles(guid);
      if (row.status === "in_progress") {
        this.settle(guid, "failed", row.received_bytes, row.total_bytes, null, failureCode);
      }
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
      const path = this.filePath(row.guid);
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
    const retained = new Set<string>();
    for (const row of completed) {
      retained.add(row.guid);
      try {
        const facts = await exactRegularFile(this.filePath(row.guid));
        if (facts.size !== row.received_bytes) throw new Error("download size changed");
        if ((await sha256File(this.filePath(row.guid))) !== row.sha256) {
          throw new Error("download digest changed");
        }
      } catch {
        this.settleExistingCompletedAsUnavailable(row.guid, "download_storage_lost");
        retained.delete(row.guid);
        await this.removePhysicalFiles(row.guid);
      }
    }
    for (const entry of await readdir(this.filesDirectory)) {
      if (!retained.has(entry))
        await rm(join(this.filesDirectory, entry), { recursive: true, force: true });
    }
  }

  private async complete(
    row: DownloadRow,
    eventReceivedBytes: number,
    eventTotalBytes: number | null,
  ): Promise<void> {
    try {
      const path = this.filePath(row.guid);
      const facts = await exactRegularFile(path);
      const sizeBytes = facts.size;
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
      const sha256 = await sha256File(path);
      await chmod(path, 0o400);
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

  private settle(
    guid: string,
    status: "completed" | "cancelled" | "failed",
    receivedBytes: number,
    totalBytes: number | null,
    sha256: string | null,
    failureCode: string | null,
  ): void {
    this.database
      .query<
        unknown,
        [string, number, number | null, string | null, string, string | null, string]
      >(
        `UPDATE browser_downloads
            SET status = ?, received_bytes = ?, total_bytes = ?, sha256 = ?,
                settled_at = ?, failure_code = ?, version = version + 1
          WHERE guid = ? AND status = 'in_progress'`,
      )
      .run(
        status,
        receivedBytes,
        totalBytes,
        sha256,
        canonicalTimestamp(this.now(), "download settlement"),
        failureCode,
        guid,
      );
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

  private filePath(guid: string): string {
    return join(this.filesDirectory, requireGuid(guid));
  }

  private async removePhysicalFiles(guid: string): Promise<void> {
    const path = this.filePath(guid);
    await Promise.all([rm(path, { force: true }), rm(`${path}.crdownload`, { force: true })]);
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
