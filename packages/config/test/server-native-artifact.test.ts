import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";

const original = await import("node:fs/promises");
const originalOpen = original.open;
type Entry = {
  bytes: Buffer;
  uid: number;
  mode: number;
  directory?: boolean;
  changed?: boolean;
  nonregular?: boolean;
};
let entries: Map<string, Entry>;
let opens: Array<{ path: string; flags: unknown }>;
let closes: number;
const prefix = "/opt/opengeni";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const target = process.arch === "arm64" ? "linux-arm64" : "linux-amd64";
let elf: Buffer;

mock.module("node:fs/promises", () => ({
  ...original,
  open: async (path: string, flags: unknown) => {
    opens.push({ path, flags });
    const entry = entries.get(path);
    if (!entry) throw new Error("fixed file unavailable");
    let observed = 0;
    return {
      stat: async () => ({
        uid: entry.uid,
        mode: entry.mode,
        size: entry.bytes.byteLength,
        dev: 1,
        ino: 20,
        mtimeMs: entry.changed && observed++ > 0 ? 1 : 0,
        ctimeMs: 0,
        isFile: () => !entry.directory && !entry.nonregular,
        isDirectory: () => !!entry.directory,
      }),
      read: async (buffer: Buffer, offset = 0, length = buffer.byteLength, position = 0) => ({
        bytesRead: entry.bytes.copy(buffer, offset, position, position + length),
      }),
      close: async () => {
        closes++;
      },
    };
  },
}));

const {
  readImmutableServerNativeArtifact,
  readImmutableServerNativeArtifactBytes,
  isImmutableServerNativeArtifact,
} = await import("../src/server-native-artifact");
afterAll(() => {
  mock.module("node:fs/promises", () => ({ ...original, open: originalOpen }));
});

function refreshManifest(extra: Record<string, unknown> = {}) {
  entries.get(`${prefix}/native-command-artifact.json`)!.bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      sourceSha: "a".repeat(40),
      sourceFileSha256: sha(entries.get(`${prefix}/native-command-supervisor.c`)!.bytes),
      artifactSha256: sha(entries.get(`${prefix}/native-command-supervisor.elf`)!.bytes),
      byteSize: entries.get(`${prefix}/native-command-supervisor.elf`)!.bytes.byteLength,
      target,
      ...extra,
    }),
  );
}

beforeEach(() => {
  opens = [];
  closes = 0;
  elf = Buffer.alloc(128);
  Buffer.from([0x7f, 69, 76, 70, 2, 1, 1]).copy(elf);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(target === "linux-amd64" ? 62 : 183, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(1n, 24);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  elf.writeBigUInt64LE(128n, 96);
  elf.writeBigUInt64LE(128n, 104);
  entries = new Map<string, Entry>([
    [prefix, { bytes: Buffer.alloc(0), uid: 0, mode: 0o40555, directory: true }],
    [`${prefix}/source-sha`, { bytes: Buffer.from("a".repeat(40)), uid: 0, mode: 0o100444 }],
    [
      `${prefix}/native-command-supervisor.c`,
      { bytes: Buffer.from("reviewed source\n"), uid: 0, mode: 0o100444 },
    ],
    [`${prefix}/native-command-supervisor.elf`, { bytes: elf, uid: 0, mode: 0o100444 }],
    [`${prefix}/native-command-artifact.json`, { bytes: Buffer.alloc(0), uid: 0, mode: 0o100444 }],
  ]);
  refreshManifest();
});

test("measures fixed immutable source and static ELF without host execution", async () => {
  const artifact = await readImmutableServerNativeArtifact();
  expect(artifact).toBeDefined();
  expect(isImmutableServerNativeArtifact(artifact)).toBe(true);
  expect(artifact?.sourceSha).toBe("a".repeat(40));
  expect(artifact?.artifactSha256).toBe(sha(elf));
  expect(artifact?.byteSize).toBe(128);
  expect(artifact?.target).toBe(target);
  expect(opens.every((item) => (Number(item.flags) & constants.O_NOFOLLOW) !== 0)).toBe(true);
  expect(opens.map((item) => item.path)).toEqual([
    prefix,
    `${prefix}/source-sha`,
    `${prefix}/native-command-artifact.json`,
    `${prefix}/native-command-supervisor.c`,
    `${prefix}/native-command-supervisor.elf`,
  ]);
  expect(closes).toBe(5);
});

test("copied structural metadata cannot acquire authority and byte access is defensive", async () => {
  const artifact = (await readImmutableServerNativeArtifact())!;
  const copied = JSON.parse(JSON.stringify(artifact));
  expect(isImmutableServerNativeArtifact(copied)).toBe(false);
  expect(() => readImmutableServerNativeArtifactBytes(copied)).toThrow("immutable reader");
  expect(Object.isFrozen(artifact)).toBe(true);
  const first = readImmutableServerNativeArtifactBytes(artifact);
  first.fill(0);
  entries.get(`${prefix}/native-command-supervisor.elf`)!.bytes.fill(0);
  expect(sha(Buffer.from(readImmutableServerNativeArtifactBytes(artifact)))).toBe(
    artifact.artifactSha256,
  );
});

test("source, ELF or manifest hash substitution fails instead of trusting matching labels", async () => {
  for (const path of [
    `${prefix}/native-command-supervisor.c`,
    `${prefix}/native-command-supervisor.elf`,
  ]) {
    const saved = entries.get(path)!.bytes;
    entries.get(path)!.bytes = Buffer.from(saved);
    entries.get(path)!.bytes[0] = saved[0]! ^ 1;
    expect(await readImmutableServerNativeArtifact()).toBeUndefined();
    entries.get(path)!.bytes = saved;
  }
  refreshManifest({ sourceSha: "b".repeat(40) });
  expect(await readImmutableServerNativeArtifact()).toBeUndefined();
  refreshManifest({ arbitraryCallerMetadata: true });
  expect(await readImmutableServerNativeArtifact()).toBeUndefined();
});

test("dynamic ELF, wrong architecture and malformed program headers fail even with matching SHA", async () => {
  for (const change of [
    (bytes: Buffer) => bytes.writeUInt32LE(3, 64),
    (bytes: Buffer) => bytes.writeUInt32LE(2, 64),
    (bytes: Buffer) => bytes.writeUInt16LE(target === "linux-amd64" ? 183 : 62, 18),
    (bytes: Buffer) => bytes.writeBigUInt64LE(1000n, 32),
  ]) {
    const copy = Buffer.from(elf);
    change(copy);
    entries.get(`${prefix}/native-command-supervisor.elf`)!.bytes = copy;
    refreshManifest();
    expect(await readImmutableServerNativeArtifact()).toBeUndefined();
  }
});

test("writable, foreign-owned, changed or nonregular fixed assets fail closed", async () => {
  for (const path of [
    prefix,
    `${prefix}/source-sha`,
    `${prefix}/native-command-artifact.json`,
    `${prefix}/native-command-supervisor.c`,
    `${prefix}/native-command-supervisor.elf`,
  ]) {
    const entry = entries.get(path)!;
    for (const change of [
      { uid: 1000 },
      { mode: entry.mode | 0o200 },
      { changed: true },
      path === prefix ? { directory: false } : { nonregular: true },
    ]) {
      entries.set(path, { ...entry, ...change });
      expect(await readImmutableServerNativeArtifact()).toBeUndefined();
      entries.set(path, entry);
    }
  }
});

test("missing, oversized or malformed files never fall back to environment or caller metadata", async () => {
  const previous = process.env.OPENGENI_SOURCE_SHA;
  process.env.OPENGENI_SOURCE_SHA = "a".repeat(40);
  try {
    entries.delete(`${prefix}/source-sha`);
    expect(await readImmutableServerNativeArtifact()).toBeUndefined();
    entries.set(`${prefix}/source-sha`, {
      bytes: Buffer.from("development"),
      uid: 0,
      mode: 0o100444,
    });
    expect(await readImmutableServerNativeArtifact()).toBeUndefined();
    entries.set(`${prefix}/source-sha`, {
      bytes: Buffer.from("a".repeat(40)),
      uid: 0,
      mode: 0o100444,
    });
    entries.get(`${prefix}/native-command-artifact.json`)!.bytes = Buffer.alloc(2049, 65);
    expect(await readImmutableServerNativeArtifact()).toBeUndefined();
    refreshManifest();
    entries.get(`${prefix}/native-command-supervisor.elf`)!.bytes = Buffer.alloc(262145);
    expect(await readImmutableServerNativeArtifact()).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.OPENGENI_SOURCE_SHA;
    else process.env.OPENGENI_SOURCE_SHA = previous;
  }
});
