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

/** Provenance of a working copy adopted from a verified copied directory.
 * Recorded on the adopt receipt and carried by every later launch receipt of
 * the same generation, so which bytes are running stays provable. */
export type BrowserWorkingCopyAdoption = {
  operationId: string;
  manifestDigest: string;
  /** The receipt the copied directory carried when it was adopted. */
  sourceReceiptOperationId: string;
  /** The profile identity that receipt recorded (the lost original). */
  recordedProfile: ProfileDirectoryIdentity;
  /** The copied profile directory that was read for adoption. */
  sourceProfile: ProfileDirectoryIdentity;
};

export type BrowserWorkingRuntimeReceipt = {
  version: 1;
  browserSessionId: string;
  controllerGeneration: string;
  operationId: string;
  launchAttemptId: string;
  state: InteractionOperationState;
  intent: "launch" | "suspend" | "retire" | "adopt";
  authority: BrowserWorkingRuntimeAuthority;
  launchDigest: string;
  restoreAuthorityDigest: string | null;
  profile: ProfileDirectoryIdentity;
  process: OwnedManagedBrowserProcess | null;
  directoryLaunchAllowed: boolean;
  /** Bounded error code recorded only when a launch is settled failed. */
  failureCode?: string;
  adoption?: BrowserWorkingCopyAdoption;
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
    const { failureCode: _failureCode, ...launch } = input;
    const recoveryDigest = previousOperationId
      ? createHash("sha256").update(`working-runtime-recovery:${previousOperationId}`).digest("hex")
      : null;
    const operationId = recoveryDigest
      ? `${recoveryDigest.slice(0, 8)}-${recoveryDigest.slice(8, 12)}-4${recoveryDigest.slice(13, 16)}-8${recoveryDigest.slice(17, 20)}-${recoveryDigest.slice(20, 32)}`
      : randomUUID();
    const receipt: BrowserWorkingRuntimeReceipt = {
      ...launch,
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

  /** Settle a launch whose cleanup proved it never completed: its driver was
   * closed, no owned process was recorded and any restored profile was removed.
   * A failed receipt is never re-adopted and never authorizes a directory launch. */
  fail(receipt: BrowserWorkingRuntimeReceipt, failureCode: string) {
    if (receipt.intent !== "launch") throw unavailable();
    const failed: BrowserWorkingRuntimeReceipt = {
      ...receipt,
      state: "failed",
      process: null,
      directoryLaunchAllowed: false,
      failureCode: boundedFailureCode(failureCode),
    };
    this.write(failed);
    return failed;
  }

  retire(receipt: BrowserWorkingRuntimeReceipt) {
    const retiring = this.begin({ ...receipt, intent: "retire", process: null });
    return { ...retiring, state: "dispatched" as const };
  }

  suspend(receipt: BrowserWorkingRuntimeReceipt) {
    if (
      receipt.intent !== "launch" ||
      receipt.state !== "completed" ||
      !receipt.process ||
      !receipt.directoryLaunchAllowed
    )
      throw unavailable();
    const suspending = this.begin({ ...receipt, intent: "suspend" });
    return { ...suspending, state: "dispatched" as const };
  }

  /** Append the receipt that binds an adopted copy: the copied directory's
   * latest receipt, re-bound to the staged profile's own identity. Idempotent
   * for the same adoption operation. */
  adopt(input: {
    source: BrowserWorkingRuntimeReceipt;
    operationId: string;
    manifestDigest: string;
    sourceProfile: ProfileDirectoryIdentity;
    profile: ProfileDirectoryIdentity;
  }): BrowserWorkingRuntimeReceipt {
    const latest = this.latest();
    if (latest?.intent === "adopt" && latest.adoption?.operationId === input.operationId) {
      if (
        latest.adoption.manifestDigest !== input.manifestDigest ||
        latest.profile.device !== input.profile.device ||
        latest.profile.inode !== input.profile.inode
      )
        throw unavailable("adoption_conflict");
      return latest;
    }
    const { source } = input;
    // A copy that was itself adopted earlier may be adopted again (its
    // directory was copied once more); the new adoption replaces the lineage.
    if (latest?.operationId !== source.operationId || !adoptableSourceReceipt(source))
      throw unavailable("receipt_not_adoptable");
    const { failureCode: _failureCode, ...base } = source;
    const receipt: BrowserWorkingRuntimeReceipt = {
      ...base,
      intent: "adopt",
      operationId: input.operationId,
      launchAttemptId: randomUUID(),
      state: "prepared",
      profile: input.profile,
      directoryLaunchAllowed: true,
      adoption: {
        operationId: input.operationId,
        manifestDigest: input.manifestDigest,
        sourceReceiptOperationId: source.operationId,
        recordedProfile: source.profile,
        sourceProfile: input.sourceProfile,
      },
    };
    this.write(receipt);
    this.write({ ...receipt, state: "dispatched" });
    const completed: BrowserWorkingRuntimeReceipt = { ...receipt, state: "completed" };
    this.write(completed);
    return completed;
  }

  /** After a launch from an adopted copy definitively failed (its driver
   * closed), make the adopted copy the latest receipt again so the copy stays
   * launchable instead of falling back to any older state. `base` is the
   * newest completed receipt of that copy: its adopt receipt or a later
   * completed launch from it. */
  readopt(base: BrowserWorkingRuntimeReceipt, failedLaunch: BrowserWorkingRuntimeReceipt) {
    if (!adoptedCopyBase(base, failedLaunch)) throw unavailable("receipt_not_adoptable");
    const readoptDigest = createHash("sha256")
      .update(`working-copy-readopt:${failedLaunch.operationId}`)
      .digest("hex");
    const { failureCode: _failureCode, ...adopted } = base;
    const receipt: BrowserWorkingRuntimeReceipt = {
      ...adopted,
      intent: "adopt",
      operationId: `${readoptDigest.slice(0, 8)}-${readoptDigest.slice(8, 12)}-4${readoptDigest.slice(13, 16)}-8${readoptDigest.slice(17, 20)}-${readoptDigest.slice(20, 32)}`,
      launchAttemptId: randomUUID(),
      state: "prepared",
    };
    this.write(receipt);
    this.write({ ...receipt, state: "dispatched" });
    const completed: BrowserWorkingRuntimeReceipt = { ...receipt, state: "completed" };
    this.write(completed);
    return completed;
  }

  /** After a controller restart, bring an adopted copy whose launch never
   * settled back to its adopt receipt: a launch from it that was interrupted
   * (no process recorded) is settled failed, a failed one is re-adopted, and
   * an interrupted re-adoption is completed. The caller must first prove no
   * process uses the profile. Each step is idempotent, so a crash between any
   * two writes is finished by the next recovery. The copy is never replaced
   * by an older checkpoint. */
  resettleAdoptedCopy(latest: BrowserWorkingRuntimeReceipt): BrowserWorkingRuntimeReceipt {
    if (!adoptedCopyNeedsResettle(latest)) throw unavailable("receipt_not_adoptable");
    if (latest.intent === "adopt") {
      if (latest.state === "prepared") this.write({ ...latest, state: "dispatched" });
      const completed: BrowserWorkingRuntimeReceipt = { ...latest, state: "completed" };
      this.write(completed);
      return completed;
    }
    // The newest completed receipt of the same adopted copy, not the adopt
    // receipt itself: the journal is bounded, and after many launches the
    // adopt receipt may have been evicted. Every launch from the copy that
    // completed, and every re-adoption, is an equally exact base.
    const base = this.journal.findLatest((receipt) => adoptedCopyBase(receipt, latest))?.receipt;
    if (!base) throw unavailable("receipt_not_adoptable");
    const failed = latest.state === "failed" ? latest : this.fail(latest, "launch_interrupted");
    return this.readopt(base, failed);
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

/** True only when a launch receipt proves no browser can be adopted from it:
 * it was settled failed, or (for receipts written before failed settlement
 * existed) it is a dispatched restore launch with no recorded process whose
 * exact restored profile directory no longer exists. Cleanup removes that
 * directory only after the launch's driver closed. */
export async function isAbandonedLaunchReceipt(
  receipt: BrowserWorkingRuntimeReceipt | null,
  profileDirectory: string,
): Promise<boolean> {
  if (!receipt || receipt.intent !== "launch" || receipt.process !== null) return false;
  // A launch from an adopted copy never abandons that copy: the copy is the
  // browser's chosen state, removed only by an explicit discard.
  if (receipt.adoption) return false;
  if (receipt.state === "failed") return true;
  if (receipt.state !== "dispatched" || receipt.restoreAuthorityDigest === null) return false;
  try {
    await lstat(profileDirectory);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** True when the latest receipt is a launch that never recorded completion:
 * it is still prepared or dispatched and no owned browser process was ever
 * recorded for it. Such a launch can't be adopted, and its retained profile
 * may or may not have been used by a browser before the controller lost it. */
export function isInterruptedLaunchReceipt(
  receipt: BrowserWorkingRuntimeReceipt | null,
): receipt is BrowserWorkingRuntimeReceipt {
  return (
    receipt !== null &&
    receipt.intent === "launch" &&
    receipt.process === null &&
    (receipt.state === "prepared" || receipt.state === "dispatched")
  );
}

/** True when the latest receipt belongs to an adopted copy whose launch (or
 * re-adoption after a failed launch) never settled: see
 * {@link SqliteBrowserWorkingRuntimeJournal.resettleAdoptedCopy}. */
export function adoptedCopyNeedsResettle(
  receipt: BrowserWorkingRuntimeReceipt | null,
): receipt is BrowserWorkingRuntimeReceipt & { adoption: BrowserWorkingCopyAdoption } {
  if (!receipt?.adoption) return false;
  if (receipt.intent === "launch")
    return receipt.state === "failed" || isInterruptedLaunchReceipt(receipt);
  return (
    receipt.intent === "adopt" &&
    (receipt.state === "prepared" || receipt.state === "dispatched") &&
    receipt.operationId !== receipt.adoption.operationId
  );
}

/** A completed receipt that exactly describes the same adopted copy as
 * `launch`: same adoption and the same profile directory, with a recorded
 * process and directory launch allowed. */
function adoptedCopyBase(
  receipt: BrowserWorkingRuntimeReceipt,
  launch: BrowserWorkingRuntimeReceipt,
): boolean {
  return (
    adoptableSourceReceipt(receipt) &&
    receipt.adoption !== undefined &&
    receipt.adoption.operationId === launch.adoption?.operationId &&
    receipt.adoption.manifestDigest === launch.adoption.manifestDigest &&
    receipt.profile.device === launch.profile.device &&
    receipt.profile.inode === launch.profile.inode
  );
}

export function boundedFailureCode(value: unknown): string {
  return typeof value === "string" && FAILURE_CODE.test(value) ? value : "internal";
}

const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

export function assertWorkingRuntimeReceipt(
  receipt: BrowserWorkingRuntimeReceipt | null,
  authority: BrowserWorkingRuntimeAuthority,
  launchDigest: string,
  profile: ProfileDirectoryIdentity,
): asserts receipt is BrowserWorkingRuntimeReceipt & { process: OwnedManagedBrowserProcess } {
  if (!receipt) throw unavailable("receipt_not_adoptable");
  if (
    (receipt.intent !== "launch" &&
      receipt.intent !== "adopt" &&
      !(receipt.intent === "suspend" && receipt.directoryLaunchAllowed)) ||
    (receipt.intent === "adopt" && (!receipt.directoryLaunchAllowed || !receipt.adoption)) ||
    receipt.state !== "completed" ||
    receipt.process === null
  )
    throw unavailable("receipt_not_adoptable");
  if (JSON.stringify(receipt.authority) !== JSON.stringify(authority))
    throw unavailable("authority_changed");
  if (receipt.launchDigest !== launchDigest) throw unavailable("launch_configuration_changed");
  if (receipt.profile.device !== profile.device || receipt.profile.inode !== profile.inode)
    throw unavailable("profile_identity_changed");
}

/** A receipt whose copied directory can be adopted: a completed launch, or a
 * suspension that kept directory launch, that recorded its browser process. */
export function adoptableSourceReceipt(receipt: BrowserWorkingRuntimeReceipt): boolean {
  return (
    (receipt.intent === "launch" ||
      receipt.intent === "adopt" ||
      (receipt.intent === "suspend" && receipt.directoryLaunchAllowed)) &&
    receipt.state === "completed" &&
    receipt.process !== null &&
    receipt.directoryLaunchAllowed
  );
}

/** Why a preserved working copy cannot be continued. Stable identifiers for
 * callers; the message carries the plain explanation and the next action. */
export type BrowserWorkingRuntimeUnavailableReason =
  | "receipt_not_adoptable"
  | "authority_changed"
  | "launch_configuration_changed"
  | "profile_identity_changed"
  | "process_state_unknown"
  | "working_copy_invalid"
  | "adoption_unresolved"
  | "adoption_conflict"
  | "working_directory_busy";

const UNAVAILABLE_EXPLANATIONS: Record<BrowserWorkingRuntimeUnavailableReason, string> = {
  receipt_not_adoptable:
    "its last launch has no completed record of a browser process, so its working copy cannot be continued",
  authority_changed:
    "the controller authority changed since its last launch, so its working copy cannot be continued here",
  launch_configuration_changed:
    "its launch configuration changed since its last launch, so its working copy cannot be continued",
  profile_identity_changed:
    "its working directory is not the directory it was launched in (it was moved, copied or restored). If this copy should be kept, inspect it with inspectBrowserSessionWorkingCopy and adopt it with adoptBrowserSessionWorkingCopy",
  process_state_unknown:
    "it cannot be proven that its last browser process has stopped, so its working copy is left untouched",
  working_copy_invalid: "its working directory is incomplete or is not a plain directory",
  adoption_unresolved:
    "a working copy adoption for it is unresolved; check it with getBrowserSessionWorkingCopyAdoption, then either retry that same adoption with the same operationId to settle it, or revert it with revertBrowserSessionWorkingCopyAdoption to put the browser's own directory back",
  adoption_conflict: "a different working copy adoption already used this operation",
  working_directory_busy:
    "another operation (a launch, end, adoption or revert) is using its working directory right now; retry once that finishes",
};

export function unavailable(reason?: BrowserWorkingRuntimeUnavailableReason) {
  return new BrowserWorkingRuntimeUnavailableError(reason);
}

export class BrowserWorkingRuntimeUnavailableError extends InteractionControllerError {
  constructor(readonly reason?: BrowserWorkingRuntimeUnavailableReason) {
    super(
      "resource_unavailable",
      reason
        ? `Current browser is unavailable: ${UNAVAILABLE_EXPLANATIONS[reason]}. Its browser record and recovery state are preserved`
        : "Current browser is unavailable; its browser record and recovery state are preserved",
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
    !["launch", "suspend", "retire", "adopt"].includes(String(value.intent)) ||
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
    typeof value.directoryLaunchAllowed !== "boolean" ||
    (value.failureCode !== undefined &&
      (value.state !== "failed" ||
        typeof value.failureCode !== "string" ||
        !FAILURE_CODE.test(value.failureCode))) ||
    (value.intent === "adopt" && value.adoption === undefined) ||
    (value.adoption !== undefined && !adoptionRecord(value.adoption))
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
function identity(value: unknown) {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.device) &&
    Number.isSafeInteger(value.inode)
  );
}
function adoptionRecord(value: unknown) {
  return (
    record(value) &&
    Object.keys(value).length === 5 &&
    uuid(value.operationId) &&
    digest(value.manifestDigest) &&
    uuid(value.sourceReceiptOperationId) &&
    identity(value.recordedProfile) &&
    identity(value.sourceProfile)
  );
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
