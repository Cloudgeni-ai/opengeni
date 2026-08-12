import { describe, expect, test } from "bun:test";
import type { FileAsset } from "@opengeni/contracts";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";

import { sniffSlackReactionImageMime } from "../src/integrations/slack-bot";
import {
  importSlackReactionImage,
  safeSlackImageFilename,
  slackReactionImageIdentity,
} from "../src/slack-reaction-files";

const source = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  connectionId: "33333333-3333-4333-8333-333333333333",
  slackTeamId: "T_OPEN_GENI",
  slackChannelId: "C_MEMBER",
  slackMessageTs: "1706100000.000017",
};
const pngBytes = completePng();
const image = {
  fileId: "F_REACTED",
  filename: "../Quarterly <chart>.PNG",
  contentType: "image/png" as const,
  bytes: pngBytes,
};

describe("Slack reaction image workspace imports", () => {
  test("uses a tenant/source-bound identity and converges after PUT-success/finalize-crash", async () => {
    const objects = new Map<string, { head: ObjectHead; bytes: Uint8Array }>();
    let prepared: FileAsset | null = null;
    let putCount = 0;
    let completeCount = 0;
    const storage = fakeStorage(objects, async (upload) => {
      putCount += 1;
      objects.set(upload.key, {
        bytes: upload.body,
        head: objectHead(upload.body, upload.contentType, upload.sha256),
      });
      return true;
    });
    const dependencies = {
      db: {} as never,
      objectStorage: storage,
      async prepareFile(_db: never, input: Parameters<any>[1]) {
        prepared ??= fileAsset(input, "pending_upload");
        return { file: prepared, uploadId: input.uploadId, created: prepared.status !== "ready" };
      },
      async completeFile() {
        completeCount += 1;
        if (completeCount === 1) throw new Error("fixture finalize response lost");
        prepared = { ...prepared!, status: "ready" };
        return prepared;
      },
    };

    await expect(importSlackReactionImage(dependencies as never, source, image, 1)).rejects.toThrow(
      "fixture finalize response lost",
    );
    const replayed = await importSlackReactionImage(dependencies as never, source, image, 1);

    expect(putCount).toBe(1);
    expect(completeCount).toBe(2);
    expect(replayed).toMatchObject({
      contentType: "image/png",
      sizeBytes: pngBytes.byteLength,
      resource: {
        kind: "file",
        mountPath: "attachments/slack/01-Quarterly -chart-.png",
      },
    });
    expect(JSON.stringify(replayed)).not.toContain("files.slack.com");
    expect(JSON.stringify(replayed)).not.toContain(Buffer.from(pngBytes).toString("base64"));
  });

  test("leaves a prepared file non-ready after PUT failure and retries the same object", async () => {
    const objects = new Map<string, { head: ObjectHead; bytes: Uint8Array }>();
    let prepared: FileAsset | null = null;
    let attempts = 0;
    const storage = fakeStorage(objects, async (upload) => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture storage unavailable");
      objects.set(upload.key, {
        bytes: upload.body,
        head: objectHead(upload.body, upload.contentType, upload.sha256),
      });
      return true;
    });
    const dependencies = {
      db: {} as never,
      objectStorage: storage,
      async prepareFile(_db: never, input: Parameters<any>[1]) {
        prepared ??= fileAsset(input, "pending_upload");
        return { file: prepared, uploadId: input.uploadId, created: attempts === 0 };
      },
      async completeFile() {
        prepared = { ...prepared!, status: "ready" };
        return prepared;
      },
    };

    await expect(importSlackReactionImage(dependencies as never, source, image, 2)).rejects.toThrow(
      "fixture storage unavailable",
    );
    expect(prepared?.status).toBe("pending_upload");
    await expect(
      importSlackReactionImage(dependencies as never, source, image, 2),
    ).resolves.toMatchObject({
      resource: { mountPath: "attachments/slack/02-Quarterly -chart-.png" },
    });
    expect(attempts).toBe(2);
  });

  test("fails closed on an existing object MIME, size, or SHA mismatch", async () => {
    const wrong = new Uint8Array([1, 2, 3]);
    const storage = fakeStorage(new Map(), async () => false);
    storage.headObject = async () => objectHead(wrong, "text/html", "0".repeat(64));
    const input = { value: null as FileAsset | null };
    await expect(
      importSlackReactionImage(
        {
          db: {} as never,
          objectStorage: storage,
          async prepareFile(_db, prepared) {
            input.value = fileAsset(prepared, "pending_upload");
            return { file: input.value, uploadId: prepared.uploadId, created: true };
          },
          async completeFile() {
            throw new Error("must not finalize a mismatched object");
          },
        },
        source,
        image,
        1,
      ),
    ).rejects.toThrow("Stored Slack image differs");
  });

  test("keeps deterministic identity tenant-bound and sanitizes canonical extensions", () => {
    expect(slackReactionImageIdentity(source, image.fileId)).not.toBe(
      slackReactionImageIdentity({ ...source, workspaceId: crypto.randomUUID() }, image.fileId),
    );
    expect(safeSlackImageFilename("../../diagram.svg", "image/jpeg")).toBe("diagram.svg.jpg");
  });
});

describe("Slack reaction image magic sniffing", () => {
  test("accepts complete PNG, JPEG, and WebP only", () => {
    expect(sniffSlackReactionImageMime(completePng())).toBe("image/png");
    expect(sniffSlackReactionImageMime(completeJpeg())).toBe("image/jpeg");
    expect(sniffSlackReactionImageMime(completeWebp())).toBe("image/webp");
  });

  test("rejects empty, truncated, markup, unknown, and trailing polyglot bytes", () => {
    expect(sniffSlackReactionImageMime(new Uint8Array())).toBeNull();
    expect(sniffSlackReactionImageMime(completePng().subarray(0, 20))).toBeNull();
    expect(
      sniffSlackReactionImageMime(new TextEncoder().encode("<svg><script/></svg>")),
    ).toBeNull();
    expect(
      sniffSlackReactionImageMime(new TextEncoder().encode("<!doctype html><html/>")),
    ).toBeNull();
    expect(sniffSlackReactionImageMime(new Uint8Array(32))).toBeNull();
    expect(
      sniffSlackReactionImageMime(concat(completePng(), new TextEncoder().encode("<html>"))),
    ).toBeNull();
  });
});

function fakeStorage(
  objects: Map<string, { head: ObjectHead; bytes: Uint8Array }>,
  put: NonNullable<ObjectStorage["putObjectIfAbsent"]>,
): ObjectStorage {
  return {
    bucket: "test-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async headObject(key) {
      return objects.get(key)?.head ?? null;
    },
    putObjectIfAbsent: put,
  } as ObjectStorage;
}

function fileAsset(input: Record<string, any>, status: FileAsset["status"]): FileAsset {
  return {
    id: input.fileId,
    workspaceId: input.workspaceId,
    status,
    filename: input.filename,
    safeFilename: input.safeFilename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    bucket: input.bucket,
    objectKey: input.objectKey,
    createdAt: "2026-08-11T00:00:00.000Z",
  } as FileAsset;
}

function objectHead(body: Uint8Array, contentType: string, sha256: string): ObjectHead {
  return {
    ContentLength: body.byteLength,
    ContentType: contentType,
    Metadata: { sha256 },
    VersionToken: "v1",
  };
}

function completePng(): Uint8Array {
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
}

function completeJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff,
    0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
  ]);
}

function completeWebp(): Uint8Array {
  return new Uint8Array([
    82, 73, 70, 70, 14, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 2, 0, 0, 0, 47, 0,
  ]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
