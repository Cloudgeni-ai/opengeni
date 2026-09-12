import { createHash } from "node:crypto";
import { posix } from "node:path";
import { expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import {
  assertSandboxArtifactFile,
  sandboxArtifactIdentity,
  sandboxArtifactSafeFilename,
  sandboxFileContentType,
} from "../src/sandbox-file-artifacts";

type RetainedFile = Parameters<typeof assertSandboxArtifactFile>[0];
type FileMetadata = Parameters<typeof assertSandboxArtifactFile>[1];

// Frozen mapper/identity/replay behavior from ad9dc2f43. Do not update this
// reference alongside the writer: mixed-version API replicas must agree in
// BOTH directions, including when either version wins first publication.
function baseContentType(filename: string): string {
  const extension = posix.extname(filename).toLowerCase();
  return (
    {
      ".csv": "text/csv",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".gz": "application/gzip",
      ".html": "text/html",
      ".htm": "text/html",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".json": "application/json",
      ".md": "text/markdown",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".tar": "application/x-tar",
      ".txt": "text/plain",
      ".webp": "image/webp",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".zip": "application/zip",
    }[extension] ?? "application/octet-stream"
  );
}

function baseIdentity(input: Parameters<typeof sandboxArtifactIdentity>[0]) {
  const digest = createHash("sha256")
    .update("opengeni-sandbox-file-artifact-v1\0")
    .update(input.workspaceId)
    .update("\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.path)
    .update("\0")
    .update(input.sha256)
    .digest("hex");
  const uuid = (startByte: number) => {
    const bytes = Buffer.from(digest, "hex").subarray(startByte, startByte + 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return { fileId: uuid(0), uploadId: uuid(16) };
}

function baseAssertFile(file: RetainedFile, expected: FileMetadata): void {
  if (
    !["pending_upload", "ready"].includes(file.status) ||
    file.filename !== expected.filename ||
    file.safeFilename !== expected.safeFilename ||
    file.contentType !== expected.contentType ||
    file.sizeBytes !== expected.sizeBytes ||
    file.sha256 !== expected.sha256 ||
    file.bucket !== expected.bucket ||
    file.objectKey !== expected.objectKey
  )
    throw new HTTPException(409, { message: "sandbox artifact identity is unavailable" });
}

const versions = {
  base: { contentType: baseContentType, identity: baseIdentity, assertFile: baseAssertFile },
  current: {
    contentType: sandboxFileContentType,
    identity: sandboxArtifactIdentity,
    assertFile: assertSandboxArtifactFile,
  },
};
const filenames = [
  "animation.gif",
  "picture.avif",
  "diagram.SVG",
  "image.png",
  "photo.jpg",
  "photo.jpeg",
  "image.webp",
  "report.pdf",
  "output.custom",
];
const replayCases = filenames.flatMap((filename) =>
  // Pending rows cover a concurrent publisher observing the first writer's
  // retained upload intent before that writer finishes object verification.
  (["pending_upload", "ready"] as const).map((status) => [filename, status] as const),
);

for (const [writerVersion, readerVersion] of [
  ["base", "current"],
  ["current", "base"],
] as const) {
  test.each(replayCases)(
    `${writerVersion} publication replays unchanged in ${readerVersion}: %s (%s)`,
    (filename, status) => {
      const writer = versions[writerVersion],
        reader = versions[readerVersion];
      const input = {
        workspaceId: "20000000-0000-4000-8000-000000000002",
        sessionId: "30000000-0000-4000-8000-000000000003",
        path: `reports/${filename}`,
        sha256: "a".repeat(64),
      };
      const identity = writer.identity(input);
      expect(reader.identity(input)).toEqual(identity);
      const metadata = {
        filename,
        safeFilename: sandboxArtifactSafeFilename(filename),
        contentType: writer.contentType(filename),
        sizeBytes: 10,
        sha256: input.sha256,
        bucket: "fixture",
        objectKey: `workspaces/${input.workspaceId}/files/${identity.fileId}/sandbox/${sandboxArtifactSafeFilename(filename)}`,
      };
      const file: RetainedFile = Object.freeze({
        ...metadata,
        id: identity.fileId,
        workspaceId: input.workspaceId,
        scope: "workspace",
        status,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
      const before = JSON.stringify(file);
      expect(() =>
        reader.assertFile(file, { ...metadata, contentType: reader.contentType(filename) }),
      ).not.toThrow();
      expect(JSON.stringify(file)).toBe(before);
      // Neither binary may repair an incompatible immutable revision in place.
      expect(() =>
        reader.assertFile(file, { ...metadata, contentType: "application/changed" }),
      ).toThrow();
      expect(JSON.stringify(file)).toBe(before);
      expect(reader.identity({ ...input, sha256: "b".repeat(64) }).fileId).not.toBe(file.id);
    },
  );
}
