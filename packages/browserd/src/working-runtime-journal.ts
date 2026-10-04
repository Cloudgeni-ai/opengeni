import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { InteractionOperationState } from "@opengeni/contracts";
import { InteractionControllerError } from "@opengeni/interaction";
import { SqliteInteractionOperationJournal } from "./operation-journal";
import type { OwnedManagedBrowserProcess } from "./runner";

export type BrowserWorkingRuntimeAuthority = {
  tokenGeneration: number;
  /** Hash of the existing placement/instance-bound controller admin token. */
  placementDigest: string;
  controlDigest: string;
  viewDigest: string;
};

type ProfileDirectoryIdentity = { device: number; inode: number };
export type BrowserWorkingRuntimeReceipt = {
  version: 1;
  browserSessionId: string;
  controllerGeneration: string;
  operationId: string;
  launchAttemptId: string;
  state: InteractionOperationState;
  intent: "launch" | "retire";
  authority: BrowserWorkingRuntimeAuthority;
  launchDigest: string;
  restoreAuthorityDigest: string | null;
  profile: ProfileDirectoryIdentity;
  process: OwnedManagedBrowserProcess | null;
  directoryLaunchAllowed: boolean;
};

type Options = {
  sessionDirectory: string;
  browserSessionId: string;
  controllerGeneration: string;
};

/** One internal adapter over the existing controller journal. It records
 * physical launch receipts, never page contents, raw state keys or credentials. */
export class SqliteBrowserWorkingRuntimeJournal {
  private constructor(
    private readonly journal: SqliteInteractionOperationJournal<BrowserWorkingRuntimeReceipt>,
  ) {}

  static async open(options: Options, readOnly = false) {
    await assertDirectory(options.sessionDirectory);
    const path = join(options.sessionDirectory, "working-runtime.sqlite");
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw unavailable();
    } catch (error) {
      if (readOnly || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const journal = await SqliteInteractionOperationJournal.open({
      path,
      resourceKind: "browser_session",
      resourceId: options.browserSessionId,
      controllerGeneration: options.controllerGeneration,
      resourceLabel: "browser",
      parseReceipt,
      assertReceiptAuthority(receipt) {
        if (
          receipt.browserSessionId !== options.browserSessionId ||
          receipt.controllerGeneration !== options.controllerGeneration
        )
          throw unavailable();
      },
      // Launches/actions with unsettled outcomes are never replayed.
      recoverRecord: (entry) => entry,
      maxEntries: 64,
      maxRecordBytes: 16_384,
      maxTotalReceiptBytes: 1024 * 1024,
      ...(readOnly ? { readOnly: true } : {}),
    });
    return new SqliteBrowserWorkingRuntimeJournal(journal);
  }

  latest(): BrowserWorkingRuntimeReceipt | null {
    return this.journal.readLatest()?.receipt ?? null;
  }

  begin(
    input: Omit<
      BrowserWorkingRuntimeReceipt,
      "version" | "operationId" | "state" | "launchAttemptId"
    >,
    previousOperationId?: string,
  ) {
    const recoveryDigest = previousOperationId
      ? createHash("sha256").update(`working-runtime-recovery:${previousOperationId}`).digest("hex")
      : null;
    const operationId = recoveryDigest
      ? `${recoveryDigest.slice(0, 8)}-${recoveryDigest.slice(8, 12)}-4${recoveryDigest.slice(13, 16)}-8${recoveryDigest.slice(17, 20)}-${recoveryDigest.slice(20, 32)}`
      : randomUUID();
    const receipt: BrowserWorkingRuntimeReceipt = {
      ...input,
      version: 1,
      operationId,
      launchAttemptId: randomUUID(),
      state: "prepared",
    };
    this.write(receipt);
    this.write({ ...receipt, state: "dispatched" });
    return receipt;
  }

  complete(receipt: BrowserWorkingRuntimeReceipt, process: OwnedManagedBrowserProcess | null) {
    const completed: BrowserWorkingRuntimeReceipt = { ...receipt, state: "completed", process };
    this.write(completed);
    return completed;
  }

  retire(receipt: BrowserWorkingRuntimeReceipt) {
    const retiring = this.begin({ ...receipt, intent: "retire", process: null });
    return { ...retiring, state: "dispatched" as const };
  }

  close() {
    this.journal.close();
  }

  private write(receipt: BrowserWorkingRuntimeReceipt) {
    this.journal.write({
      operationId: receipt.operationId,
      commandDigest: createHash("sha256")
        .update(
          JSON.stringify({
            launchAttemptId: receipt.launchAttemptId,
            intent: receipt.intent,
            authority: receipt.authority,
            launchDigest: receipt.launchDigest,
            restoreAuthorityDigest: receipt.restoreAuthorityDigest,
            profile: receipt.profile,
          }),
        )
        .digest("hex"),
      receipt,
    });
  }
}

export async function assertDirectory(path: string): Promise<ProfileDirectoryIdentity> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unavailable();
  return { device: metadata.dev, inode: metadata.ino };
}

export function assertWorkingRuntimeReceipt(
  receipt: BrowserWorkingRuntimeReceipt | null,
  authority: BrowserWorkingRuntimeAuthority,
  launchDigest: string,
  profile: ProfileDirectoryIdentity,
): asserts receipt is BrowserWorkingRuntimeReceipt & { process: OwnedManagedBrowserProcess } {
  if (
    !receipt ||
    receipt.intent !== "launch" ||
    receipt.state !== "completed" ||
    receipt.process === null ||
    receipt.launchDigest !== launchDigest ||
    JSON.stringify(receipt.authority) !== JSON.stringify(authority) ||
    receipt.profile.device !== profile.device ||
    receipt.profile.inode !== profile.inode
  ) {
    throw unavailable();
  }
}

export function unavailable() {
  return new BrowserWorkingRuntimeUnavailableError();
}

export class BrowserWorkingRuntimeUnavailableError extends InteractionControllerError {
  constructor() {
    super(
      "resource_unavailable",
      "Current browser is unavailable; its browser record and recovery state are preserved",
    );
  }
}

function parseReceipt(value: unknown): BrowserWorkingRuntimeReceipt {
  if (
    !record(value) ||
    value.version !== 1 ||
    !uuid(value.browserSessionId) ||
    !uuid(value.operationId) ||
    !uuid(value.launchAttemptId) ||
    typeof value.controllerGeneration !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.controllerGeneration) ||
    !["prepared", "dispatched", "completed", "failed", "outcome_unknown"].includes(
      String(value.state),
    ) ||
    !["launch", "retire"].includes(String(value.intent)) ||
    !record(value.authority) ||
    !Number.isSafeInteger(value.authority.tokenGeneration) ||
    Number(value.authority.tokenGeneration) < 1 ||
    !digest(value.authority.placementDigest) ||
    !digest(value.authority.controlDigest) ||
    !digest(value.authority.viewDigest) ||
    !digest(value.launchDigest) ||
    !(value.restoreAuthorityDigest === null || digest(value.restoreAuthorityDigest)) ||
    !record(value.profile) ||
    !Number.isSafeInteger(value.profile.device) ||
    !Number.isSafeInteger(value.profile.inode) ||
    typeof value.directoryLaunchAllowed !== "boolean"
  )
    throw unavailable();
  if (value.process !== null) {
    if (
      !record(value.process) ||
      !Number.isSafeInteger(value.process.pid) ||
      Number(value.process.pid) < 2 ||
      Number(value.process.pid) > 2_147_483_647 ||
      typeof value.process.birth !== "string" ||
      !value.process.birth ||
      value.process.birth.length > 128 ||
      typeof value.process.executablePath !== "string" ||
      !value.process.executablePath.startsWith("/") ||
      value.process.executablePath.length > 4096 ||
      typeof value.process.profileDirectory !== "string" ||
      !value.process.profileDirectory.startsWith("/") ||
      value.process.profileDirectory.length > 4096 ||
      typeof value.process.cdpEndpoint !== "string" ||
      value.process.cdpEndpoint.length > 1024
    ) {
      throw unavailable();
    }
  }
  // All fields are validated and the journal fixes the state/size/authority envelope.
  return value as BrowserWorkingRuntimeReceipt;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function digest(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function uuid(value: unknown) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}
