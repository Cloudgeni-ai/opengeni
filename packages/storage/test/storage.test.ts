import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { createObjectStorage } from "../src";

describe("object storage adapters", () => {
  test("creates S3-compatible storage from endpoint credentials", () => {
    const storage = withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
      OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
      OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
    }, () => createObjectStorage(getSettings()));

    expect(storage?.backend).toBe("s3-compatible");
    expect(storage?.bucket).toBe("opengeni-files");
  });

  test("creates Azure Blob storage and signs upload/download URLs", async () => {
    const storage = withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
      OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
      OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: "opengeni",
      OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY: Buffer.from("test-storage-key").toString("base64"),
    }, () => createObjectStorage(getSettings()));

    expect(storage?.backend).toBe("azure-blob");
    expect(storage?.bucket).toBe("opengeni-files");

    const put = await storage!.createPutUrl({
      key: "files/file-id/original/test.txt",
      contentType: "text/plain",
      sha256: "checksum",
    });
    expect(put.url).toContain("https://opengeni.blob.core.windows.net/opengeni-files/files/file-id/original/test.txt?");
    expect(put.url).toContain("sp=cw");
    expect(put.requiredHeaders).toMatchObject({
      "content-type": "text/plain",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-meta-sha256": "checksum",
    });

    const get = await storage!.createGetUrl({ key: "files/file-id/original/test.txt" });
    expect(get.url).toContain("sp=r");
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}
