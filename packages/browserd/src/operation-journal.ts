import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { InteractionOperationState } from "@opengeni/contracts";
import { Database } from "bun:sqlite";

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
const terminalStates = new Set<InteractionOperationState>([
  "completed",
  "failed",
  "outcome_unknown",
]);

type JournalReceipt = {
  operationId: string;
  controllerGeneration: string;
  state: InteractionOperationState;
};

export type InteractionJournalRecord<TReceipt> = {
  operationId: string;
  commandDigest: string;
  receipt: TReceipt;
};

type JournalRow = {
  sequence: number;
  operation_id: string;
  command_digest: string;
  state: string;
  receipt_json: string;
  receipt_bytes: number;
};

export type SqliteInteractionOperationJournalOptions<TReceipt extends JournalReceipt> = {
  path: string;
  resourceKind: "browser_session" | "computer_session";
  resourceId: string;
  controllerGeneration: string;
  resourceLabel: "browser" | "computer";
  parseReceipt(value: unknown): TReceipt;
  assertReceiptAuthority(receipt: TReceipt): void;
  recoverRecord(
    record: InteractionJournalRecord<TReceipt>,
    settledAt: string,
  ): InteractionJournalRecord<TReceipt>;
  maxEntries?: number;
  maxRecordBytes?: number;
};

/** Resource-neutral, crash-safe placement operation authority. It persists
 * only a command digest and bounded typed receipt; recovery never replays a
 * possibly dispatched mutation. */
export class SqliteInteractionOperationJournal<TReceipt extends JournalReceipt> {
  readonly path: string;
  private readonly resourceKind: "browser_session" | "computer_session";
  private readonly resourceId: string;
  private readonly controllerGeneration: string;
  private readonly resourceLabel: "browser" | "computer";
  private readonly parseReceipt: (value: unknown) => TReceipt;
  private readonly assertReceiptAuthority: (receipt: TReceipt) => void;
  private readonly recoverRecord: (
    record: InteractionJournalRecord<TReceipt>,
    settledAt: string,
  ) => InteractionJournalRecord<TReceipt>;
  private readonly maxEntries: number;
  private readonly maxRecordBytes: number;
  private readonly database: Database;
  private closed = false;

  private constructor(
    options: SqliteInteractionOperationJournalOptions<TReceipt>,
    database: Database,
  ) {
    this.path = resolve(options.path);
    this.resourceKind = options.resourceKind;
    this.resourceId = options.resourceId;
    this.controllerGeneration = options.controllerGeneration;
    this.resourceLabel = options.resourceLabel;
    this.parseReceipt = options.parseReceipt;
    this.assertReceiptAuthority = options.assertReceiptAuthority;
    this.recoverRecord = options.recoverRecord;
    this.maxEntries = boundedPositiveInteger(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      "maxEntries",
    );
    this.maxRecordBytes = boundedPositiveInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      "maxRecordBytes",
    );
    this.database = database;
  }

  static async open<TReceipt extends JournalReceipt>(
    options: SqliteInteractionOperationJournalOptions<TReceipt>,
  ): Promise<SqliteInteractionOperationJournal<TReceipt>> {
    const path = resolve(options.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const database = new Database(path, { create: true, readwrite: true, strict: true });
    try {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec(`
        CREATE TABLE IF NOT EXISTS interaction_operation_journal (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          resource_kind TEXT NOT NULL CHECK (
            resource_kind IN ('browser_session', 'computer_session')
          ),
          resource_id TEXT NOT NULL,
          controller_generation TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          command_digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('prepared', 'dispatched', 'completed', 'failed', 'outcome_unknown')
          ),
          receipt_json TEXT NOT NULL,
          receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes > 0),
          updated_at TEXT NOT NULL,
          UNIQUE (resource_kind, resource_id, controller_generation, operation_id)
        );
        CREATE INDEX IF NOT EXISTS interaction_operation_journal_authority_sequence
          ON interaction_operation_journal (
            resource_kind,
            resource_id,
            controller_generation,
            sequence
          );
      `);
      await chmod(path, 0o600);
      return new SqliteInteractionOperationJournal({ ...options, path }, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  write(recordInput: InteractionJournalRecord<TReceipt>): void {
    this.assertOpen();
    const record = this.validate(recordInput);
    this.immediateTransaction(() => this.writeInTransaction(record));
  }

  loadAndRecover(settledAt = new Date().toISOString()): InteractionJournalRecord<TReceipt>[] {
    this.assertOpen();
    const parsedSettledAt = new Date(settledAt);
    if (
      !Number.isFinite(parsedSettledAt.valueOf()) ||
      parsedSettledAt.toISOString() !== settledAt
    ) {
      throw new Error("settledAt must be a canonical ISO timestamp");
    }
    return this.immediateTransaction(() => {
      const records = this.rows().map((row) => this.recordFromRow(row));
      for (let index = 0; index < records.length; index += 1) {
        const recovered = this.recoverRecord(records[index]!, settledAt);
        if (recovered.receipt.state !== records[index]!.receipt.state) {
          this.writeInTransaction(this.validate(recovered));
          records[index] = recovered;
        }
      }
      this.trimToLimit();
      return this.rows().map((row) => this.recordFromRow(row));
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

  private validate(record: InteractionJournalRecord<TReceipt>): InteractionJournalRecord<TReceipt> {
    if (!/^[0-9a-f]{64}$/u.test(record.commandDigest)) {
      throw new Error(`${this.resourceLabel} operation command digest must be lowercase SHA-256`);
    }
    const receipt = this.parseReceipt(record.receipt);
    this.assertReceiptAuthority(receipt);
    if (receipt.operationId !== record.operationId) {
      throw new Error(`${this.resourceLabel} operation record is outside journal authority`);
    }
    const receiptJson = JSON.stringify(receipt);
    if (Buffer.byteLength(receiptJson) > this.maxRecordBytes) {
      throw new Error(`${this.resourceLabel} operation receipt exceeds its durable byte envelope`);
    }
    return { operationId: record.operationId, commandDigest: record.commandDigest, receipt };
  }

  private writeInTransaction(record: InteractionJournalRecord<TReceipt>): void {
    const receiptJson = JSON.stringify(record.receipt);
    const receiptBytes = Buffer.byteLength(receiptJson);
    const existing = this.database
      .query<JournalRow, [string, string, string, string]>(
        `SELECT sequence, operation_id, command_digest, state, receipt_json, receipt_bytes
           FROM interaction_operation_journal
          WHERE resource_kind = ? AND resource_id = ?
            AND controller_generation = ? AND operation_id = ?`,
      )
      .get(this.resourceKind, this.resourceId, this.controllerGeneration, record.operationId);
    if (!existing) {
      if (record.receipt.state !== "prepared") {
        throw new Error(`new ${this.resourceLabel} operation journal records must begin prepared`);
      }
      this.makeSpaceForInsert();
      this.database
        .query<unknown, [string, string, string, string, string, string, string, number, string]>(
          `INSERT INTO interaction_operation_journal (
             resource_kind, resource_id, controller_generation, operation_id,
             command_digest, state, receipt_json, receipt_bytes, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.resourceKind,
          this.resourceId,
          this.controllerGeneration,
          record.operationId,
          record.commandDigest,
          record.receipt.state,
          receiptJson,
          receiptBytes,
          new Date().toISOString(),
        );
      return;
    }
    if (existing.command_digest !== record.commandDigest) {
      throw new Error(
        `${this.resourceLabel} operation id is already bound to another command digest`,
      );
    }
    if (existing.state === record.receipt.state) {
      if (existing.receipt_json !== receiptJson) {
        throw new Error(
          `${this.resourceLabel} operation state cannot be rewritten with a different receipt`,
        );
      }
      return;
    }
    if (!isValidTransition(existing.state, record.receipt.state)) {
      throw new Error(
        `invalid ${this.resourceLabel} operation transition: ${existing.state} -> ${record.receipt.state}`,
      );
    }
    this.database
      .query<unknown, [string, string, number, string, number]>(
        `UPDATE interaction_operation_journal
            SET state = ?, receipt_json = ?, receipt_bytes = ?, updated_at = ?
          WHERE sequence = ?`,
      )
      .run(
        record.receipt.state,
        receiptJson,
        receiptBytes,
        new Date().toISOString(),
        existing.sequence,
      );
  }

  private makeSpaceForInsert(): void {
    if (this.count() < this.maxEntries) return;
    const terminal = this.oldestTerminal();
    if (!terminal) {
      throw new Error(`${this.resourceLabel} operation journal has no safely evictable record`);
    }
    this.deleteSequence(terminal.sequence);
  }

  private trimToLimit(): void {
    while (this.count() > this.maxEntries) {
      const terminal = this.oldestTerminal();
      if (!terminal) {
        throw new Error(`${this.resourceLabel} operation journal exceeds its safe capacity`);
      }
      this.deleteSequence(terminal.sequence);
    }
  }

  private oldestTerminal(): { sequence: number } | null {
    return (
      this.database
        .query<{ sequence: number }, [string, string, string]>(
          `SELECT sequence
             FROM interaction_operation_journal
            WHERE resource_kind = ? AND resource_id = ? AND controller_generation = ?
              AND state IN ('completed', 'failed', 'outcome_unknown')
            ORDER BY sequence ASC
            LIMIT 1`,
        )
        .get(this.resourceKind, this.resourceId, this.controllerGeneration) ?? null
    );
  }

  private deleteSequence(sequence: number): void {
    this.database
      .query<unknown, [number]>("DELETE FROM interaction_operation_journal WHERE sequence = ?")
      .run(sequence);
  }

  private count(): number {
    const row = this.database
      .query<{ count: number }, [string, string, string]>(
        `SELECT COUNT(*) AS count
           FROM interaction_operation_journal
          WHERE resource_kind = ? AND resource_id = ? AND controller_generation = ?`,
      )
      .get(this.resourceKind, this.resourceId, this.controllerGeneration);
    return row?.count ?? 0;
  }

  private rows(): JournalRow[] {
    return this.database
      .query<JournalRow, [string, string, string]>(
        `SELECT sequence, operation_id, command_digest, state, receipt_json, receipt_bytes
           FROM interaction_operation_journal
          WHERE resource_kind = ? AND resource_id = ? AND controller_generation = ?
          ORDER BY sequence ASC`,
      )
      .all(this.resourceKind, this.resourceId, this.controllerGeneration);
  }

  private recordFromRow(row: JournalRow): InteractionJournalRecord<TReceipt> {
    if (row.receipt_bytes !== Buffer.byteLength(row.receipt_json)) {
      throw new Error(`${this.resourceLabel} operation journal receipt byte count is corrupt`);
    }
    let receipt: unknown;
    try {
      receipt = JSON.parse(row.receipt_json);
    } catch {
      throw new Error(`${this.resourceLabel} operation journal receipt JSON is corrupt`);
    }
    return this.validate({
      operationId: row.operation_id,
      commandDigest: row.command_digest,
      receipt: this.parseReceipt(receipt),
    });
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
        // Preserve the original failure; either failure leaves this journal fail-closed.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`${this.resourceLabel} operation journal is closed`);
  }
}

function isValidTransition(from: string, to: InteractionOperationState): boolean {
  if (terminalStates.has(from as InteractionOperationState)) return false;
  if (from === "prepared") return to === "dispatched" || to === "failed";
  return from === "dispatched" && terminalStates.has(to);
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}
