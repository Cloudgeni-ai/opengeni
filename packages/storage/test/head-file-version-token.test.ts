import { afterEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { BlobClient } from "@azure/storage-blob";
import { getSettings } from "@opengeni/config";
import type { FileAsset } from "@opengeni/contracts";
import { File as GcsFile } from "@google-cloud/storage";
import { createObjectStorage } from "../src";

// Editable-artifact Office import compares headFile's VersionToken before and
// after its ranged reads and rejects a missing token as "the workspace file
// changed during import". Every backend must therefore report the same object
// version identity from headFile that headObject already reports.

const file: FileAsset = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  status: "ready",
  filename: "report.docx",
  safeFilename: "report.docx",
  contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 4,
  sha256: "a".repeat(64),
  bucket: "test-bucket",
  objectKey: "workspaces/w/files/f/original/report.docx",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

const spies: Mock<(...args: never[]) => unknown>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("headFile reports the object version token", () => {
  test("S3-compatible uses the ETag", async () => {
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": "4",
            "content-type": file.contentType,
            etag: '"etag-1"',
            "x-amz-meta-sha256": file.sha256!,
          },
        });
      },
    });
    try {
      const storage = createObjectStorage({
        ...getSettings({}),
        objectStorageBackend: "s3-compatible",
        objectStorageEndpoint: `http://127.0.0.1:${fake.port}`,
        objectStorageBucket: "test-bucket",
        objectStorageForcePathStyle: true,
        objectStorageAccessKeyId: "test",
        objectStorageSecretAccessKey: "test",
      })!;
      const head = await storage.headFile(file);
      expect(head.VersionToken).toBe('"etag-1"');
      expect((await storage.headObject!(file.objectKey))?.VersionToken).toBe(head.VersionToken);
    } finally {
      fake.stop(true);
    }
  });

  test("Azure Blob uses the etag", async () => {
    spies.push(
      spyOn(BlobClient.prototype, "getProperties").mockResolvedValue({
        contentLength: 4,
        contentType: file.contentType,
        metadata: { sha256: file.sha256! },
        etag: '"0x8DCAZURE"',
      } as never) as never,
    );
    const storage = createObjectStorage({
      ...getSettings({}),
      objectStorageBackend: "azure-blob",
      objectStorageBucket: "test-bucket",
      objectStorageAzureConnectionString: undefined,
      objectStorageAzureAccountName: "synthetic",
      objectStorageAzureAccountKey: Buffer.from("synthetic-key").toString("base64"),
    })!;
    const head = await storage.headFile(file);
    expect(head.VersionToken).toBe('"0x8DCAZURE"');
    expect(head.Metadata?.sha256).toBe(file.sha256!);
    expect((await storage.headObject!(file.objectKey))?.VersionToken).toBe(head.VersionToken);
  });

  test("GCS uses the generation", async () => {
    spies.push(
      spyOn(GcsFile.prototype, "getMetadata").mockResolvedValue([
        {
          size: "4",
          contentType: file.contentType,
          metadata: { sha256: file.sha256! },
          generation: "1728600000000001",
        },
      ] as never) as never,
    );
    const storage = createObjectStorage({
      ...getSettings({}),
      objectStorageBackend: "gcs",
      objectStorageBucket: "test-bucket",
      objectStorageGcsProjectId: "synthetic",
    })!;
    const head = await storage.headFile(file);
    expect(head.VersionToken).toBe("1728600000000001");
    expect((await storage.headObject!(file.objectKey))?.VersionToken).toBe(head.VersionToken);
  });
});
