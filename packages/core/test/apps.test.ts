import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  appBuildManifestObjectKey,
  appBuildObjectKey,
  appBuildStagingObjectKey,
  appSourceObjectKey,
  appSourceStagingObjectKey,
  freezeAppBuildObjects,
  resolveWorkspaceAppOrigin,
  verifyAppBuildStagingObjects,
  type AppImmutableObjectReader,
  type AppImmutableObjectWriter,
} from "../src";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const buildId = "33333333-3333-4333-8333-333333333333";
const sourceRevisionId = "44444444-4444-4444-8444-444444444444";
const fileId = "55555555-5555-4555-8555-555555555555";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function memoryReader(objects: Map<string, { bytes: Uint8Array; type: string; version: string }>) {
  return {
    async headObject(key: string) {
      const object = objects.get(key);
      return object
        ? {
            ContentLength: object.bytes.byteLength,
            ContentType: object.type,
            VersionToken: object.version,
          }
        : null;
    },
    async getObjectRange({ key, start, endInclusive, expectedVersionToken }) {
      const object = objects.get(key);
      if (!object || object.version !== expectedVersionToken) return null;
      return {
        bytes: object.bytes.slice(start, endInclusive + 1),
        versionToken: object.version,
      };
    },
  } satisfies AppImmutableObjectReader;
}

describe("OpenGeni Apps core", () => {
  test("separates signed staging keys from frozen digest identities", () => {
    const sha = "a".repeat(64);
    expect(
      appSourceStagingObjectKey({ workspaceId, appId, sourceRevisionId, uploadId: fileId }),
    ).toContain("/staging/");
    expect(
      appSourceObjectKey({ workspaceId, appId, sourceRevisionId, contentSha256: sha }),
    ).toContain(`/frozen/${sha}.tar`);
    expect(appBuildStagingObjectKey({ workspaceId, appId, buildId, fileId })).toContain(
      "/staging/",
    );
    expect(
      appBuildObjectKey({ workspaceId, appId, buildId, fileId, contentSha256: sha }),
    ).toContain(`/frozen/${sha}/`);
    expect(
      appBuildManifestObjectKey({ workspaceId, appId, buildId, manifestSha256: sha }),
    ).toContain(`/frozen/${sha}/manifest.json`);
  });

  test("requires one dedicated HTTPS origin per stable App id", () => {
    expect(resolveWorkspaceAppOrigin("https://{appId}.apps.example.com", appId)).toBe(
      `https://${appId}.apps.example.com`,
    );
    expect(() =>
      resolveWorkspaceAppOrigin("https://preview-{appId}.apps.example.com", appId),
    ).toThrow();
    expect(() =>
      resolveWorkspaceAppOrigin("https://preview.{appId}.apps.example.com", appId),
    ).toThrow();
    expect(() => resolveWorkspaceAppOrigin("https://apps.example.com/{appId}", appId)).toThrow();
    expect(() => resolveWorkspaceAppOrigin("https://apps.example.com", appId)).toThrow();
    expect(() => resolveWorkspaceAppOrigin("http://{appId}.apps.example.com", appId)).toThrow();
  });

  test("hashes every staging byte through bounded version-fenced ranges", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><h1>OpenGeni App</h1>");
    const key = appBuildStagingObjectKey({ workspaceId, appId, buildId, fileId });
    const objects = new Map([
      [key, { bytes, type: "text/html; charset=utf-8", version: "etag-1" }],
    ]);
    const result = await verifyAppBuildStagingObjects({
      reader: memoryReader(objects),
      workspaceId,
      appId,
      buildId,
      fileIdsByPath: { "index.html": fileId },
      rangeBytes: 5,
      manifest: {
        version: "opengeni.app-build.v1",
        entryPath: "index.html",
        files: [
          {
            path: "index.html",
            contentType: "text/html",
            contentSha256: digest(bytes),
            sizeBytes: bytes.byteLength,
            executable: false,
          },
        ],
        totalBytes: bytes.byteLength,
      },
    });
    expect(result).toEqual({ ready: true, verifiedFiles: 1, verifiedBytes: bytes.byteLength });
  });

  test("fails closed for missing or corrupt staging objects", async () => {
    const bytes = new TextEncoder().encode("hello");
    const manifest = {
      version: "opengeni.app-build.v1" as const,
      entryPath: "index.html",
      files: [
        {
          path: "index.html",
          contentType: "text/html",
          contentSha256: digest(bytes),
          sizeBytes: bytes.byteLength,
          executable: false,
        },
      ],
      totalBytes: bytes.byteLength,
    };
    expect(
      await verifyAppBuildStagingObjects({
        reader: memoryReader(new Map()),
        workspaceId,
        appId,
        buildId,
        fileIdsByPath: { "index.html": fileId },
        manifest,
      }),
    ).toEqual({ ready: false, failure: { path: "index.html", code: "object_missing" } });

    const key = appBuildStagingObjectKey({ workspaceId, appId, buildId, fileId });
    const corrupt = new Map([
      [key, { bytes: new TextEncoder().encode("HELLO"), type: "text/html", version: "etag-1" }],
    ]);
    expect(
      await verifyAppBuildStagingObjects({
        reader: memoryReader(corrupt),
        workspaceId,
        appId,
        buildId,
        fileIdsByPath: { "index.html": fileId },
        manifest,
      }),
    ).toEqual({
      ready: false,
      failure: { path: "index.html", code: "object_sha256_mismatch" },
    });
  });

  test("freezes bytes to a distinct digest key immune to later staging PUT replay", async () => {
    const original = new TextEncoder().encode("export const value = 'verified';");
    const replacement = new TextEncoder().encode("export const value = 'changed!';");
    expect(replacement.byteLength).toBe(original.byteLength);
    const stagingKey = appBuildStagingObjectKey({ workspaceId, appId, buildId, fileId });
    const objects = new Map([
      [stagingKey, { bytes: original, type: "text/javascript", version: "staging-v1" }],
    ]);
    let frozenGeneration = 0;
    const reader = memoryReader(objects);
    const writer: AppImmutableObjectWriter = {
      async putObjectStreamIfAbsent({ key, contentType, chunks }) {
        if (objects.has(key)) return false;
        const parts: Uint8Array[] = [];
        for await (const chunk of chunks) parts.push(chunk.slice());
        const size = parts.reduce((total, part) => total + part.byteLength, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        frozenGeneration += 1;
        objects.set(key, { bytes, type: contentType, version: `frozen-v${frozenGeneration}` });
        return true;
      },
    };
    const manifest = {
      version: "opengeni.app-build.v1" as const,
      entryPath: "app.js",
      files: [
        {
          path: "app.js",
          contentType: "text/javascript",
          contentSha256: digest(original),
          sizeBytes: original.byteLength,
          executable: false,
        },
      ],
      totalBytes: original.byteLength,
    };
    const frozen = await freezeAppBuildObjects({
      reader,
      writer,
      workspaceId,
      appId,
      buildId,
      fileIdsByPath: { "app.js": fileId },
      manifest,
      rangeBytes: 7,
    });
    expect(frozen.ready).toBe(true);
    if (!frozen.ready) throw new Error("expected frozen build");
    const frozenKey = frozen.frozenFiles[0]!.key;

    // Replay of the original signed PUT changes only the untrusted staging key.
    objects.set(stagingKey, {
      bytes: replacement,
      type: "text/javascript",
      version: "staging-v2",
    });
    expect(new TextDecoder().decode(objects.get(frozenKey)!.bytes)).toBe(
      "export const value = 'verified';",
    );
    expect(frozenKey).not.toBe(stagingKey);
  });
});
