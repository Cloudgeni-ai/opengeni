import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  parseBrowserProfileArtifactReceipt,
  type BrowserProfileArtifactReceipt,
} from "./state-artifact";

const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_RECEIPT_BYTES = 1024 * 1024;

type StateTransferRow = {
  sequence: number;
  operation_id: string;
  request_digest: string;
  state: string;
  receipt_json: string | null;
};

export type BrowserStateCaptureReceipt = BrowserProfileArtifactReceipt & {
  operationId: string;
  browserSessionId: string;
  controllerGeneration: string;
  objectKey: string;
};

export class BrowserStateTransferOutcomeUnknownError extends Error {
  readonly name = "BrowserStateTransferOutcomeUnknownError";
}

export class BrowserStateTransferConflictError extends Error {
  readonly name = "BrowserStateTransferConflictError";
}

/** Placement-local exactly-once fence for profile uploads. It stores bounded
 * integrity receipts only—never upload URLs, plaintext data keys, or AAD. */
export class SqliteBrowserStateTransferJournal {
  readonly path: string;
  private readonly browserSessionId: string;
  private readonly controllerGeneration: string;
  private readonly maxEntries: number;
  private readonly database: Database;
  private closed = false;

  private constructor(
    options: {
      path: string;
      browserSessionId: string;
      controllerGeneration: string;
      maxEntries?: number;
    },
    database: Database,
  ) {
    this.path = resolve(options.path);
    this.browserSessionId = requireUuid(options.browserSessionId, "browser session id");
    this.controllerGeneration = requireGeneration(options.controllerGeneration);
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.database = database;
  }

  static async open(options: {
    path: string;
    browserSessionId: string;
    controllerGeneration: string;
    maxEntries?: number;
  }): Promise<SqliteBrowserStateTransferJournal> {
    const path = resolve(options.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const database = new Database(path, {
      create: true,
      readwrite: true,
      strict: true,
    });
    try {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec(`
        CREATE TABLE IF NOT EXISTS browser_state_transfer_journal (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          browser_session_id TEXT NOT NULL,
          controller_generation TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('prepared', 'dispatched', 'completed', 'outcome_unknown')
          ),
          receipt_json TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (browser_session_id, controller_generation, operation_id),
          CHECK (
            (state = 'completed' AND receipt_json IS NOT NULL)
            OR (state <> 'completed' AND receipt_json IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS browser_state_transfer_authority_sequence
          ON browser_state_transfer_journal (
            browser_session_id, controller_generation, sequence
          );
      `);
      await chmod(path, 0o600);
      const journal = new SqliteBrowserStateTransferJournal({ ...options, path }, database);
      journal.recoverInterrupted();
      return journal;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Begin or replay one exact request. A prior dispatched upload is never retried blindly. */
  begin(operationIdInput: string, requestDigestInput: string): BrowserStateCaptureReceipt | null {
    this.assertOpen();
    const operationId = requireUuid(operationIdInput, "browser state operation id");
    const requestDigest = requireSha256(requestDigestInput, "browser state request digest");
    return this.immediateTransaction(() => {
      const existing = this.row(operationId);
      if (existing) {
        this.assertDigest(existing, requestDigest);
        if (existing.state === "completed") return this.receipt(existing);
        if (existing.state === "dispatched" || existing.state === "outcome_unknown") {
          throw new BrowserStateTransferOutcomeUnknownError(
            "browser state upload may already have reached object storage",
          );
        }
        return null;
      }
      this.makeSpaceForInsert();
      this.database
        .query<unknown, [string, string, string, string, string, string]>(
          `INSERT INTO browser_state_transfer_journal (
             browser_session_id, controller_generation, operation_id,
             request_digest, state, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.browserSessionId,
          this.controllerGeneration,
          operationId,
          requestDigest,
          "prepared",
          new Date().toISOString(),
        );
      return null;
    });
  }

  markDispatched(operationIdInput: string, requestDigestInput: string): void {
    this.transition(operationIdInput, requestDigestInput, "prepared", "dispatched", null);
  }

  markOutcomeUnknown(operationIdInput: string, requestDigestInput: string): void {
    this.transition(operationIdInput, requestDigestInput, "dispatched", "outcome_unknown", null);
  }

  complete(
    operationIdInput: string,
    requestDigestInput: string,
    receiptInput: BrowserStateCaptureReceipt,
  ): BrowserStateCaptureReceipt {
    const operationId = requireUuid(operationIdInput, "browser state operation id");
    const requestDigest = requireSha256(requestDigestInput, "browser state request digest");
    const receipt = parseReceipt(receiptInput, this.browserSessionId, this.controllerGeneration);
    if (receipt.operationId !== operationId) {
      throw new BrowserStateTransferConflictError("browser state receipt operation id changed");
    }
    const json = JSON.stringify(receipt);
    if (Buffer.byteLength(json) > MAX_RECEIPT_BYTES) {
      throw new Error("browser state receipt exceeds its durable byte envelope");
    }
    this.transition(operationId, requestDigest, "dispatched", "completed", json);
    return receipt;
  }

  /** A prepared transfer has not started its external side effect and can be retried safely. */
  abandonPrepared(operationIdInput: string, requestDigestInput: string): void {
    this.assertOpen();
    const operationId = requireUuid(operationIdInput, "browser state operation id");
    const requestDigest = requireSha256(requestDigestInput, "browser state request digest");
    this.immediateTransaction(() => {
      const existing = this.requiredRow(operationId);
      this.assertDigest(existing, requestDigest);
      if (existing.state !== "prepared") {
        throw new BrowserStateTransferConflictError(
          "browser state transfer already crossed its upload boundary",
        );
      }
      this.database
        .query<unknown, [number]>("DELETE FROM browser_state_transfer_journal WHERE sequence = ?")
        .run(existing.sequence);
    });
  }

  close(): void {
    if (this.closed) return;
    let checkpointFailure: unknown;
    try {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      checkpointFailure = error;
    }
    try {
      this.database.close();
    } finally {
      this.closed = true;
    }
    if (checkpointFailure) throw checkpointFailure;
  }

  private recoverInterrupted(): void {
    this.immediateTransaction(() => {
      this.database
        .query<unknown, [string, string, string]>(
          `UPDATE browser_state_transfer_journal
              SET state = 'outcome_unknown', updated_at = ?
            WHERE browser_session_id = ? AND controller_generation = ?
              AND state = 'dispatched'`,
        )
        .run(new Date().toISOString(), this.browserSessionId, this.controllerGeneration);
    });
  }

  private transition(
    operationIdInput: string,
    requestDigestInput: string,
    from: "prepared" | "dispatched",
    to: "dispatched" | "completed" | "outcome_unknown",
    receiptJson: string | null,
  ): void {
    this.assertOpen();
    const operationId = requireUuid(operationIdInput, "browser state operation id");
    const requestDigest = requireSha256(requestDigestInput, "browser state request digest");
    this.immediateTransaction(() => {
      const existing = this.requiredRow(operationId);
      this.assertDigest(existing, requestDigest);
      if (existing.state === to) {
        if ((existing.receipt_json ?? null) !== receiptJson) {
          throw new BrowserStateTransferConflictError(
            "browser state transfer state cannot be rewritten",
          );
        }
        return;
      }
      if (existing.state !== from) {
        throw new BrowserStateTransferConflictError(
          `invalid browser state transfer transition: ${existing.state} -> ${to}`,
        );
      }
      this.database
        .query<unknown, [string, string | null, string, number]>(
          `UPDATE browser_state_transfer_journal
              SET state = ?, receipt_json = ?, updated_at = ?
            WHERE sequence = ?`,
        )
        .run(to, receiptJson, new Date().toISOString(), existing.sequence);
    });
  }

  private receipt(row: StateTransferRow): BrowserStateCaptureReceipt {
    if (!row.receipt_json || Buffer.byteLength(row.receipt_json) > MAX_RECEIPT_BYTES) {
      throw new Error("browser state journal receipt is missing or corrupt");
    }
    let value: unknown;
    try {
      value = JSON.parse(row.receipt_json);
    } catch {
      throw new Error("browser state journal receipt JSON is corrupt");
    }
    return parseReceipt(value, this.browserSessionId, this.controllerGeneration);
  }

  private assertDigest(row: StateTransferRow, digest: string): void {
    if (row.request_digest !== digest) {
      throw new BrowserStateTransferConflictError(
        "browser state operation id is already bound to another request",
      );
    }
  }

  private makeSpaceForInsert(): void {
    const row = this.database
      .query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count FROM browser_state_transfer_journal
          WHERE browser_session_id = ? AND controller_generation = ?`,
      )
      .get(this.browserSessionId, this.controllerGeneration);
    if ((row?.count ?? 0) < this.maxEntries) return;
    const terminal = this.database
      .query<{ sequence: number }, [string, string]>(
        `SELECT sequence FROM browser_state_transfer_journal
          WHERE browser_session_id = ? AND controller_generation = ?
            AND state IN ('completed', 'outcome_unknown')
          ORDER BY sequence ASC LIMIT 1`,
      )
      .get(this.browserSessionId, this.controllerGeneration);
    if (!terminal) throw new Error("browser state journal has no safely evictable receipt");
    this.database
      .query<unknown, [number]>("DELETE FROM browser_state_transfer_journal WHERE sequence = ?")
      .run(terminal.sequence);
  }

  private row(operationId: string): StateTransferRow | null {
    return (
      this.database
        .query<StateTransferRow, [string, string, string]>(
          `SELECT sequence, operation_id, request_digest, state, receipt_json
             FROM browser_state_transfer_journal
            WHERE browser_session_id = ? AND controller_generation = ? AND operation_id = ?`,
        )
        .get(this.browserSessionId, this.controllerGeneration, operationId) ?? null
    );
  }

  private requiredRow(operationId: string): StateTransferRow {
    const row = this.row(operationId);
    if (!row)
      throw new BrowserStateTransferConflictError("browser state operation is not prepared");
    return row;
  }

  private immediateTransaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the first fail-closed journal error.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("browser state journal is closed");
  }
}

function parseReceipt(
  input: unknown,
  browserSessionId: string,
  controllerGeneration: string,
): BrowserStateCaptureReceipt {
  if (!isRecord(input)) throw new Error("browser state receipt must be an object");
  const allowed = new Set([
    "operationId",
    "browserSessionId",
    "controllerGeneration",
    "objectKey",
    "format",
    "artifactDigest",
    "contentDigest",
    "sizeBytes",
    "fileCount",
    "profileBytes",
    "manifest",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("browser state receipt contains unknown fields");
  }
  const operationId = requireUuid(input.operationId, "browser state operation id");
  if (
    input.browserSessionId !== browserSessionId ||
    input.controllerGeneration !== controllerGeneration
  ) {
    throw new BrowserStateTransferConflictError(
      "browser state receipt is outside journal authority",
    );
  }
  return {
    operationId,
    browserSessionId,
    controllerGeneration,
    objectKey: requireObjectKey(input.objectKey),
    ...parseBrowserProfileArtifactReceipt({
      format: input.format,
      artifactDigest: input.artifactDigest,
      contentDigest: input.contentDigest,
      sizeBytes: input.sizeBytes,
      fileCount: input.fileCount,
      profileBytes: input.profileBytes,
      manifest: input.manifest,
    }),
  };
}

function requireObjectKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > 2_048 ||
    !/^workspaces\/[0-9a-f-]+\/browser-state\/[A-Za-z0-9._=-]+(?:\/[A-Za-z0-9._=-]+)*$/iu.test(
      value,
    )
  ) {
    throw new Error("browser state object key is invalid");
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireGeneration(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error("browser controller generation is invalid");
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
