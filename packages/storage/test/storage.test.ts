import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { createObjectStorage } from "../src";

describe("object storage adapters", () => {
  test("creates S3-compatible storage and signs checksum metadata once", async () => {
    const storage = withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
        OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
        OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
      },
      () => createObjectStorage(getSettings()),
    );

    expect(storage?.backend).toBe("s3-compatible");
    expect(storage?.bucket).toBe("opengeni-files");
    const put = await storage!.createPutUrl({
      key: "files/file-id/original/test.txt",
      contentType: "text/plain",
      sha256: "checksum",
    });
    expect(put.requiredHeaders).toEqual({ "content-type": "text/plain" });
    expect(new URL(put.url).searchParams.get("x-amz-meta-sha256")).toBe("checksum");
  });

  test("creates Azure Blob storage and signs upload/download URLs", async () => {
    const storage = withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
        OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: "opengeni",
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY:
          Buffer.from("test-storage-key").toString("base64"),
      },
      () => createObjectStorage(getSettings()),
    );

    expect(storage?.backend).toBe("azure-blob");
    expect(storage?.bucket).toBe("opengeni-files");

    const put = await storage!.createPutUrl({
      key: "files/file-id/original/test.txt",
      contentType: "text/plain",
      sha256: "checksum",
    });
    expect(put.url).toContain(
      "https://opengeni.blob.core.windows.net/opengeni-files/files/file-id/original/test.txt?",
    );
    expect(put.url).toContain("sp=cw");
    expect(put.requiredHeaders).toMatchObject({
      "content-type": "text/plain",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-meta-sha256": "checksum",
    });

    const get = await storage!.createGetUrl({ key: "files/file-id/original/test.txt" });
    expect(get.url).toContain("sp=r");
  });

  test("creates AWS S3 storage without requiring static credentials", () => {
    const storage = withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "aws-s3",
        OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
        OPENGENI_OBJECT_STORAGE_REGION: "us-east-1",
        OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "false",
      },
      () => createObjectStorage(getSettings()),
    );

    expect(storage?.backend).toBe("aws-s3");
    expect(storage?.bucket).toBe("opengeni-files");
  });

  test("creates GCS storage from provider-neutral settings", () => {
    const storage = withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
        OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
        OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID: "opengeni-test",
      },
      () => createObjectStorage(getSettings()),
    );

    expect(storage?.backend).toBe("gcs");
    expect(storage?.bucket).toBe("opengeni-files");
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

describe("getObjectBytes (S3-compatible)", () => {
  function startFakeS3(objects: Record<string, { body: string; contentType: string }>) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\//, ""));
        const object = objects[key];
        if (!object) {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>not found</Message><Key>${key}</Key><RequestId>req-1</RequestId></Error>`,
            { status: 404, headers: { "content-type": "application/xml" } },
          );
        }
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-length": String(Buffer.byteLength(object.body)),
              "content-type": object.contentType,
              "x-amz-meta-sha256": "stored-checksum",
            },
          });
        }
        return new Response(object.body, {
          status: 200,
          headers: { "content-type": object.contentType },
        });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
  }

  test("returns bytes and content type for an existing object", async () => {
    const fake = startFakeS3({
      "catalog-assets/logos/example.com/abc.png": { body: "logo-bytes", contentType: "image/png" },
    });
    try {
      const storage = withEnv(
        {
          OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
          OPENGENI_OBJECT_STORAGE_ENDPOINT: fake.url,
          OPENGENI_OBJECT_STORAGE_BUCKET: "test-bucket",
          OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
          OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "test",
          OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test",
        },
        () => createObjectStorage(getSettings()),
      );
      const result = await storage!.getObjectBytes("catalog-assets/logos/example.com/abc.png");
      expect(result).not.toBeNull();
      expect(Buffer.from(result!.bytes).toString("utf8")).toBe("logo-bytes");
      expect(result!.contentType).toBe("image/png");
    } finally {
      fake.close();
    }
  });

  test("returns null for a missing object instead of throwing", async () => {
    const fake = startFakeS3({});
    try {
      const storage = withEnv(
        {
          OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
          OPENGENI_OBJECT_STORAGE_ENDPOINT: fake.url,
          OPENGENI_OBJECT_STORAGE_BUCKET: "test-bucket",
          OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
          OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "test",
          OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test",
        },
        () => createObjectStorage(getSettings()),
      );
      const result = await storage!.getObjectBytes("catalog-assets/logos/missing.com/zzz.png");
      expect(result).toBeNull();
    } finally {
      fake.close();
    }
  });

  test("heads an existing raw-key object without downloading it", async () => {
    const fake = startFakeS3({
      "workspace-captures/ws/sess/blobs/abc": { body: "capture", contentType: "text/plain" },
    });
    try {
      const storage = withEnv(
        {
          OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
          OPENGENI_OBJECT_STORAGE_ENDPOINT: fake.url,
          OPENGENI_OBJECT_STORAGE_BUCKET: "test-bucket",
          OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
          OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "test",
          OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test",
        },
        () => createObjectStorage(getSettings()),
      );
      expect(await storage!.headObject("workspace-captures/ws/sess/blobs/abc")).toEqual({
        ContentLength: 7,
        ContentType: "text/plain",
        Metadata: { sha256: "stored-checksum" },
      });
    } finally {
      fake.close();
    }
  });

  test("returns null when a raw-key HEAD is missing", async () => {
    const fake = startFakeS3({});
    try {
      const storage = withEnv(
        {
          OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
          OPENGENI_OBJECT_STORAGE_ENDPOINT: fake.url,
          OPENGENI_OBJECT_STORAGE_BUCKET: "test-bucket",
          OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
          OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "test",
          OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test",
        },
        () => createObjectStorage(getSettings()),
      );
      expect(await storage!.headObject("workspace-captures/ws/sess/blobs/missing")).toBeNull();
    } finally {
      fake.close();
    }
  });
});
