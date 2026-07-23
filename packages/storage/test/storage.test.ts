import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { RETAINED_OUTPUT_MAX_PAGE_BYTES, type FileAsset } from "@opengeni/contracts";
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
});

describe("getFileRange (S3-compatible)", () => {
  function startRangeS3(
    objects: Record<string, Uint8Array>,
    options: { shortResponse?: boolean } = {},
  ) {
    const ranges: Array<string | null> = [];
    let servedBytes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\//, ""));
        const object = objects[key];
        if (!object) {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>not found</Message><Key>${key}</Key><RequestId>req-range</RequestId></Error>`,
            { status: 404, headers: { "content-type": "application/xml" } },
          );
        }
        const header = request.headers.get("range");
        ranges.push(header);
        const match = header ? /^bytes=(\d+)-(\d+)$/.exec(header) : null;
        if (!match) {
          servedBytes += object.byteLength;
          return new Response(object);
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        const responseEnd = options.shortResponse ? Math.max(start, end - 1) : end;
        const bytes = object.slice(start, responseEnd + 1);
        servedBytes += bytes.byteLength;
        return new Response(bytes, {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${responseEnd}/${object.byteLength}`,
            "content-type": "application/octet-stream",
          },
        });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      ranges,
      servedBytes: () => servedBytes,
      close: () => server.stop(true),
    };
  }

  function file(sizeBytes: number, objectKey = "retained/output.bin"): FileAsset {
    return {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      status: "ready",
      filename: "output.bin",
      safeFilename: "output.bin",
      contentType: "application/octet-stream",
      sizeBytes,
      sha256: "a".repeat(64),
      bucket: "test-bucket",
      objectKey,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
  }

  function storageAt(endpoint: string) {
    return withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
        OPENGENI_OBJECT_STORAGE_ENDPOINT: endpoint,
        OPENGENI_OBJECT_STORAGE_BUCKET: "test-bucket",
        OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
        OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "test",
        OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test",
      },
      () => createObjectStorage(getSettings()),
    )!;
  }

  test("requests and materializes only the selected range of a multi-megabyte object", async () => {
    const body = new Uint8Array(4 * 1024 * 1024);
    for (let index = 0; index < body.byteLength; index += 1) body[index] = index % 251;
    const fake = startRangeS3({ "retained/output.bin": body });
    try {
      const storage = storageAt(fake.url);
      const range = { start: 2_000_000, end: 2_000_999 };
      const bytes = await storage.getFileRange(file(body.byteLength), range);
      expect(bytes).toEqual(body.slice(range.start, range.end + 1));
      expect(fake.ranges).toEqual([`bytes=${range.start}-${range.end}`]);
      expect(fake.servedBytes()).toBe(1_000);
    } finally {
      fake.close();
    }
  });

  test("rejects an oversized range before any provider request", async () => {
    const body = new Uint8Array(RETAINED_OUTPUT_MAX_PAGE_BYTES + 2);
    const fake = startRangeS3({ "retained/output.bin": body });
    try {
      const storage = storageAt(fake.url);
      await expect(
        storage.getFileRange(file(body.byteLength), {
          start: 0,
          end: RETAINED_OUTPUT_MAX_PAGE_BYTES,
        }),
      ).rejects.toThrow("exceeds");
      expect(fake.ranges).toHaveLength(0);
      expect(fake.servedBytes()).toBe(0);
    } finally {
      fake.close();
    }
  });

  test("returns null for missing storage and rejects incomplete provider ranges", async () => {
    const body = new Uint8Array(1_024);
    const missing = startRangeS3({});
    try {
      expect(
        await storageAt(missing.url).getFileRange(file(body.byteLength), { start: 0, end: 9 }),
      ).toBeNull();
    } finally {
      missing.close();
    }

    const short = startRangeS3({ "retained/output.bin": body }, { shortResponse: true });
    try {
      await expect(
        storageAt(short.url).getFileRange(file(body.byteLength), { start: 100, end: 199 }),
      ).rejects.toThrow("length mismatch");
      expect(short.servedBytes()).toBe(99);
    } finally {
      short.close();
    }
  });
});
