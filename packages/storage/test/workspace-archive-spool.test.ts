import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { ObjectStorage } from "../src/index";
import {
  downloadWorkspaceArchiveSpool,
  uploadWorkspaceArchiveSpool,
  WorkspaceArchiveStorageError,
} from "../src/workspace-archive-spool";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const payload = new Uint8Array(2 * 1024 * 1024 + 17).fill(37);
const expected = { bytes: payload.length, sha256: hash(payload) };
const key = "archives/deterministic-key.tar";

function fixture(bytes = payload) {
  const ranges: Parameters<NonNullable<ObjectStorage["getObjectRange"]>>[0][] = [];
  const storage = {
    headObject: async () => ({
      ContentLength: bytes.length,
      VersionToken: "v1",
      Metadata: { sha256: expected.sha256 },
    }),
    getObjectRange: async (input: Parameters<NonNullable<ObjectStorage["getObjectRange"]>>[0]) => {
      ranges.push(input);
      return { bytes: bytes.slice(input.start, input.endInclusive + 1), versionToken: "v1" };
    },
    putObjectStreamIfAbsent: async () => false,
    getObjectBytes: async () => {
      throw new Error("whole-body read forbidden");
    },
    putObject: async () => {
      throw new Error("whole-body write forbidden");
    },
  } as unknown as ObjectStorage;
  return { storage, ranges };
}

const source = () => ({
  path: "unused",
  byteSize: expected.bytes,
  sha256: expected.sha256,
  async *open() {
    yield payload.subarray(0, 100);
    yield payload.subarray(100);
  },
  async dispose() {
    throw new Error("upload must not dispose caller spool");
  },
});

describe("workspace archive spool storage", () => {
  test("downloads exact bounded pinned ranges to a private reopenable disposable file", async () => {
    const { storage, ranges } = fixture();
    const spool = await downloadWorkspaceArchiveSpool(storage, key, expected);
    const path = spool.path;
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect(spool.byteSize).toBe(expected.bytes);
      expect(spool.sha256).toBe(expected.sha256);
      for (let attempt = 0; attempt < 2; attempt++) {
        const digest = createHash("sha256");
        for await (const chunk of spool.open()) {
          expect(chunk.length).toBeLessThanOrEqual(1024 * 1024);
          digest.update(chunk);
        }
        expect(digest.digest("hex")).toBe(expected.sha256);
      }
      expect(ranges.length).toBe(3);
      expect(
        ranges.every((range) => range.key === key && range.expectedVersionToken === "v1"),
      ).toBe(true);
      expect(ranges.map((range) => [range.start, range.endInclusive])).toEqual([
        [0, 1048575],
        [1048576, 2097151],
        [2097152, 2097168],
      ]);
    } finally {
      await spool.dispose();
    }
    await spool.dispose();
    expect(await stat(dirname(path)).catch(() => null)).toBeNull();
    await expect(
      (async () => {
        for await (const _ of spool.open()) {
        }
      })(),
    ).rejects.toThrow("disposed");
  });

  test("streams new uploads at the supplied key without taking spool ownership", async () => {
    const { storage, ranges } = fixture();
    storage.putObjectStreamIfAbsent = async (input) => {
      expect(input.key).toBe(key);
      expect(input.byteSize).toBe(expected.bytes);
      expect(input.sha256).toBe(expected.sha256);
      expect(input.contentType).toBe("application/x-tar");
      const digest = createHash("sha256");
      for await (const chunk of input.chunks) digest.update(chunk);
      expect(digest.digest("hex")).toBe(expected.sha256);
      return true;
    };
    await uploadWorkspaceArchiveSpool(storage, key, source());
    expect(ranges.length).toBe(0);
  });

  test("verifies existing bytes, not forged SHA metadata", async () => {
    const { storage, ranges } = fixture();
    await uploadWorkspaceArchiveSpool(storage, key, source());
    expect(ranges.length).toBe(3);
    const corrupt = fixture(new Uint8Array(payload.length));
    await expect(uploadWorkspaceArchiveSpool(corrupt.storage, key, source())).rejects.toThrow(
      "digest",
    );
  });

  test("rejects a same-length disk spool alteration before fresh upload", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const { storage } = fixture(original);
    const spool = await downloadWorkspaceArchiveSpool(storage, key, {
      bytes: original.length,
      sha256: hash(original),
    });
    try {
      await writeFile(spool.path, new Uint8Array([3, 2, 1]));
      storage.putObjectStreamIfAbsent = async ({ chunks }) => {
        for await (const _ of chunks) {
        }
        return true;
      };
      await expect(uploadWorkspaceArchiveSpool(storage, key, spool)).rejects.toMatchObject({
        code: "archive_hash_mismatch",
        retryable: false,
      });
    } finally {
      await spool.dispose();
    }
  });

  for (const consumption of ["none", "partial", "swallowed-mismatch", "short", "long"] as const) {
    test(`rejects fresh upload with ${consumption} stream consumption`, async () => {
      const { storage } = fixture();
      const spool = source();
      if (["swallowed-mismatch", "short", "long"].includes(consumption)) {
        spool.open = async function* () {
          yield new Uint8Array(
            consumption === "short"
              ? 1
              : consumption === "long"
                ? payload.length + 1
                : payload.length,
          );
        };
      }
      storage.putObjectStreamIfAbsent = async ({ chunks }) => {
        if (consumption === "none") return true;
        if (consumption === "partial") {
          for await (const _ of chunks) {
            break;
          }
          return true;
        }
        try {
          for await (const _ of chunks) {
          }
        } catch {
          /* Simulate a provider swallowing producer failure. */
        }
        return true;
      };
      await expect(uploadWorkspaceArchiveSpool(storage, key, spool)).rejects.toBeInstanceOf(
        WorkspaceArchiveStorageError,
      );
    });
  }

  test("snapshots expected download metadata before provider callbacks can mutate it", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const corrupt = new Uint8Array([3, 2, 1]);
    const mutable = { bytes: original.length, sha256: hash(original) };
    const { storage } = fixture(corrupt);
    const head = storage.headObject!;
    storage.headObject = async (objectKey) => {
      mutable.sha256 = hash(corrupt);
      return head(objectKey);
    };
    const result = await downloadWorkspaceArchiveSpool(storage, key, mutable).catch(
      (error: unknown) => error,
    );
    if (result && typeof result === "object" && "dispose" in result)
      await (result as { dispose(): Promise<void> }).dispose();
    expect(result).toMatchObject({ code: "archive_hash_mismatch", retryable: false });
  });

  test("snapshots expected download metadata before its first await", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const mutable = { bytes: original.length, sha256: hash(original) };
    const { storage } = fixture(original);
    const pending = downloadWorkspaceArchiveSpool(storage, key, mutable);
    mutable.bytes = 0;
    mutable.sha256 = hash(new Uint8Array());
    const spool = await pending;
    try {
      expect(spool.byteSize).toBe(original.length);
      expect(spool.sha256).toBe(hash(original));
    } finally {
      await spool.dispose();
    }
  });

  for (const failure of [
    "missing",
    "size",
    "truncated",
    "oversized",
    "drift",
    "final-drift",
    "final-missing",
    "final-size",
    "range-missing",
    "provider",
    "digest",
    "token",
  ] as const) {
    test(`rejects ${failure} and cleans partial spools`, async () => {
      const before = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("opengeni-workspace-archive-"),
      );
      const { storage } = fixture();
      const head = storage.headObject!;
      const range = storage.getObjectRange!;
      let heads = 0;
      storage.headObject = async () => {
        const value = await head(key);
        if (failure === "missing") return null;
        if (failure === "size") return { ...value, ContentLength: 1 };
        if (failure === "token") return { ...value, VersionToken: "" };
        if (failure === "final-drift" && ++heads > 1) return { ...value, VersionToken: "v2" };
        if (failure === "final-missing" && ++heads > 1) return null;
        if (failure === "final-size" && ++heads > 1) return { ...value, ContentLength: 1 };
        return value;
      };
      storage.getObjectRange = async (input) => {
        if (failure === "range-missing") return null;
        if (failure === "provider") throw new Error("provider failure");
        const value = (await range(input))!;
        if (failure === "truncated") value.bytes = value.bytes.slice(1);
        if (failure === "oversized") value.bytes = new Uint8Array(value.bytes.length + 1);
        if (failure === "drift") value.versionToken = "v2";
        if (failure === "digest") value.bytes[0] ^= 1;
        return value;
      };
      const error = await downloadWorkspaceArchiveSpool(storage, key, expected).catch(
        (failureCause: unknown) => failureCause,
      );
      expect(error).toBeInstanceOf(WorkspaceArchiveStorageError);
      const missing = ["missing", "range-missing", "final-missing"].includes(failure);
      const retryable = ["drift", "final-drift", "provider"].includes(failure);
      expect(error).toMatchObject({
        code: missing
          ? "archive_base64_invalid"
          : retryable || failure === "token"
            ? "archive_hydration_failed"
            : "archive_hash_mismatch",
        retryable,
      });
      expect(
        (await readdir(tmpdir())).filter((name) => name.startsWith("opengeni-workspace-archive-")),
      ).toEqual(before);
    });
  }

  test("supports empty objects and validates their digest", async () => {
    const { storage, ranges } = fixture(new Uint8Array());
    const spool = await downloadWorkspaceArchiveSpool(storage, key, {
      bytes: 0,
      sha256: hash(new Uint8Array()),
    });
    await spool.dispose();
    expect(ranges).toEqual([]);
    await expect(
      downloadWorkspaceArchiveSpool(storage, key, { bytes: 0, sha256: expected.sha256 }),
    ).rejects.toThrow("digest");
  });

  test("fails explicitly without bounded primitives, before uploading", async () => {
    for (const primitive of ["headObject", "getObjectRange", "putObjectStreamIfAbsent"] as const) {
      const { storage } = fixture();
      delete storage[primitive];
      await expect(uploadWorkspaceArchiveSpool(storage, key, source())).rejects.toThrow(
        "unsupported",
      );
      await expect(uploadWorkspaceArchiveSpool(storage, key, source())).rejects.toMatchObject({
        code: "archive_hydration_failed",
        retryable: false,
      });
      if (primitive !== "putObjectStreamIfAbsent") {
        await expect(downloadWorkspaceArchiveSpool(storage, key, expected)).rejects.toThrow(
          "unsupported",
        );
        await expect(downloadWorkspaceArchiveSpool(storage, key, expected)).rejects.toMatchObject({
          code: "archive_hydration_failed",
          retryable: false,
        });
      }
    }
  });

  test("invalid expected integrity metadata is nonretryable configuration failure", async () => {
    for (const invalid of [
      { bytes: -1, sha256: expected.sha256 },
      { bytes: 1, sha256: "invalid" },
    ]) {
      const { storage } = fixture();
      await expect(downloadWorkspaceArchiveSpool(storage, key, invalid)).rejects.toMatchObject({
        code: "archive_hydration_failed",
        retryable: false,
      });
    }
  });
});
