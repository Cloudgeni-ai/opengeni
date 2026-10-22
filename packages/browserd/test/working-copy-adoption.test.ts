import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ADOPTION_IN_FLIGHT,
  WorkingCopyAdoptionError,
  adoptWorkingCopy,
  adoptionPaths,
  copyWorkingCopy,
  readActiveAdoption,
  readAdoptionRecord,
  observeActiveAdoption,
  revertWorkingCopyAdoption,
  settleActiveAdoption,
  workingCopyManifest,
  writeAdoptionRecord,
  type AdoptionBoundary,
  type AdoptionAuthority,
  type AdoptionPaths,
} from "../src/working-copy-adoption";
import {
  SqliteBrowserWorkingRuntimeJournal,
  assertDirectory,
} from "../src/working-runtime-journal";

const BROWSER = "11111111-1111-4111-8111-000000000777";
const GENERATION = "controller-777";
/** The authority that approved an adoption, and a stale one: the same
 * controller generation after its token authority moved on. */
const AUTHORITY: AdoptionAuthority = {
  controllerGeneration: GENERATION,
  authorityDigest: "a".repeat(64),
};
const STALE: AdoptionAuthority = {
  controllerGeneration: GENERATION,
  authorityDigest: "b".repeat(64),
};
const STALE_GENERATION: AdoptionAuthority = {
  controllerGeneration: "controller-778",
  authorityDigest: "a".repeat(64),
};
const operation = (sequence: number) =>
  `22222222-2222-4222-8222-${sequence.toString().padStart(12, "0")}`;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A restored working directory: a profile with nested files, a symlink that
 * points outside the tree, controller journals with derived -shm indexes and a
 * per-launch launcher directory. */
async function fixture(): Promise<{ root: string; paths: AdoptionPaths; outside: string }> {
  const root = await mkdtemp("/tmp/og-adopt-");
  roots.push(root);
  const paths = adoptionPaths(join(root, "state"), BROWSER);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "outside the working copy");
  await mkdir(join(paths.live, "profile", "Default", "Local Storage"), { recursive: true });
  await writeFile(join(paths.live, "profile", "Default", "Cookies"), "cookie-bytes");
  await writeFile(join(paths.live, "profile", "Default", "Local Storage", "leveldb"), "ls");
  await writeFile(join(paths.live, "profile", "Local State"), '{"profile":{}}');
  await symlink(join(outside), join(paths.live, "profile", "SingletonSocket"));
  await writeFile(join(paths.live, "working-runtime.sqlite"), "journal");
  await writeFile(join(paths.live, "working-runtime.sqlite-shm"), "derived-1");
  await mkdir(join(paths.live, "chrome-launch"));
  await writeFile(join(paths.live, "chrome-launch", "launcher.sh"), "#!/bin/sh");
  return { root, paths, outside };
}

async function identity(path: string) {
  const metadata = await lstat(path);
  return { device: metadata.dev, inode: metadata.ino };
}

async function adopt(
  paths: AdoptionPaths,
  sequence: number,
  digest: string,
  options: {
    failAfter?: AdoptionBoundary;
    receipts?: string[];
    authority?: AdoptionAuthority;
  } = {},
) {
  return await adoptWorkingCopy(paths, {
    operationId: operation(sequence),
    browserSessionId: BROWSER,
    authority: options.authority ?? AUTHORITY,
    manifestDigest: digest,
    appendReceipt: async (staging) => {
      options.receipts?.push(staging);
      await writeFile(join(staging, "adopt-receipt"), operation(sequence));
    },
    afterPhase: async (phase) => {
      if (phase === options.failAfter) throw new Error(`synthetic crash after ${phase}`);
    },
  });
}

async function revert(
  paths: AdoptionPaths,
  sequence: number,
  authority: AdoptionAuthority = AUTHORITY,
  failAfter?: AdoptionBoundary,
) {
  return await revertWorkingCopyAdoption(paths, {
    operationId: operation(sequence),
    authority,
    afterPhase: async (boundary) => {
      if (boundary === failAfter) throw new Error(`synthetic crash after ${boundary}`);
    },
  });
}

const recordFile = (paths: AdoptionPaths, sequence: number) =>
  join(paths.recordsDirectory, `${operation(sequence)}.json`);

describe("working copy manifest", () => {
  test("is exact, excludes derived entries and never follows links", async () => {
    const { paths } = await fixture();
    const first = await workingCopyManifest(paths.live);
    expect(first.excluded).toEqual(["chrome-launch", "working-runtime.sqlite-shm"]);
    await writeFile(join(paths.live, "working-runtime.sqlite-shm"), "derived-2");
    await writeFile(join(paths.live, "chrome-launch", "other.sh"), "#!/bin/sh");
    expect((await workingCopyManifest(paths.live)).digest).toBe(first.digest);
    // The symlink target's contents are not part of the copy.
    expect(first.bytes).toBe(
      "cookie-bytes".length + "ls".length + '{"profile":{}}'.length + "journal".length,
    );
    await writeFile(join(paths.live, "profile", "Default", "Cookies"), "cookie-bytez");
    expect((await workingCopyManifest(paths.live)).digest).not.toBe(first.digest);
  });

  test("excludes only the controller's own indexes and launcher, never user entries", async () => {
    const { root, paths } = await fixture();
    // User data whose names merely look like derived entries.
    await mkdir(join(paths.live, "downloads", "files"), { recursive: true });
    await writeFile(join(paths.live, "downloads", "files", "report-shm"), "user report");
    await mkdir(join(paths.live, "profile", "notes-shm"));
    await writeFile(join(paths.live, "profile", "notes-shm", "note.txt"), "user note");
    await mkdir(join(paths.live, "profile", "chrome-launch"));
    await writeFile(join(paths.live, "profile", "chrome-launch", "kept"), "nested, not ours");
    await writeFile(join(paths.live, "profile", "Cookies-shm"), "browser-owned index");
    // A link at an excluded path is not the controller's index: it is kept.
    await symlink("elsewhere", join(paths.live, "operations.sqlite-shm"));
    const before = await workingCopyManifest(paths.live);
    expect(before.excluded).toEqual(["chrome-launch", "working-runtime.sqlite-shm"]);
    await writeFile(join(paths.live, "downloads", "files", "report-shm"), "user report v2");
    expect((await workingCopyManifest(paths.live)).digest).not.toBe(before.digest);
    await writeFile(join(paths.live, "downloads", "files", "report-shm"), "user report");
    await writeFile(join(paths.live, "profile", "notes-shm", "note.txt"), "user note v2");
    expect((await workingCopyManifest(paths.live)).digest).not.toBe(before.digest);
    await writeFile(join(paths.live, "profile", "notes-shm", "note.txt"), "user note");
    const copy = join(root, "copy");
    expect((await copyWorkingCopy(paths.live, copy)).digest).toBe(before.digest);
    expect(await readFile(join(copy, "downloads", "files", "report-shm"), "utf8")).toBe(
      "user report",
    );
    expect(await readFile(join(copy, "profile", "notes-shm", "note.txt"), "utf8")).toBe(
      "user note",
    );
    expect(await readFile(join(copy, "profile", "chrome-launch", "kept"), "utf8")).toBe(
      "nested, not ours",
    );
    expect(await readFile(join(copy, "profile", "Cookies-shm"), "utf8")).toBe(
      "browser-owned index",
    );
    expect((await lstat(join(copy, "operations.sqlite-shm"))).isSymbolicLink()).toBe(true);
    // Only the controller's own entries are left out of the copy.
    await expect(lstat(join(copy, "working-runtime.sqlite-shm"))).rejects.toThrow();
    await expect(lstat(join(copy, "chrome-launch"))).rejects.toThrow();
  });

  test("refuses special files", async () => {
    const { paths } = await fixture();
    execFileSync("mkfifo", [join(paths.live, "profile", "pipe")]);
    await expect(workingCopyManifest(paths.live)).rejects.toMatchObject({
      reason: "unsupported_entry",
    });
  });

  test("a copy reproduces the digest with links kept as links", async () => {
    const { root, paths, outside } = await fixture();
    const read = await workingCopyManifest(paths.live);
    const copied = await copyWorkingCopy(paths.live, join(root, "copy"));
    expect(copied.digest).toBe(read.digest);
    expect((await workingCopyManifest(join(root, "copy"))).digest).toBe(read.digest);
    const link = await lstat(join(root, "copy", "profile", "SingletonSocket"));
    expect(link.isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside the working copy");
    await expect(copyWorkingCopy(paths.live, join(root, "copy"))).rejects.toThrow();
  });
});

describe("working copy adoption", () => {
  test("adopts the approved bytes, preserves the original and records phases", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const originalProfile = await identity(join(paths.live, "profile"));
    const { digest } = await workingCopyManifest(paths.live);
    const record = await adopt(paths, 1, digest);
    expect(record.phase).toBe("adopted");
    expect(await readActiveAdoption(paths)).toBeNull();
    const preserved = join(paths.sessionsDirectory, record.preservedName);
    expect(await identity(preserved)).toEqual(original);
    expect(await identity(join(preserved, "profile"))).toEqual(originalProfile);
    expect((await workingCopyManifest(preserved)).digest).toBe(digest);
    const live = await identity(join(paths.live, "profile"));
    expect(live).toEqual(record.staging!.profile);
    expect(live).not.toEqual(originalProfile);
    expect(await readFile(join(paths.live, "adopt-receipt"), "utf8")).toBe(operation(1));
    // A retry with the same operation changes nothing.
    expect((await adopt(paths, 1, digest)).phase).toBe("adopted");
    expect(await identity(join(paths.live, "profile"))).toEqual(live);
  });

  test("bytes that changed after approval are never adopted", async () => {
    const { paths } = await fixture();
    const before = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    await writeFile(join(paths.live, "profile", "Default", "Cookies"), "changed");
    await expect(adopt(paths, 2, digest)).rejects.toMatchObject({ reason: "digest_mismatch" });
    expect(await identity(paths.live)).toEqual(before);
    const record = await readAdoptionRecord(paths, operation(2));
    expect(record).toMatchObject({ phase: "failed", failureCode: "digest_mismatch" });
    // The partial staging copy is kept for inspection, never deleted here.
    expect(await lstat(join(paths.sessionsDirectory, record!.stagingName))).toBeTruthy();
    expect(await readActiveAdoption(paths)).toBeNull();
  });

  test("a second operation cannot start while one is unresolved, and one id cannot change its request", async () => {
    const { paths } = await fixture();
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 3, digest, { failAfter: "copied" })).rejects.toThrow(
      "synthetic crash",
    );
    await expect(
      adoptWorkingCopy(paths, {
        operationId: operation(3),
        browserSessionId: BROWSER,
        authority: AUTHORITY,
        manifestDigest: "f".repeat(64),
        appendReceipt: async () => {},
      }),
    ).rejects.toMatchObject({ reason: "operation_conflict" });
  });

  test.each(["intent", "copied"] as const)(
    "a crash after %s, before any receipt, leaves the original live and the copy kept",
    async (phase) => {
      const { paths } = await fixture();
      const before = await identity(paths.live);
      const { digest } = await workingCopyManifest(paths.live);
      await expect(adopt(paths, 4, digest, { failAfter: phase })).rejects.toThrow(
        "synthetic crash",
      );
      // The claim blocks ordinary use until reconciled; reconciliation proves
      // the original is still live and records the interruption.
      expect(await readActiveAdoption(paths)).toBe(operation(4));
      expect(await settleActiveAdoption(paths, AUTHORITY)).toBeNull();
      const record = await readAdoptionRecord(paths, operation(4));
      expect(record).toMatchObject({ phase: "interrupted", failureCode: "adoption_interrupted" });
      expect(await identity(paths.live)).toEqual(before);
      if (phase === "copied")
        expect(await lstat(join(paths.sessionsDirectory, record!.stagingName))).toBeTruthy();
      // A new operation may adopt afterwards.
      expect((await adopt(paths, 5, digest)).phase).toBe("adopted");
    },
  );

  test("a crash after the receipt is completed forward by reconciliation", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 6, digest, { failAfter: "receipt" })).rejects.toThrow(
      "synthetic crash",
    );
    expect(await identity(paths.live)).toEqual(original);
    expect(await settleActiveAdoption(paths, AUTHORITY)).toBeNull();
    const record = await readAdoptionRecord(paths, operation(6));
    expect(record?.phase).toBe("adopted");
    expect(await identity(paths.live)).toEqual(record!.staging!.session);
    expect(await identity(join(paths.sessionsDirectory, record!.preservedName))).toEqual(original);
  });

  test("a crash between the two renames is completed forward", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 7, digest, { failAfter: "receipt" })).rejects.toThrow(
      "synthetic crash",
    );
    const record = (await readAdoptionRecord(paths, operation(7)))!;
    // Simulate the process dying right after preserving the original, before
    // that step was journaled: the live path is empty.
    await rename(paths.live, join(paths.sessionsDirectory, record.preservedName));
    // Retrying the same adoption settles it.
    const settled = await adopt(paths, 7, digest);
    expect(settled.phase).toBe("adopted");
    expect(await identity(paths.live)).toEqual(record.staging!.session);
    expect(await identity(join(paths.sessionsDirectory, record.preservedName))).toEqual(original);
  });

  test("an unexpected live directory is a collision that keeps every copy and blocks", async () => {
    const { paths } = await fixture();
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 8, digest, { failAfter: "receipt" })).rejects.toThrow(
      "synthetic crash",
    );
    const record = (await readAdoptionRecord(paths, operation(8)))!;
    // Someone else replaced the live directory meanwhile.
    await rename(paths.live, join(paths.sessionsDirectory, "elsewhere"));
    await mkdir(join(paths.live, "profile"), { recursive: true });
    const blocking = await settleActiveAdoption(paths, AUTHORITY);
    expect(blocking).toMatchObject({ phase: "collision", failureCode: "live_directory_changed" });
    expect(await lstat(join(paths.sessionsDirectory, record.stagingName))).toBeTruthy();
    expect(await lstat(join(paths.sessionsDirectory, "elsewhere"))).toBeTruthy();
    await expect(adopt(paths, 9, digest)).rejects.toBeInstanceOf(WorkingCopyAdoptionError);
    expect(await readActiveAdoption(paths)).toBe(operation(8));
  });

  test("a restart never makes a staged copy live after its bytes changed", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 10, digest, { failAfter: "receipt" })).rejects.toThrow(
      "synthetic crash",
    );
    const record = (await readAdoptionRecord(paths, operation(10)))!;
    const staged = join(paths.sessionsDirectory, record.stagingName);
    await writeFile(join(staged, "profile", "Default", "Cookies"), "not the approved bytes");
    // Nothing had moved, so the adoption fails: the original stays live and
    // the changed copy is kept for inspection.
    expect(await settleActiveAdoption(paths, AUTHORITY)).toBeNull();
    expect(await readAdoptionRecord(paths, operation(10))).toMatchObject({
      phase: "failed",
      failureCode: "staged_copy_changed",
    });
    expect(await identity(paths.live)).toEqual(original);
    expect(await identity(staged)).toEqual(record.staging!.session);
    expect(await readActiveAdoption(paths)).toBeNull();
  });

  test("an original that changed after the receipt crash is never replaced by the stale copy", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 14, digest, { failAfter: "receipt" })).rejects.toThrow(
      "synthetic crash",
    );
    const record = (await readAdoptionRecord(paths, operation(14)))!;
    // The original keeps its directory identity but its bytes move on.
    await writeFile(join(paths.live, "profile", "Default", "Cookies"), "newer cookie bytes");
    const settled = await adopt(paths, 14, digest);
    expect(settled).toMatchObject({ phase: "failed", failureCode: "working_copy_changed" });
    expect(await identity(paths.live)).toEqual(original);
    expect(await readFile(join(paths.live, "profile", "Default", "Cookies"), "utf8")).toBe(
      "newer cookie bytes",
    );
    const staged = join(paths.sessionsDirectory, record.stagingName);
    expect(await identity(staged)).toEqual(record.staging!.session);
    expect(await readFile(join(staged, "profile", "Default", "Cookies"), "utf8")).toBe(
      "cookie-bytes",
    );
    await expect(lstat(join(paths.sessionsDirectory, record.preservedName))).rejects.toThrow();
    expect(await readActiveAdoption(paths)).toBeNull();
  });

  test.each([
    ["token authority", STALE],
    ["controller generation", STALE_GENERATION],
  ] as const)(
    "a changed %s changes nothing, and the approving authority can still finish",
    async (_label, stale) => {
      const { paths } = await fixture();
      const original = await identity(paths.live);
      const { digest } = await workingCopyManifest(paths.live);
      await expect(adopt(paths, 15, digest, { failAfter: "receipt" })).rejects.toThrow(
        "synthetic crash",
      );
      const record = (await readAdoptionRecord(paths, operation(15)))!;
      const recordBytes = await readFile(recordFile(paths, 15), "utf8");
      // Neither a launch's settlement nor a retry under the stale authority
      // carries it forward, and neither rewrites or poisons the record.
      expect(await settleActiveAdoption(paths, stale)).toEqual(record);
      await expect(adopt(paths, 15, digest, { authority: stale })).rejects.toMatchObject({
        reason: "authority_changed",
      });
      expect(await readFile(recordFile(paths, 15), "utf8")).toBe(recordBytes);
      expect(await identity(paths.live)).toEqual(original);
      expect(await readActiveAdoption(paths)).toBe(operation(15));
      // The authority that approved it finishes it.
      expect((await adopt(paths, 15, digest)).phase).toBe("adopted");
      expect(await identity(paths.live)).toEqual(record.staging!.session);
    },
  );

  test.each([
    ["before that step was journaled", "receipt"],
    ["after that step was journaled", "source_preserved"],
  ] as const)(
    "a stale authority after the original moved aside (%s) changes nothing and can revert",
    async (_label, phase) => {
      const { paths } = await fixture();
      const original = await identity(paths.live);
      const { digest } = await workingCopyManifest(paths.live);
      await expect(adopt(paths, 16, digest, { failAfter: "receipt" })).rejects.toThrow(
        "synthetic crash",
      );
      const record = (await readAdoptionRecord(paths, operation(16)))!;
      // The process died right after preserving the original.
      await rename(paths.live, join(paths.sessionsDirectory, record.preservedName));
      if (phase === "source_preserved") await writeAdoptionRecord(paths, { ...record, phase });
      const recordBytes = await readFile(recordFile(paths, 16), "utf8");
      await expect(adopt(paths, 16, digest, { authority: STALE })).rejects.toMatchObject({
        reason: "authority_changed",
      });
      expect(await settleActiveAdoption(paths, STALE)).toMatchObject({ phase });
      expect(await readFile(recordFile(paths, 16), "utf8")).toBe(recordBytes);
      // Nothing moved further: the original stays preserved, the copy staged.
      await expect(lstat(paths.live)).rejects.toThrow();
      expect(await identity(join(paths.sessionsDirectory, record.preservedName))).toEqual(original);
      expect(await identity(join(paths.sessionsDirectory, record.stagingName))).toEqual(
        record.staging!.session,
      );
      // The current authority's supported way out: revert puts the original
      // back and keeps the copy, and a later adoption may start fresh.
      expect(await revert(paths, 16, STALE)).toMatchObject({
        phase: "reverted",
        revertedBy: STALE,
      });
      expect(await identity(paths.live)).toEqual(original);
      expect(await identity(join(paths.sessionsDirectory, record.stagingName))).toEqual(
        record.staging!.session,
      );
      expect(await readActiveAdoption(paths)).toBeNull();
      expect((await adopt(paths, 116, digest, { authority: STALE })).phase).toBe("adopted");
    },
  );

  /** After a receipt crash, the original was moved aside by the first rename
   * (journaled or not), or both renames happened before the terminal record;
   * then the preserved original was changed in place or moved away. */
  const ORIGINAL_DISTURBANCES = [
    ["changed in place", "original_changed"],
    ["moved away", "original_missing"],
  ] as const;
  const BOUNDARIES = [
    "first rename, not journaled",
    "first rename, journaled",
    "second rename, before the terminal record",
  ] as const;
  test.each(
    BOUNDARIES.flatMap((boundary) =>
      ORIGINAL_DISTURBANCES.map(([disturbance, code]) => [boundary, disturbance, code] as const),
    ),
  )(
    "after the %s, an original %s is a collision that keeps both copies",
    async (boundary, disturbance, code) => {
      const { root, paths } = await fixture();
      const original = await identity(paths.live);
      const { digest } = await workingCopyManifest(paths.live);
      const sequence =
        30 + BOUNDARIES.indexOf(boundary) * 2 + (code === "original_changed" ? 0 : 1);
      if (boundary === "second rename, before the terminal record") {
        await expect(adopt(paths, sequence, digest, { failAfter: "copy_live" })).rejects.toThrow(
          "synthetic crash",
        );
      } else {
        await expect(adopt(paths, sequence, digest, { failAfter: "receipt" })).rejects.toThrow(
          "synthetic crash",
        );
        const record = (await readAdoptionRecord(paths, operation(sequence)))!;
        await rename(paths.live, join(paths.sessionsDirectory, record.preservedName));
        if (boundary === "first rename, journaled")
          await writeAdoptionRecord(paths, { ...record, phase: "source_preserved" });
      }
      const record = (await readAdoptionRecord(paths, operation(sequence)))!;
      const preserved = join(paths.sessionsDirectory, record.preservedName);
      const staged = join(paths.sessionsDirectory, record.stagingName);
      const elsewhere = join(root, "moved-original");
      if (code === "original_changed") {
        await writeFile(
          join(preserved, "profile", "Default", "Cookies"),
          "written after the receipt",
        );
      } else {
        await rename(preserved, elsewhere);
      }
      const settled = await adopt(paths, sequence, digest);
      expect(settled).toMatchObject({ phase: "collision", failureCode: code });
      // Both copies are kept exactly where they were; nothing is selected.
      const copyLive = boundary === "second rename, before the terminal record";
      expect(await identity(copyLive ? paths.live : staged)).toEqual(record.staging!.session);
      if (!copyLive) await expect(lstat(paths.live)).rejects.toThrow();
      expect(await identity(code === "original_changed" ? preserved : elsewhere)).toEqual(original);
      expect(await readActiveAdoption(paths)).toBe(operation(sequence));
      // Launches stay blocked, and another retry does not change the outcome.
      expect(await settleActiveAdoption(paths, AUTHORITY)).toMatchObject({ phase: "collision" });
      expect((await adopt(paths, sequence, digest)).phase).toBe("collision");
      if (code === "original_missing") {
        // A revert cannot put back what is not there; it changes nothing.
        await expect(revert(paths, sequence)).rejects.toMatchObject({
          reason: "revert_blocked",
        });
        expect(await readAdoptionRecord(paths, operation(sequence))).toMatchObject({
          phase: "collision",
        });
        await rename(elsewhere, preserved);
      }
      // Revert puts the original (as it now is) back and keeps the copy.
      expect((await revert(paths, sequence)).phase).toBe("reverted");
      expect(await identity(paths.live)).toEqual(original);
      expect(await identity(staged)).toEqual(record.staging!.session);
      if (code === "original_changed")
        expect(await readFile(join(paths.live, "profile", "Default", "Cookies"), "utf8")).toBe(
          "written after the receipt",
        );
      expect(await readActiveAdoption(paths)).toBeNull();
      expect(await settleActiveAdoption(paths, AUTHORITY)).toBeNull();
    },
  );

  test("a crash after the second rename, before the terminal record, is completed forward", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 40, digest, { failAfter: "copy_live" })).rejects.toThrow(
      "synthetic crash",
    );
    const record = (await readAdoptionRecord(paths, operation(40)))!;
    expect(record.phase).toBe("source_preserved");
    expect(await identity(paths.live)).toEqual(record.staging!.session);
    expect((await adopt(paths, 40, digest)).phase).toBe("adopted");
    expect(await identity(join(paths.sessionsDirectory, record.preservedName))).toEqual(original);
  });

  test.each(["reverting", "copy_set_aside"] as const)(
    "a revert that stopped after %s is finished by retrying it, never by an adoption retry",
    async (stop) => {
      const { paths } = await fixture();
      const original = await identity(paths.live);
      const { digest } = await workingCopyManifest(paths.live);
      await expect(adopt(paths, 41, digest, { failAfter: "copy_live" })).rejects.toThrow(
        "synthetic crash",
      );
      const record = (await readAdoptionRecord(paths, operation(41)))!;
      await expect(revert(paths, 41, AUTHORITY, stop)).rejects.toThrow("synthetic crash");
      expect((await readAdoptionRecord(paths, operation(41)))?.phase).toBe("reverting");
      await expect(adopt(paths, 41, digest)).rejects.toMatchObject({
        reason: "adoption_unresolved",
      });
      expect(await settleActiveAdoption(paths, AUTHORITY)).toMatchObject({ phase: "reverting" });
      expect((await revert(paths, 41)).phase).toBe("reverted");
      expect(await identity(paths.live)).toEqual(original);
      expect(await identity(join(paths.sessionsDirectory, record.stagingName))).toEqual(
        record.staging!.session,
      );
      expect((await revert(paths, 41)).phase).toBe("reverted");
    },
  );

  test("a revert refuses a finished adoption, an unknown operation and an unknown live directory", async () => {
    const { paths } = await fixture();
    const { digest } = await workingCopyManifest(paths.live);
    await expect(revert(paths, 42)).rejects.toMatchObject({ reason: "adoption_not_found" });
    expect((await adopt(paths, 42, digest)).phase).toBe("adopted");
    await expect(revert(paths, 42)).rejects.toMatchObject({ reason: "adoption_complete" });
    const second = await fixture();
    const secondDigest = (await workingCopyManifest(second.paths.live)).digest;
    await expect(adopt(second.paths, 43, secondDigest, { failAfter: "copy_live" })).rejects.toThrow(
      "synthetic crash",
    );
    const record = (await readAdoptionRecord(second.paths, operation(43)))!;
    // Someone put an unknown directory at the live path.
    await rename(second.paths.live, join(second.root, "copy-moved-by-hand"));
    await mkdir(join(second.paths.live, "profile"), { recursive: true });
    await expect(revert(second.paths, 43)).rejects.toMatchObject({ reason: "revert_blocked" });
    expect(await readAdoptionRecord(second.paths, operation(43))).toEqual(record);
  });

  test("observing an unsettled adoption changes nothing", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    await expect(adopt(paths, 17, digest, { failAfter: "receipt" })).rejects.toThrow(
      "synthetic crash",
    );
    const recorded = await readAdoptionRecord(paths, operation(17));
    for (let read = 0; read < 3; read += 1) {
      expect(await observeActiveAdoption(paths)).toEqual(recorded!);
    }
    expect(await readAdoptionRecord(paths, operation(17))).toEqual(recorded);
    expect(await identity(paths.live)).toEqual(original);
    expect(await readActiveAdoption(paths)).toBe(operation(17));
  });

  test("a running adoption cannot be settled or reconciled by another holder", async () => {
    const { paths } = await fixture();
    const { digest } = await workingCopyManifest(paths.live);
    let release!: () => void;
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const copied = new Promise<void>((resolve) => (reached = resolve));
    const running = adoptWorkingCopy(paths, {
      operationId: operation(11),
      browserSessionId: BROWSER,
      authority: AUTHORITY,
      manifestDigest: digest,
      appendReceipt: async (staging) => await writeFile(join(staging, "adopt-receipt"), "11"),
      afterPhase: async (phase) => {
        if (phase !== "copied") return;
        reached();
        await barrier;
      },
    });
    await copied;
    expect(await settleActiveAdoption(paths, AUTHORITY)).toBe(ADOPTION_IN_FLIGHT);
    expect(await observeActiveAdoption(paths)).toBe(ADOPTION_IN_FLIGHT);
    await expect(adopt(paths, 11, digest)).rejects.toMatchObject({
      reason: "adoption_in_progress",
    });
    await expect(adopt(paths, 12, digest)).rejects.toMatchObject({
      reason: "adoption_in_progress",
    });
    expect((await readAdoptionRecord(paths, operation(11)))?.phase).toBe("copied");
    release();
    expect((await running).phase).toBe("adopted");
    expect(await readAdoptionRecord(paths, operation(12))).toBeNull();
  });

  test("an original that changes while it is copied is never adopted", async () => {
    const { paths } = await fixture();
    const original = await identity(paths.live);
    const { digest } = await workingCopyManifest(paths.live);
    const realOpen = fs.open;
    let changedDuringCopy = false;
    // Once the copy writes its last file, change a file it already read.
    const hook = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const path = String(args[0]);
      if (
        !changedDuringCopy &&
        path.includes(".adopt-") &&
        path.endsWith("/working-runtime.sqlite")
      ) {
        changedDuringCopy = true;
        await writeFile(join(paths.live, "profile", "Default", "Cookies"), "newer bytes");
      }
      return await realOpen(...args);
    }) as typeof fs.open);
    try {
      await expect(adopt(paths, 13, digest)).rejects.toMatchObject({
        reason: "working_copy_changed",
      });
    } finally {
      hook.mockRestore();
    }
    expect(changedDuringCopy).toBe(true);
    expect(await readAdoptionRecord(paths, operation(13))).toMatchObject({
      phase: "failed",
      failureCode: "working_copy_changed",
    });
    expect(await identity(paths.live)).toEqual(original);
    expect(await readActiveAdoption(paths)).toBeNull();
  });
});

describe("copying through held directories", () => {
  test("swapping a directory for a link mid-walk never reads outside the tree", async () => {
    const { root, paths } = await fixture();
    const elsewhere = join(root, "elsewhere");
    await mkdir(join(elsewhere, "Default"), { recursive: true });
    await writeFile(join(elsewhere, "Default", "Cookies"), "outside-root-bytes");
    const profile = join(paths.live, "profile");
    const realReaddir = fs.readdir as unknown as (path: string) => Promise<string[]>;
    let swapped = false;
    // Right after the profile directory was opened and listed, replace its
    // path with a link to another tree.
    const hook = spyOn(fs, "readdir").mockImplementation((async (path: string) => {
      const names = await realReaddir(path);
      if (!swapped && names.includes("Local State")) {
        swapped = true;
        await rename(profile, join(root, "moved-profile"));
        await symlink(elsewhere, profile);
      }
      return names;
    }) as unknown as typeof fs.readdir);
    const copy = join(root, "copy");
    try {
      await expect(copyWorkingCopy(paths.live, copy)).rejects.toMatchObject({
        reason: "working_copy_changed",
      });
    } finally {
      hook.mockRestore();
    }
    expect(swapped).toBe(true);
    // Whatever was copied before the refusal came from the held directory.
    expect(await readFile(join(copy, "profile", "Default", "Cookies"), "utf8")).toBe(
      "cookie-bytes",
    );
    // grep exits 1 when no file matches.
    expect(spawnSync("grep", ["-rl", "outside-root-bytes", copy]).status).toBe(1);
  });
});

describe("re-settling an adopted copy", () => {
  test("works after the adopt receipt was evicted from the bounded journal", async () => {
    const root = await mkdtemp("/tmp/og-adopt-journal-");
    roots.push(root);
    const sessionDirectory = join(root, BROWSER);
    await mkdir(join(sessionDirectory, "profile"), { recursive: true });
    const journal = await SqliteBrowserWorkingRuntimeJournal.open({
      sessionDirectory,
      browserSessionId: BROWSER,
      controllerGeneration: GENERATION,
    });
    const profile = await assertDirectory(join(sessionDirectory, "profile"));
    const browserProcess = {
      pid: 2001,
      birth: "synthetic-birth",
      executablePath: "/synthetic/chrome",
      profileDirectory: join(sessionDirectory, "profile"),
      cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
    };
    try {
      const source = journal.complete(
        journal.begin({
          browserSessionId: BROWSER,
          controllerGeneration: GENERATION,
          intent: "launch",
          authority: {
            tokenGeneration: 1,
            placementDigest: "a".repeat(64),
            controlDigest: "b".repeat(64),
            viewDigest: "c".repeat(64),
          },
          launchDigest: "d".repeat(64),
          restoreAuthorityDigest: null,
          profile,
          process: null,
          directoryLaunchAllowed: true,
        }),
        browserProcess,
      );
      const adopted = journal.adopt({
        source,
        operationId: operation(20),
        manifestDigest: "e".repeat(64),
        sourceProfile: profile,
        profile,
      });
      let latest = adopted;
      for (let launch = 0; launch < 70; launch += 1)
        latest = journal.complete(
          journal.begin({ ...latest, intent: "launch", process: null }),
          browserProcess,
        );
      // The bounded journal has evicted the adopt receipt itself.
      const reader = new Database(join(sessionDirectory, "working-runtime.sqlite"), {
        readonly: true,
      });
      try {
        expect(
          reader
            .query(
              "SELECT COUNT(*) AS count FROM interaction_operation_journal WHERE operation_id = ?",
            )
            .get(operation(20)),
        ).toEqual({ count: 0 });
      } finally {
        reader.close();
      }
      const failed = journal.fail(
        journal.begin({ ...latest, intent: "launch", process: null }),
        "interrupted",
      );
      const resettled = journal.resettleAdoptedCopy(failed);
      expect(resettled).toMatchObject({
        intent: "adopt",
        state: "completed",
        profile,
        directoryLaunchAllowed: true,
        adoption: adopted.adoption,
      });
      expect(journal.latest()).toEqual(resettled);
    } finally {
      journal.close();
    }
  });
});
