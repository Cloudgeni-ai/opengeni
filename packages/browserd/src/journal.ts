import { BrowserActionReceipt } from "@opengeni/contracts";
import {
  recoverBrowserOperationJournalRecord,
  type BrowserOperationJournalRecord,
} from "@opengeni/interaction";
import { SqliteInteractionOperationJournal } from "./operation-journal";

export type SqliteBrowserOperationJournalOptions = {
  path: string;
  browserSessionId: string;
  controllerGeneration: string;
  maxEntries?: number;
  maxRecordBytes?: number;
};

/** Browser adapter over the one resource-neutral placement journal. */
export class SqliteBrowserOperationJournal {
  readonly path: string;

  private constructor(
    private readonly journal: SqliteInteractionOperationJournal<BrowserActionReceipt>,
  ) {
    this.path = journal.path;
  }

  static async open(
    options: SqliteBrowserOperationJournalOptions,
  ): Promise<SqliteBrowserOperationJournal> {
    const journal = await SqliteInteractionOperationJournal.open({
      path: options.path,
      resourceKind: "browser_session",
      resourceId: options.browserSessionId,
      controllerGeneration: options.controllerGeneration,
      resourceLabel: "browser",
      parseReceipt: (value) => BrowserActionReceipt.parse(value),
      assertReceiptAuthority(receipt) {
        if (
          receipt.browserSessionId !== options.browserSessionId ||
          receipt.controllerGeneration !== options.controllerGeneration
        ) {
          throw new Error("browser operation record is outside journal authority");
        }
      },
      recoverRecord: recoverBrowserOperationJournalRecord,
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      ...(options.maxRecordBytes !== undefined ? { maxRecordBytes: options.maxRecordBytes } : {}),
    });
    return new SqliteBrowserOperationJournal(journal);
  }

  write(record: BrowserOperationJournalRecord): void {
    this.journal.write(record);
  }

  loadAndRecover(settledAt?: string): BrowserOperationJournalRecord[] {
    return this.journal.loadAndRecover(settledAt);
  }

  close(): void {
    this.journal.close();
  }
}
