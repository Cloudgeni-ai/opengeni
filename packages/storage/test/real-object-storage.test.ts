import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { RETAINED_OUTPUT_MAX_PAGE_BYTES, type FileAsset } from "@opengeni/contracts";
import { createObjectStorage } from "../src";

const endpoint = process.env.OPENGENI_TEST_OBJECT_STORAGE_ENDPOINT;
const accessKeyId = process.env.OPENGENI_TEST_OBJECT_STORAGE_ACCESS_KEY_ID;
const secretAccessKey = process.env.OPENGENI_TEST_OBJECT_STORAGE_SECRET_ACCESS_KEY;
const bucket = process.env.OPENGENI_TEST_OBJECT_STORAGE_BUCKET;
const live = Boolean(endpoint && accessKeyId && secretAccessKey && bucket);

describe.skipIf(!live)("real S3-compatible retained-output ranges", () => {
  test("reads exact bytes from a retained multi-megabyte object", async () => {
    const storage = withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
        OPENGENI_OBJECT_STORAGE_ENDPOINT: endpoint!,
        OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: accessKeyId!,
        OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: secretAccessKey!,
        OPENGENI_OBJECT_STORAGE_BUCKET: bucket!,
        OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
      },
      () => createObjectStorage(getSettings()),
    );
    expect(storage).not.toBeNull();

    const body = new Uint8Array(4 * 1024 * 1024);
    for (let index = 0; index < body.byteLength; index += 1) body[index] = index % 251;
    const sha256 = digest(body);
    const objectKey = `retained-output-integration/${crypto.randomUUID()}.bin`;
    const file = fileAsset(body.byteLength, objectKey, sha256, bucket!);

    try {
      await storage!.putObject({
        key: objectKey,
        contentType: file.contentType,
        body,
        sha256,
      });

      const head = await storage!.headFile(file);
      expect(head.ContentLength).toBe(body.byteLength);
      expect(head.ContentType).toBe(file.contentType);
      expect(head.Metadata?.sha256).toBe(sha256);

      const range = { start: 2_000_000, end: 2_123_456 };
      const expected = body.slice(range.start, range.end + 1);
      const selected = await storage!.getFileRange(file, range);
      expect(selected?.byteLength).toBe(expected.byteLength);
      expect(selected).toEqual(expected);
      expect(digest(selected!)).toBe(digest(expected));

      const missing = fileAsset(body.byteLength, `${objectKey}.missing`, sha256, bucket!);
      expect(await storage!.getFileRange(missing, { start: 0, end: 63 })).toBeNull();

      await expect(
        storage!.getFileRange(file, {
          start: 0,
          end: RETAINED_OUTPUT_MAX_PAGE_BYTES,
        }),
      ).rejects.toThrow("exceeds");
    } finally {
      await storage!.deleteObject(objectKey);
    }
  }, 30_000);
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileAsset(
  sizeBytes: number,
  objectKey: string,
  sha256: string,
  fileBucket: string,
): FileAsset {
  return {
    id: crypto.randomUUID(),
    workspaceId: "11111111-1111-4111-8111-111111111111",
    status: "ready",
    filename: "output.bin",
    safeFilename: "output.bin",
    contentType: "application/octet-stream",
    sizeBytes,
    sha256,
    bucket: fileBucket,
    objectKey,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...original, ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}
