import { describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BlobClient } from "@azure/storage-blob";
import { getSettings } from "@opengeni/config";
import { createObjectStorage, ObjectBodyIncompleteError } from "../src/index";

const KEY = "workspaces/w/files/f/retained/browser-screenshot.jpg";

function storage(backend: "s3-compatible" | "azure-blob") {
  return createObjectStorage({
    ...getSettings(),
    objectStorageBackend: backend,
    objectStorageBucket: "test-bucket",
    objectStorageEndpoint: "http://127.0.0.1:1",
    objectStorageInternalEndpoint: undefined,
    objectStorageAccessKeyId: "synthetic-test",
    objectStorageSecretAccessKey: "synthetic-test",
    objectStorageAzureConnectionString: undefined,
    objectStorageAzureAccountName: "synthetic",
    objectStorageAzureAccountKey: Buffer.from("synthetic-key").toString("base64"),
  })!;
}

/** A body that sends some bytes and then fails, like a store whose data block is gone. */
function failingBody(sent: Uint8Array, failure: Error): Readable {
  return Readable.from(
    (async function* () {
      if (sent.byteLength > 0) yield sent;
      throw failure;
    })(),
  );
}

function connectionReset(): Error {
  return Object.assign(new Error("aborted"), { code: "ECONNRESET" });
}

describe("a found object whose body never arrives intact", () => {
  test("S3: a body that fails mid-stream is ObjectBodyIncompleteError with the cause kept", async () => {
    const reset = connectionReset();
    const send = spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return { ContentLength: 8, Body: failingBody(new Uint8Array([1, 2]), reset) };
    });
    try {
      const error = await storage("s3-compatible")
        .getObjectBytes(KEY)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ObjectBodyIncompleteError);
      expect((error as ObjectBodyIncompleteError).objectKey).toBe(KEY);
      expect((error as Error).cause).toBe(reset);
      // Storage paths stay out of messages that can reach people.
      expect((error as Error).message).not.toContain("workspaces/");
    } finally {
      send.mockRestore();
    }
  });

  test("S3: a body that ends short of its declared length is ObjectBodyIncompleteError", async () => {
    const send = spyOn(S3Client.prototype, "send").mockImplementation(async () => ({
      ContentLength: 8,
      Body: Readable.from([Buffer.from([1, 2, 3])]),
    }));
    try {
      await expect(storage("s3-compatible").getObjectBytes(KEY)).rejects.toBeInstanceOf(
        ObjectBodyIncompleteError,
      );
    } finally {
      send.mockRestore();
    }
  });

  test("S3: a complete body, a missing object and an unreachable store keep their meaning", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const answers: Array<() => unknown> = [
      () => ({
        ContentLength: 3,
        ContentType: "image/jpeg",
        Body: Readable.from([Buffer.from([7, 8, 9])]),
      }),
      () => {
        throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      },
      () => {
        throw refused;
      },
    ];
    const send = spyOn(S3Client.prototype, "send").mockImplementation(async () =>
      answers.shift()!(),
    );
    try {
      const adapter = storage("s3-compatible");
      expect(await adapter.getObjectBytes(KEY)).toEqual({
        bytes: new Uint8Array([7, 8, 9]),
        contentType: "image/jpeg",
      });
      expect(await adapter.getObjectBytes(KEY)).toBeNull();
      // The store never answered: not a body failure.
      await expect(adapter.getObjectBytes(KEY)).rejects.toBe(refused);
    } finally {
      send.mockRestore();
    }
  });

  test("Azure: a body that fails mid-stream is ObjectBodyIncompleteError", async () => {
    const reset = connectionReset();
    const download = spyOn(BlobClient.prototype, "download").mockImplementation(
      async () =>
        ({
          contentLength: 8,
          readableStreamBody: failingBody(new Uint8Array([1]), reset),
        }) as never,
    );
    try {
      const error = await storage("azure-blob")
        .getObjectBytes(KEY)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ObjectBodyIncompleteError);
      expect((error as Error).cause).toBe(reset);
    } finally {
      download.mockRestore();
    }
  });
});
