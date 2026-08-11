import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  captureEncryptedBrowserProfile,
  restoreEncryptedBrowserProfile,
  type BrowserProfileManifest,
} from "../src";

const key = Buffer.alloc(32, 0x2a);
const aad = Buffer.from("browser-state:test-workspace:test-object", "utf8");

describe("encrypted browser profile artifacts", () => {
  test("round-trips a bounded profile without runtime locks or disposable caches", async () => {
    await withDirectory(async (directory) => {
      const profile = join(directory, "profile");
      const artifact = join(directory, "artifacts", "profile.ogbs");
      const restored = join(directory, "restored");
      await mkdir(join(profile, "Default", "IndexedDB"), { recursive: true });
      await mkdir(join(profile, "Default", "Cache"), { recursive: true });
      await Promise.all([
        writeFile(join(profile, "Local State"), "local-state"),
        writeFile(join(profile, "Default", "Cookies"), Buffer.from([0, 1, 2, 3, 255])),
        writeFile(join(profile, "Default", "IndexedDB", "state.db"), "durable-state"),
        writeFile(join(profile, "Default", "empty"), ""),
        writeFile(join(profile, "Default", "Cache", "discard-me"), "cache"),
        writeFile(join(profile, "SingletonLock"), "runtime-lock"),
      ]);

      const captured = await captureEncryptedBrowserProfile({
        profileDirectory: profile,
        artifactPath: artifact,
        dataKey: key,
        aad,
        manifest: manifest(),
      });
      expect(captured).toMatchObject({
        format: BROWSER_PROFILE_ARTIFACT_FORMAT,
        fileCount: 4,
        profileBytes: 29,
      });
      expect(captured.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(captured.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(captured.sizeBytes).toBe((await stat(artifact)).size);

      const result = await restoreEncryptedBrowserProfile({
        artifactPath: artifact,
        outputProfileDirectory: restored,
        dataKey: key,
        aad,
        expectedArtifactDigest: captured.artifactDigest,
        expectedContentDigest: captured.contentDigest,
        expectedSizeBytes: captured.sizeBytes,
      });
      expect(result).toEqual(captured);
      expect(await readFile(join(restored, "Local State"), "utf8")).toBe("local-state");
      expect([...(await readFile(join(restored, "Default", "Cookies")))]).toEqual([
        0, 1, 2, 3, 255,
      ]);
      expect(await readFile(join(restored, "Default", "IndexedDB", "state.db"), "utf8")).toBe(
        "durable-state",
      );
      expect(await exists(join(restored, "Default", "Cache"))).toBe(false);
      expect(await exists(join(restored, "SingletonLock"))).toBe(false);
    });
  });

  test("fails closed on authentication, digest, and extraction-bound failures", async () => {
    await withDirectory(async (directory) => {
      const profile = join(directory, "profile");
      const artifact = join(directory, "profile.ogbs");
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, "Cookies"), "state");
      const captured = await captureEncryptedBrowserProfile({
        profileDirectory: profile,
        artifactPath: artifact,
        dataKey: key,
        aad,
        manifest: manifest(),
      });

      const wrongAadOutput = join(directory, "wrong-aad");
      await expectRejected(
        restoreEncryptedBrowserProfile({
          artifactPath: artifact,
          outputProfileDirectory: wrongAadOutput,
          dataKey: key,
          aad: Buffer.from("wrong-authority"),
          expectedArtifactDigest: captured.artifactDigest,
          expectedContentDigest: captured.contentDigest,
          expectedSizeBytes: captured.sizeBytes,
        }),
        "authentication failed",
      );
      expect(await exists(wrongAadOutput)).toBe(false);

      const wrongDigestOutput = join(directory, "wrong-digest");
      await expectRejected(
        restoreEncryptedBrowserProfile({
          artifactPath: artifact,
          outputProfileDirectory: wrongDigestOutput,
          dataKey: key,
          aad,
          expectedArtifactDigest: "f".repeat(64),
          expectedContentDigest: captured.contentDigest,
          expectedSizeBytes: captured.sizeBytes,
        }),
        "artifact digest",
      );
      expect(await exists(wrongDigestOutput)).toBe(false);

      const boundedOutput = join(directory, "bounded");
      await expectRejected(
        restoreEncryptedBrowserProfile({
          artifactPath: artifact,
          outputProfileDirectory: boundedOutput,
          dataKey: key,
          aad,
          expectedArtifactDigest: captured.artifactDigest,
          expectedContentDigest: captured.contentDigest,
          expectedSizeBytes: captured.sizeBytes,
          limits: { maxProfileBytes: 1 },
        }),
        "extraction bounds",
      );
      expect(await exists(boundedOutput)).toBe(false);
    });
  });

  test("rejects source symlinks and authenticated traversal archives", async () => {
    await withDirectory(async (directory) => {
      const profile = join(directory, "profile");
      await mkdir(profile, { recursive: true });
      await writeFile(join(directory, "outside"), "secret");
      await symlink(join(directory, "outside"), join(profile, "linked-state"));
      await expectRejected(
        captureEncryptedBrowserProfile({
          profileDirectory: profile,
          artifactPath: join(directory, "symlink.ogbs"),
          dataKey: key,
          aad,
          manifest: manifest(),
        }),
        "unsupported symbolic link",
      );

      const artifact = join(directory, "traversal.ogbs");
      const authority = await writeAuthenticatedArchive(artifact, [
        archiveEntry("manifest.json", Buffer.from(JSON.stringify(manifest()))),
        archiveEntry("profile/../../escaped", Buffer.from("owned")),
      ]);
      const output = join(directory, "traversal-output");
      await expectRejected(
        restoreEncryptedBrowserProfile({
          artifactPath: artifact,
          outputProfileDirectory: output,
          dataKey: key,
          aad,
          ...authority,
        }),
        "archive path is invalid",
      );
      expect(await exists(output)).toBe(false);
      expect(await exists(join(directory, "escaped"))).toBe(false);
    });
  });
});

function manifest(): BrowserProfileManifest {
  return {
    schemaVersion: 1,
    browserSessionId: "11111111-1111-4111-8111-111111111111",
    controllerGeneration: "controller-1",
    capturedAt: "2026-08-09T12:00:00.000Z",
    engine: "chromium",
    engineVersion: "140.0.0.0",
    driverId: "opengeni.cdp.v1",
    driverSchemaVersion: 1,
    profileCrypto: "chromium_basic",
    platform: "linux",
    architecture: "x64",
    tabs: [
      { url: "https://one.test/", selected: true },
      { url: "https://two.test/", selected: false },
    ],
  };
}

function archiveEntry(path: string, contents: Buffer): Buffer {
  const pathBytes = Buffer.from(path);
  const header = Buffer.alloc(13 + pathBytes.byteLength);
  header[0] = 1;
  header.writeUInt32BE(pathBytes.byteLength, 1);
  header.writeBigUInt64BE(BigInt(contents.byteLength), 5);
  pathBytes.copy(header, 13);
  return Buffer.concat([header, contents]);
}

async function writeAuthenticatedArchive(
  path: string,
  entries: Buffer[],
): Promise<{
  expectedArtifactDigest: string;
  expectedContentDigest: string;
  expectedSizeBytes: number;
}> {
  const profileMagic = Buffer.from([0x4f, 0x47, 0x42, 0x50, 1, 0, 0, 0]);
  const compressed = gzipSync(Buffer.concat([profileMagic, ...entries, Buffer.from([0])]));
  const artifactMagic = Buffer.from([0x4f, 0x47, 0x42, 0x53, 1, 0, 0, 0]);
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const artifact = Buffer.concat([
    artifactMagic,
    iv,
    cipher.update(compressed),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  await writeFile(path, artifact);
  return {
    expectedArtifactDigest: createHash("sha256").update(artifact).digest("hex"),
    expectedContentDigest: createHash("sha256").update(compressed).digest("hex"),
    expectedSizeBytes: artifact.byteLength,
  };
}

async function withDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-state-artifact-");
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function expectRejected(promise: Promise<unknown>, fragment: string): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(fragment);
}
