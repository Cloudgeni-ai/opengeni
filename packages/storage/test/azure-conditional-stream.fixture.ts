// Run in a child process: the pre-fix SDK exception escapes the upload promise.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { spyOn } from "bun:test";
import { BlockBlobClient } from "@azure/storage-blob";
import { getSettings } from "@opengeni/config";
import { createObjectStorage } from "../src/index";

const scenario = process.argv[2];
const blockSize = 1024 * 1024;
const expected = new Uint8Array(scenario === "multiple-blocks" ? blockSize * 3 + 17 : 17);
for (let index = 0; index < expected.length; index++) expected[index] = index % 251;
const failure = Object.assign(new Error("synthetic upload failure"), {
  statusCode: scenario === "conflict" ? 412 : 503,
});
const staged: Buffer[] = [];
const ids: string[] = [];
let committed = false;
let finalized = false;
let source: Readable | undefined;
const signal = new AbortController().signal;
const realUploadStream = BlockBlobClient.prototype.uploadStream;
// Observe the adapter boundary but retain the real SDK uploadStream/BufferScheduler.
spyOn(BlockBlobClient.prototype, "uploadStream").mockImplementation(
  function (stream, size, concurrency, options) {
    source = stream as Readable;
    assert.equal(size, blockSize);
    assert.equal(concurrency, 2);
    assert.equal(options?.abortSignal, signal);
    return realUploadStream.call(this, stream, size, concurrency, options);
  },
);
spyOn(BlockBlobClient.prototype, "stageBlock").mockImplementation(async (id, body, length) => {
  if (scenario === "stage-error") throw failure;
  assert.equal(typeof body, "function");
  const parts: Buffer[] = [];
  for await (const part of (body as () => Readable)()) parts.push(Buffer.from(part));
  const bytes = Buffer.concat(parts);
  assert.equal(bytes.length, length);
  staged.push(bytes);
  ids.push(id);
  return {};
});
spyOn(BlockBlobClient.prototype, "commitBlockList").mockImplementation(async (blocks, options) => {
  committed = true;
  assert.deepEqual(blocks, ids);
  assert.deepEqual(options?.conditions, { ifNoneMatch: "*" });
  assert.deepEqual(options?.blobHTTPHeaders, { blobContentType: "application/octet-stream" });
  assert.deepEqual(options?.metadata, { sha256: "synthetic-digest" });
  assert.equal(options?.abortSignal, signal);
  if (scenario === "conflict" || scenario === "commit-error") throw failure;
  return { _response: { status: 201 } };
});

const storage = createObjectStorage({
  ...getSettings(),
  objectStorageBackend: "azure-blob",
  objectStorageBucket: "test-bucket",
  objectStorageAzureConnectionString: undefined,
  objectStorageAzureAccountName: "synthetic",
  objectStorageAzureAccountKey: Buffer.from("synthetic-key").toString("base64"),
})!;
const upload = storage.putObjectStreamIfAbsent!({
  key: "synthetic/object",
  contentType: "application/octet-stream",
  byteSize: expected.length,
  sha256: "synthetic-digest",
  signal,
  chunks: (async function* () {
    try {
      // Plain Uint8Array views, not Buffers; include a non-zero byte offset.
      assert.equal(Buffer.isBuffer(expected), false);
      yield expected.subarray(0, 7);
      if (scenario === "producer-error") throw failure;
      yield expected.subarray(7);
    } finally {
      finalized = true;
    }
  })(),
});
if (["producer-error", "stage-error", "commit-error"].includes(scenario!)) {
  await assert.rejects(upload, (error) => error === failure);
  if (scenario !== "commit-error") assert.equal(committed, false);
} else {
  assert.equal(await upload, scenario !== "conflict");
  assert.equal(committed, true);
  assert.deepEqual(Buffer.concat(staged), Buffer.from(expected));
  assert.equal(staged.length, scenario === "multiple-blocks" ? 4 : 1);
}
assert.equal(source?.readableObjectMode, false);
assert.equal(source?.readableHighWaterMark, blockSize);
assert.equal(source?.destroyed, true);
assert.equal(finalized, true);
console.log(`passed: ${scenario}`);
