import { renameSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@opengeni/contracts/values";

/**
 * What a browser session has done to the person's own Chrome (attached
 * through the Opengeni Browser extension) that outlives one controller
 * runtime of the session: the tabs it opened, the tab it was using, the
 * debugger attachments it holds and the empty tabs it closed.
 *
 * A runtime records it as it goes. When the runtime goes away (an end, an
 * idle release, a controller shutdown or restart) it closes the empty tabs it
 * opened, releases Chrome's debugger and marks the record settled. The
 * session's next runtime continues in the tab it was using instead of
 * opening another one. A record left unsettled by a controller that crashed
 * is settled by the next controller on the same machine.
 *
 * Tab ids are Chrome's own and only mean the same tab within one extension
 * connection generation. The bridge refuses requests for another generation,
 * so nothing recorded here is ever applied to a reconnected browser.
 */
export type AttachedTabLedger = {
  version: 1;
  browserSessionId: string;
  deviceId: string;
  connectionGeneration: string;
  authorityFile?: string;
  /** False while a controller runtime holds the session, and after a cleanup
   * that did not finish. */
  settled: boolean;
  /** The controller process that last held the session. */
  ownerPid: number;
  /** Tabs the session opened that may still be open. */
  createdTabs: string[];
  /** Tabs with a debugger attachment the session holds or failed to release. */
  attachedTabs: string[];
  selectedTab: string | null;
  /** Empty tabs the session closed itself, most recent last. */
  closedBlankTabs: string[];
  /** Milliseconds since the epoch. */
  updatedAt: number;
};

const LEDGER_NAME = "attached-tabs.json";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TAB_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_LEDGER_BYTES = 65_536;
export const MAX_LEDGER_TABS = 256;
export const MAX_CLOSED_BLANK_TABS = 16;

export function attachedTabLedgerPath(sessionDirectory: string): string {
  return join(sessionDirectory, LEDGER_NAME);
}

/** Synchronous and atomic, so a record is never half written and a tab is
 * recorded before anything else can happen to the controller. */
export function writeAttachedTabLedger(sessionDirectory: string, ledger: AttachedTabLedger): void {
  const path = attachedTabLedgerPath(sessionDirectory);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
  renameSync(temporary, path);
}

export function removeAttachedTabLedger(sessionDirectory: string): void {
  rmSync(attachedTabLedgerPath(sessionDirectory), { force: true });
}

/** The session's record, or null when there is none or it cannot be trusted. */
export function readAttachedTabLedger(sessionDirectory: string): AttachedTabLedger | null {
  let text: string;
  try {
    text = readFileSync(attachedTabLedgerPath(sessionDirectory), "utf8");
  } catch {
    return null;
  }
  if (text.length > MAX_LEDGER_BYTES) return null;
  return parseAttachedTabLedger(text);
}

/** Every readable record under the supervisor root. A record that cannot be
 * read or does not match its directory is skipped, never acted on. */
export async function readAttachedTabLedgers(rootDirectory: string): Promise<AttachedTabLedger[]> {
  const sessionsDirectory = join(rootDirectory, "sessions");
  let names: string[];
  try {
    names = await readdir(sessionsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ledgers: AttachedTabLedger[] = [];
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    const ledger = readAttachedTabLedger(join(sessionsDirectory, name));
    if (ledger?.browserSessionId === name) ledgers.push(ledger);
  }
  return ledgers;
}

export function parseAttachedTabLedger(text: string): AttachedTabLedger | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<Record<keyof AttachedTabLedger, unknown>>;
  const createdTabs = tabIds(record.createdTabs);
  const attachedTabs = tabIds(record.attachedTabs);
  const closedBlankTabs = tabIds(record.closedBlankTabs);
  if (
    record.version !== 1 ||
    typeof record.browserSessionId !== "string" ||
    !SESSION_ID.test(record.browserSessionId) ||
    typeof record.deviceId !== "string" ||
    !SESSION_ID.test(record.deviceId) ||
    typeof record.connectionGeneration !== "string" ||
    record.connectionGeneration.length === 0 ||
    record.connectionGeneration.length > 512 ||
    (record.authorityFile !== undefined &&
      (typeof record.authorityFile !== "string" || record.authorityFile.length > 4_096)) ||
    typeof record.settled !== "boolean" ||
    typeof record.ownerPid !== "number" ||
    !Number.isSafeInteger(record.ownerPid) ||
    record.ownerPid <= 0 ||
    !createdTabs ||
    !attachedTabs ||
    !closedBlankTabs ||
    (record.selectedTab !== null &&
      (typeof record.selectedTab !== "string" || !TAB_ID.test(record.selectedTab))) ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt)
  )
    return null;
  return {
    version: 1,
    browserSessionId: record.browserSessionId,
    deviceId: record.deviceId,
    connectionGeneration: record.connectionGeneration,
    ...(record.authorityFile !== undefined ? { authorityFile: record.authorityFile } : {}),
    settled: record.settled,
    ownerPid: record.ownerPid,
    createdTabs,
    attachedTabs,
    selectedTab: record.selectedTab,
    closedBlankTabs,
    updatedAt: record.updatedAt,
  };
}

function tabIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_LEDGER_TABS) return null;
  if (!value.every((id) => typeof id === "string" && TAB_ID.test(id))) return null;
  return [...new Set(value as string[])];
}

/** Whether a process with this id is running. A pid reused by another
 * process reads as running; that only defers a cleanup, never wrongs one. */
export function processRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The tabs one runtime of a session tracks, as the driver reports them. */
export type OwnedTabsState = {
  created: string[];
  selected: string | null;
  closedBlank: string[];
};

/**
 * Keeps one runtime's ledger current. It starts from the session's earlier
 * record when that belongs to the same browser connection, so the runtime
 * inherits the tabs and attachments the earlier one left, and is unsettled
 * from then on until the runtime has cleaned up after itself.
 */
export class AttachedTabLedgerRecorder {
  private ledger: AttachedTabLedger;

  private constructor(
    private readonly sessionDirectory: string,
    ledger: AttachedTabLedger,
    /** What an earlier runtime of the session left, when it is usable here. */
    readonly previous: OwnedTabsState | null,
    readonly inheritedAttachments: readonly string[],
    private readonly now: () => number,
    private readonly earlier: AttachedTabLedger | null,
  ) {
    this.ledger = ledger;
  }

  static open(
    sessionDirectory: string,
    identity: {
      browserSessionId: string;
      deviceId: string;
      connectionGeneration: string;
      authorityFile?: string;
    },
    now: () => number = Date.now,
  ): AttachedTabLedgerRecorder {
    const earlier = readAttachedTabLedger(sessionDirectory);
    const sameConnection =
      earlier !== null &&
      earlier.browserSessionId === identity.browserSessionId &&
      earlier.deviceId === identity.deviceId &&
      earlier.connectionGeneration === identity.connectionGeneration;
    const ledger: AttachedTabLedger = {
      version: 1,
      browserSessionId: identity.browserSessionId,
      deviceId: identity.deviceId,
      connectionGeneration: identity.connectionGeneration,
      ...(identity.authorityFile ? { authorityFile: identity.authorityFile } : {}),
      settled: false,
      ownerPid: process.pid,
      createdTabs: sameConnection ? earlier.createdTabs : [],
      attachedTabs: sameConnection ? earlier.attachedTabs : [],
      selectedTab: sameConnection ? earlier.selectedTab : null,
      closedBlankTabs: sameConnection ? earlier.closedBlankTabs : [],
      updatedAt: now(),
    };
    const recorder = new AttachedTabLedgerRecorder(
      sessionDirectory,
      ledger,
      sameConnection
        ? {
            created: earlier.createdTabs,
            selected: earlier.selectedTab,
            closedBlank: earlier.closedBlankTabs,
          }
        : null,
      sameConnection ? earlier.attachedTabs : [],
      now,
      earlier,
    );
    recorder.persist();
    return recorder;
  }

  tabsChanged(tabs: OwnedTabsState): void {
    this.ledger = {
      ...this.ledger,
      createdTabs: tabs.created.slice(-MAX_LEDGER_TABS),
      selectedTab: tabs.selected,
      closedBlankTabs: tabs.closedBlank.slice(-MAX_CLOSED_BLANK_TABS),
    };
    this.persist();
  }

  attachmentsChanged(tabs: readonly string[]): void {
    this.ledger = { ...this.ledger, attachedTabs: [...tabs].slice(-MAX_LEDGER_TABS) };
    this.persist();
  }

  /** The runtime is gone. Settled only when every empty tab it opened is
   * closed and every debugger attachment it held is released. */
  closed(tabsSettled: boolean, leftoverAttachments: readonly string[]): void {
    this.ledger = {
      ...this.ledger,
      attachedTabs: [...leftoverAttachments].slice(-MAX_LEDGER_TABS),
      settled: tabsSettled && leftoverAttachments.length === 0,
    };
    this.persist();
  }

  /** The runtime never reached the browser: leave the record as it was. */
  abandon(): void {
    try {
      if (this.earlier) writeAttachedTabLedger(this.sessionDirectory, this.earlier);
      else removeAttachedTabLedger(this.sessionDirectory);
    } catch {
      // The record stays unsettled; the next sweep settles it.
    }
  }

  private persist(): void {
    this.ledger.updatedAt = this.now();
    try {
      writeAttachedTabLedger(this.sessionDirectory, this.ledger);
    } catch (error) {
      // The browser keeps working; only cleanup after a crash is lost.
      console.warn("browserd.attached_tab_ledger_write_failed", {
        browserSessionId: this.ledger.browserSessionId,
        error: errorMessage(error),
      });
    }
  }
}
