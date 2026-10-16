import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkingCopyAdoptionError,
  adoptWorkingCopy,
  adoptionPaths,
  copyWorkingCopy,
  readActiveAdoption,
  readAdoptionRecord,
  reconcileAdoption,
  settleActiveAdoption,
  workingCopyManifest,
  type AdoptionPaths,
  type WorkingCopyAdoptionPhase,
} from "../src/working-copy-adoption";

const BROWSER = "11111111-1111-4111-8111-000000000777";
const GENERATION = "controller-777";
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
    failAfter?: WorkingCopyAdoptionPhase;
    receipts?: string[];
  } = {},
) {
  return await adoptWorkingCopy(paths, {
    operationId: operation(sequence),
    browserSessionId: BROWSER,
    controllerGeneration: GENERATION,
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

describe("working copy manifest", () => {
  test("is exact, excludes derived entries and never follows links", async () => {
    const { paths } = await fixture();
    const first = await workingCopyManifest(paths.live);
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
        controllerGeneration: GENERATION,
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
      expect(await settleActiveAdoption(paths)).toBeNull();
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
    expect(await settleActiveAdoption(paths)).toBeNull();
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
    const settled = await reconcileAdoption(paths, record);
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
    const blocking = await settleActiveAdoption(paths);
    expect(blocking).toMatchObject({ phase: "collision", failureCode: "live_directory_changed" });
    expect(await lstat(join(paths.sessionsDirectory, record.stagingName))).toBeTruthy();
    expect(await lstat(join(paths.sessionsDirectory, "elsewhere"))).toBeTruthy();
    await expect(adopt(paths, 9, digest)).rejects.toBeInstanceOf(WorkingCopyAdoptionError);
    expect(await readActiveAdoption(paths)).toBe(operation(8));
  });
});
