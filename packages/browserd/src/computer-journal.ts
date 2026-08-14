import { ComputerActionReceipt } from "@opengeni/contracts";
import {
  recoverComputerOperationJournalRecord,
  type ComputerOperationJournalRecord,
} from "@opengeni/interaction";
import { SqliteInteractionOperationJournal } from "./operation-journal";

export type SqliteComputerOperationJournalOptions = {
  path: string;
  computerSessionId: string;
  controllerGeneration: string;
  maxEntries?: number;
  maxRecordBytes?: number;
};

/** Computer adapter over the one resource-neutral placement journal. */
export class SqliteComputerOperationJournal {
  readonly path: string;

  private constructor(
    private readonly journal: SqliteInteractionOperationJournal<ComputerActionReceipt>,
  ) {
    this.path = journal.path;
  }

  static async open(
    options: SqliteComputerOperationJournalOptions,
  ): Promise<SqliteComputerOperationJournal> {
    const journal = await SqliteInteractionOperationJournal.open({
      path: options.path,
      resourceKind: "computer_session",
      resourceId: options.computerSessionId,
      controllerGeneration: options.controllerGeneration,
      resourceLabel: "computer",
      parseReceipt: (value) => ComputerActionReceipt.parse(value),
      assertReceiptAuthority(receipt) {
        if (
          receipt.computerSessionId !== options.computerSessionId ||
          receipt.controllerGeneration !== options.controllerGeneration
        ) {
          throw new Error("computer operation record is outside journal authority");
        }
      },
      recoverRecord: recoverComputerOperationJournalRecord,
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      ...(options.maxRecordBytes !== undefined ? { maxRecordBytes: options.maxRecordBytes } : {}),
    });
    return new SqliteComputerOperationJournal(journal);
  }

  write(record: ComputerOperationJournalRecord): void {
    this.journal.write(record);
  }

  loadAndRecover(settledAt?: string): ComputerOperationJournalRecord[] {
    return this.journal.loadAndRecover(settledAt);
  }

  close(): void {
    this.journal.close();
  }
}
