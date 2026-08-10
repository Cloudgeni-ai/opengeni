import { BrowserProtectedAuthFillReceipt } from "@opengeni/contracts";
import {
  recoverBrowserProtectedAuthOperationJournalRecord,
  type BrowserProtectedAuthOperationJournalRecord,
} from "@opengeni/interaction";
import { SqliteInteractionOperationJournal } from "./operation-journal";

export type SqliteBrowserProtectedAuthJournalOptions = {
  path: string;
  browserSessionId: string;
  controllerGeneration: string;
  maxEntries?: number;
  maxRecordBytes?: number;
};

/** Separate durable authority for controller-private protected fills. Its
 * receipts and command digests are secret-free; the value bytes never enter
 * SQLite. */
export class SqliteBrowserProtectedAuthJournal {
  readonly path: string;

  private constructor(
    private readonly journal: SqliteInteractionOperationJournal<BrowserProtectedAuthFillReceipt>,
  ) {
    this.path = journal.path;
  }

  static async open(
    options: SqliteBrowserProtectedAuthJournalOptions,
  ): Promise<SqliteBrowserProtectedAuthJournal> {
    const journal = await SqliteInteractionOperationJournal.open({
      path: options.path,
      resourceKind: "browser_session",
      resourceId: options.browserSessionId,
      controllerGeneration: options.controllerGeneration,
      resourceLabel: "browser",
      parseReceipt: (value) => BrowserProtectedAuthFillReceipt.parse(value),
      assertReceiptAuthority(receipt) {
        if (
          receipt.browserSessionId !== options.browserSessionId ||
          receipt.controllerGeneration !== options.controllerGeneration
        ) {
          throw new Error("protected-fill operation record is outside journal authority");
        }
      },
      recoverRecord: recoverBrowserProtectedAuthOperationJournalRecord,
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      ...(options.maxRecordBytes !== undefined ? { maxRecordBytes: options.maxRecordBytes } : {}),
    });
    return new SqliteBrowserProtectedAuthJournal(journal);
  }

  write(record: BrowserProtectedAuthOperationJournalRecord): void {
    this.journal.write(record);
  }

  loadAndRecover(settledAt?: string): BrowserProtectedAuthOperationJournalRecord[] {
    return this.journal.loadAndRecover(settledAt);
  }

  close(): void {
    this.journal.close();
  }
}
