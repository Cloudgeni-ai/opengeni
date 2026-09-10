import { describe, expect, spyOn, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { getEventListeners } from "node:events";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { BlockBlobClient } from "@azure/storage-blob";
import { File } from "@google-cloud/storage";
import { getSettings } from "@opengeni/config";
import {
  createObjectStorage,
  downloadWorkspaceArchiveSpool,
  uploadWorkspaceArchiveSpool,
  WorkspaceArchiveStorageError,
} from "../src/index";

const bytes = new Uint8Array([1, 2, 3, 4]);
const signal = new AbortController().signal;
const input = () => ({
  key: "archives/unique-invocation.tar",
  contentType: "application/x-tar",
  byteSize: bytes.length,
  sha256: "test-digest",
  signal,
  chunks: (async function* () {
    yield bytes.subarray(0, 2);
    yield bytes.subarray(2);
  })(),
});

function storage(backend: "s3-compatible" | "aws-s3" | "gcs" | "azure-blob") {
  return createObjectStorage({
    ...getSettings(),
    objectStorageBackend: backend,
    objectStorageBucket: "test-bucket",
    objectStorageEndpoint: "http://127.0.0.1:1",
    objectStorageInternalEndpoint: undefined,
    objectStorageAccessKeyId: "synthetic-test",
    objectStorageSecretAccessKey: "synthetic-test",
    objectStorageGcsProjectId: "synthetic-project",
    objectStorageGcsKeyFilename: undefined,
    objectStorageGcsCredentialsJson: undefined,
    objectStorageAzureConnectionString: undefined,
    objectStorageAzureAccountName: "synthetic",
    objectStorageAzureAccountKey: Buffer.from("synthetic-key").toString("base64"),
  })!;
}

async function consume(chunks: AsyncIterable<Uint8Array>) {
  const collected: number[] = [];
  for await (const chunk of chunks) collected.push(...chunk);
  expect(collected).toEqual([...bytes]);
}

describe("unconditional streaming object storage (SDK stubs, no providers)", () => {
  for (const mode of ["direct", "spool"] as const) {
    test(`S3 ${mode} producer errors abort the owning request and preserve the original failure`, async () => {
      const original = new WorkspaceArchiveStorageError(
        "archive_hash_mismatch",
        "synthetic producer mismatch",
        false,
      );
      const caller = new AbortController();
      const before = getEventListeners(caller.signal, "abort").length;
      let requestSignal: AbortSignal | undefined;
      let requestBody: Readable | undefined;
      let rejectRequest: ((error: unknown) => void) | undefined;
      let observeError!: (error: Error) => void;
      const producerError = new Promise<Error>((resolve) => {
        observeError = resolve;
      });
      const send = spyOn(S3Client.prototype, "send").mockImplementation(
        (command, options) =>
          new Promise((_resolve, reject) => {
            rejectRequest = reject;
            requestSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            requestBody = (command as PutObjectCommand).input.Body as Readable;
            // Reproduce the SDK path: body errors alone do not settle send().
            requestSignal?.addEventListener(
              "abort",
              () => reject(new Error("SDK request aborted")),
              { once: true },
            );
            requestBody.once("error", observeError);
            requestBody.resume();
          }),
      );
      const adapter = storage("s3-compatible");
      const pending = (
        mode === "direct"
          ? adapter.putObjectStream!({
              ...input(),
              signal: caller.signal,
              chunks: (async function* () {
                yield bytes;
                throw original;
              })(),
            })
          : uploadWorkspaceArchiveSpool(adapter, input().key, {
              path: "unused",
              byteSize: bytes.length,
              sha256: "a".repeat(64),
              async *open() {
                yield bytes;
              },
              async dispose() {
                throw new Error("caller-owned spool");
              },
            })
      ).catch((error: unknown) => error);
      try {
        const emitted = await producerError;
        expect(requestSignal?.aborted).toBe(true);
        expect(await pending).toBe(emitted);
        expect(emitted).toMatchObject({ code: "archive_hash_mismatch", retryable: false });
        if (mode === "direct") expect(emitted).toBe(original);
        expect(caller.signal.aborted).toBe(false);
        expect(requestBody?.destroyed).toBe(true);
        expect(getEventListeners(caller.signal, "abort").length).toBe(before);
      } finally {
        // Also settle the deliberately broken pre-fix stub after a red assertion.
        rejectRequest?.(original);
        await pending;
        send.mockRestore();
      }
    });
  }

  for (const alreadyAborted of [false, true]) {
    test(`S3 forwards caller cancellation and removes its listener (pre-aborted=${alreadyAborted})`, async () => {
      const caller = new AbortController();
      const reason = new Error("caller cancellation");
      if (alreadyAborted) caller.abort(reason);
      let requestBody: Readable | undefined;
      let requestSignal: AbortSignal | undefined;
      const before = getEventListeners(caller.signal, "abort").length;
      const send = spyOn(S3Client.prototype, "send").mockImplementation(
        (command, options) =>
          new Promise((_resolve, reject) => {
            requestBody = (command as PutObjectCommand).input.Body as Readable;
            requestSignal = (options as { abortSignal: AbortSignal }).abortSignal;
            if (requestSignal.aborted) reject(reason);
            else requestSignal.addEventListener("abort", () => reject(reason), { once: true });
          }),
      );
      try {
        const pending = storage("s3-compatible").putObjectStream!({
          ...input(),
          signal: caller.signal,
        });
        caller.abort(reason);
        await expect(pending).rejects.toBe(reason);
        expect(requestSignal?.aborted).toBe(true);
        expect(requestSignal).not.toBe(caller.signal);
        expect(requestBody?.destroyed).toBe(true);
        expect(getEventListeners(caller.signal, "abort").length).toBe(before);
      } finally {
        send.mockRestore();
      }
    });
  }

  test("S3 successful upload detaches caller cancellation", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let requestBody: Readable | undefined;
    const before = getEventListeners(caller.signal, "abort").length;
    const send = spyOn(S3Client.prototype, "send").mockImplementation(async (command, options) => {
      requestSignal = (options as { abortSignal: AbortSignal }).abortSignal;
      requestBody = (command as PutObjectCommand).input.Body as Readable;
      await consume(requestBody);
      return {};
    });
    try {
      await storage("s3-compatible").putObjectStream!({ ...input(), signal: caller.signal });
      expect(getEventListeners(caller.signal, "abort").length).toBe(before);
      caller.abort(new Error("later cancellation"));
      expect(requestSignal?.aborted).toBe(false);
      expect(requestBody?.destroyed).toBe(true);
    } finally {
      send.mockRestore();
    }
  });

  test("S3 adapter's failed If-Match range is classified as replacement after a fresh HEAD", async () => {
    const commands: string[] = [];
    let heads = 0;
    const send = spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      commands.push(command.constructor.name);
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: bytes.length, ETag: ++heads === 1 ? "v1" : "v2" };
      }
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect((command as GetObjectCommand).input.IfMatch).toBe("v1");
      expect((command as GetObjectCommand).input.Range).toBe("bytes=0-3");
      throw { $metadata: { httpStatusCode: 412 } };
    });
    try {
      await expect(
        downloadWorkspaceArchiveSpool(storage("s3-compatible"), input().key, {
          bytes: bytes.length,
          sha256: "a".repeat(64),
        }),
      ).rejects.toMatchObject({
        code: "archive_hydration_failed",
        retryable: true,
        message: "Workspace archive object version changed",
      });
      expect(commands).toEqual(["HeadObjectCommand", "GetObjectCommand", "HeadObjectCommand"]);
    } finally {
      send.mockRestore();
    }
  });

  for (const backend of ["s3-compatible", "aws-s3"] as const) {
    test(`${backend} streams with explicit length and no create-only condition`, async () => {
      const conditions: (string | undefined)[] = [];
      const send = spyOn(S3Client.prototype, "send").mockImplementation(
        async (command, options) => {
          expect(command).toBeInstanceOf(PutObjectCommand);
          const put = (command as PutObjectCommand).input;
          expect(put.Key).toBe(input().key);
          expect(put.ContentType).toBe(input().contentType);
          expect(put.ContentLength).toBe(bytes.length);
          expect(put.Metadata).toEqual({ sha256: "test-digest" });
          expect((options as { abortSignal: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
          expect((options as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(false);
          if (put.IfNoneMatch) expect(options).toEqual({ abortSignal: signal });
          conditions.push(put.IfNoneMatch);
          await consume(put.Body as Readable);
          return {};
        },
      );
      try {
        const adapter = storage(backend);
        await expect(adapter.putObjectStream!(input())).resolves.toBeUndefined();
        await expect(adapter.putObjectStreamIfAbsent!(input())).resolves.toBe(true);
        expect(conditions).toEqual([undefined, "*"]);
      } finally {
        send.mockRestore();
      }
    });
  }

  test("Azure streams with bounded buffers and preserves the separate IfAbsent condition", async () => {
    const conditions: unknown[] = [];
    const upload = spyOn(BlockBlobClient.prototype, "uploadStream").mockImplementation(
      async (stream, size, concurrency, options) => {
        expect(size).toBe(1024 * 1024);
        expect(concurrency).toBe(2);
        expect(options?.blobHTTPHeaders).toEqual({ blobContentType: "application/x-tar" });
        expect(options?.metadata).toEqual({ sha256: "test-digest" });
        expect(options?.abortSignal).toBe(signal);
        conditions.push(options?.conditions);
        await consume(stream as Readable);
        return {};
      },
    );
    try {
      const adapter = storage("azure-blob");
      await expect(adapter.putObjectStream!(input())).resolves.toBeUndefined();
      await expect(adapter.putObjectStreamIfAbsent!(input())).resolves.toBe(true);
      expect(conditions).toEqual([undefined, { ifNoneMatch: "*" }]);
    } finally {
      upload.mockRestore();
    }
  });

  test("GCS pipelines bounded streams without generation preconditions on unconditional PUT", async () => {
    const conditions: unknown[] = [];
    const received: number[][] = [];
    const write = spyOn(File.prototype, "createWriteStream").mockImplementation((options) => {
      expect(options?.resumable).toBe(false);
      expect(options?.highWaterMark).toBe(1024 * 1024);
      expect(options?.contentType).toBe("application/x-tar");
      expect(options?.metadata).toEqual({ metadata: { sha256: "test-digest" } });
      conditions.push(options?.preconditionOpts);
      const output: number[] = [];
      received.push(output);
      return new Writable({
        write(chunk, _encoding, done) {
          output.push(...chunk);
          done();
        },
      });
    });
    try {
      const adapter = storage("gcs");
      await expect(adapter.putObjectStream!(input())).resolves.toBeUndefined();
      await expect(adapter.putObjectStreamIfAbsent!(input())).resolves.toBe(true);
      expect(conditions).toEqual([undefined, { ifGenerationMatch: 0 }]);
      expect(received).toEqual([[...bytes], [...bytes]]);
    } finally {
      write.mockRestore();
    }
  });

  for (const backend of ["s3-compatible", "azure-blob", "gcs"] as const) {
    test(`${backend} propagates failed writes rather than treating them as collisions`, async () => {
      const failure = Object.assign(new Error("synthetic precondition failure"), {
        code: 412,
        statusCode: 412,
        $metadata: { httpStatusCode: 412 },
      });
      const send = spyOn(S3Client.prototype, "send").mockRejectedValue(failure);
      const upload = spyOn(BlockBlobClient.prototype, "uploadStream").mockRejectedValue(failure);
      const write = spyOn(File.prototype, "createWriteStream").mockImplementation(
        () =>
          new Writable({
            write(_chunk, _encoding, done) {
              done(failure);
            },
          }),
      );
      try {
        await expect(storage(backend).putObjectStream!(input())).rejects.toBe(failure);
      } finally {
        send.mockRestore();
        upload.mockRestore();
        write.mockRestore();
      }
    });
  }
});
