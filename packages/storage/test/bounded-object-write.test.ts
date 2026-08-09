import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createBoundedImmutableObjectWritePort,
  createBoundedObjectReadPort,
  type ImmutableContentAddressedWriteBackend,
  type VersionedRangeObjectBackend,
} from "../src";

describe("bounded immutable content-addressed object writes", () => {
  test("streams upload, commits by digest, and independently streams read-back", async () => {
    const fixture = objectStoreFixture();
    const writer = createBoundedImmutableObjectWritePort({
      backend: fixture.writer,
      readback: createBoundedObjectReadPort(fixture.reader),
    });
    const result = await writer.write({
      chunks: chunks("hello", " ", "world"),
      contentType: "application/octet-stream",
      maxBytes: 11,
      expectedByteSize: 11,
      expectedContentHash: digest("hello world"),
    });
    expect(result).toEqual({
      opaqueReference: `opaque:${digest("hello world")}`,
      byteSize: 11,
      contentHash: digest("hello world"),
      contentType: "application/octet-stream",
    });
    expect(fixture.writes).toEqual([5, 1, 5]);
    expect(fixture.commits).toBe(1);
    expect(fixture.readRanges.length).toBeGreaterThan(0);
    expect(fixture.aborts).toBe(0);
  });

  test("rejects source hash and size mismatches and aborts staging", async () => {
    for (const request of [
      {
        expectedByteSize: 4,
        expectedContentHash: digest("hello"),
      },
      {
        expectedByteSize: 5,
        expectedContentHash: digest("other"),
      },
    ]) {
      const fixture = objectStoreFixture();
      const writer = createBoundedImmutableObjectWritePort({
        backend: fixture.writer,
        readback: createBoundedObjectReadPort(fixture.reader),
      });
      await expect(
        writer.write({
          chunks: chunks("hello"),
          contentType: "application/octet-stream",
          maxBytes: 5,
          ...request,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(fixture.commits).toBe(0);
      expect(fixture.aborts).toBe(1);
    }
  });

  test("fails closed when immutable read-back bytes differ", async () => {
    const fixture = objectStoreFixture({ corruptReadback: true });
    const writer = createBoundedImmutableObjectWritePort({
      backend: fixture.writer,
      readback: createBoundedObjectReadPort(fixture.reader),
    });
    await expect(
      writer.write({
        chunks: chunks("canonical"),
        contentType: "application/octet-stream",
        maxBytes: 9,
      }),
    ).rejects.toMatchObject({ code: "readback_mismatch" });
    // Commit succeeded, so immutable garbage is orphaned for the sweeper; it
    // is never returned or published and staging abort is no longer valid.
    expect(fixture.commits).toBe(1);
    expect(fixture.aborts).toBe(0);
  });

  test("enforces bounds during streaming and cleans cancellation exactly once", async () => {
    const oversized = objectStoreFixture();
    const oversizedWriter = createBoundedImmutableObjectWritePort({
      backend: oversized.writer,
      readback: createBoundedObjectReadPort(oversized.reader),
    });
    await expect(
      oversizedWriter.write({
        chunks: chunks("123", "456"),
        contentType: "application/octet-stream",
        maxBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "size_limit" });
    expect(oversized.aborts).toBe(1);

    const giantChunk = objectStoreFixture();
    const giantChunkWriter = createBoundedImmutableObjectWritePort({
      backend: giantChunk.writer,
      readback: createBoundedObjectReadPort(giantChunk.reader),
    });
    await expect(
      giantChunkWriter.write({
        chunks: {
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array(8 * 1024 * 1024 + 1);
          },
        },
        contentType: "application/octet-stream",
        maxBytes: 16 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "size_limit" });
    expect(giantChunk.writes).toHaveLength(0);
    expect(giantChunk.aborts).toBe(1);

    const cancelled = objectStoreFixture();
    const controller = new AbortController();
    cancelled.onWrite = () => controller.abort();
    const cancelledWriter = createBoundedImmutableObjectWritePort({
      backend: cancelled.writer,
      readback: createBoundedObjectReadPort(cancelled.reader),
    });
    await expect(
      cancelledWriter.write({
        chunks: chunks("123", "456"),
        contentType: "application/octet-stream",
        maxBytes: 6,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(cancelled.aborts).toBe(1);

    const cancelledAfterFinalWrite = objectStoreFixture();
    const finalWriteController = new AbortController();
    cancelledAfterFinalWrite.onWrite = () => finalWriteController.abort();
    const finalWriteWriter = createBoundedImmutableObjectWritePort({
      backend: cancelledAfterFinalWrite.writer,
      readback: createBoundedObjectReadPort(cancelledAfterFinalWrite.reader),
    });
    await expect(
      finalWriteWriter.write({
        chunks: chunks("only chunk"),
        contentType: "application/octet-stream",
        maxBytes: 10,
        signal: finalWriteController.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(cancelledAfterFinalWrite.commits).toBe(0);
    expect(cancelledAfterFinalWrite.aborts).toBe(1);

    const cancelledDuringCommit = objectStoreFixture();
    const commitController = new AbortController();
    cancelledDuringCommit.onCommit = () => commitController.abort();
    const commitWriter = createBoundedImmutableObjectWritePort({
      backend: cancelledDuringCommit.writer,
      readback: createBoundedObjectReadPort(cancelledDuringCommit.reader),
    });
    await expect(
      commitWriter.write({
        chunks: chunks("committed orphan"),
        contentType: "application/octet-stream",
        maxBytes: 16,
        signal: commitController.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(cancelledDuringCommit.commits).toBe(1);
    // Promotion already happened. Calling staging abort after commit would be
    // invalid; the unreferenced immutable object is left for the sweeper.
    expect(cancelledDuringCommit.aborts).toBe(0);
  });

  test("scrubs provider keys and signed URLs from errors", async () => {
    const secret = "bucket/private?signature=secret";
    const backend: ImmutableContentAddressedWriteBackend = {
      async begin() {
        throw new Error(secret);
      },
    };
    const fixture = objectStoreFixture();
    let failure: unknown;
    try {
      await createBoundedImmutableObjectWritePort({
        backend,
        readback: createBoundedObjectReadPort(fixture.reader),
      }).write({
        chunks: chunks("x"),
        contentType: "application/octet-stream",
        maxBytes: 1,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "backend_failure" });
    expect((failure as Error).message).not.toContain(secret);
  });
});

function objectStoreFixture(options: { corruptReadback?: boolean } = {}): {
  writer: ImmutableContentAddressedWriteBackend;
  reader: VersionedRangeObjectBackend;
  writes: number[];
  commits: number;
  aborts: number;
  readRanges: Array<[number, number]>;
  onWrite?: () => void;
  onCommit?: () => void;
} {
  const objects = new Map<string, Uint8Array>();
  const staging: Uint8Array[] = [];
  const fixture = {
    writes: [] as number[],
    commits: 0,
    aborts: 0,
    readRanges: [] as Array<[number, number]>,
    onWrite: undefined as (() => void) | undefined,
    onCommit: undefined as (() => void) | undefined,
    writer: {} as ImmutableContentAddressedWriteBackend,
    reader: {} as VersionedRangeObjectBackend,
  };
  fixture.writer = {
    async begin() {
      return {
        async write(chunk) {
          fixture.writes.push(chunk.byteLength);
          staging.push(chunk.slice());
          fixture.onWrite?.();
        },
        async commit(input) {
          fixture.commits += 1;
          const bytes = Buffer.concat(staging, input.byteSize);
          const reference = `opaque:${input.contentHash}`;
          objects.set(
            reference,
            options.corruptReadback
              ? Uint8Array.from(bytes, (value, index) => (index === 0 ? value ^ 1 : value))
              : bytes,
          );
          fixture.onCommit?.();
          return { opaqueReference: reference };
        },
        abort() {
          fixture.aborts += 1;
          staging.length = 0;
        },
      };
    },
  };
  fixture.reader = {
    async describe(input) {
      const bytes = objects.get(input.opaqueReference);
      if (!bytes) return null;
      return {
        byteSize: bytes.byteLength,
        versionToken: "immutable-v1",
        immutableReference: true,
        contentType: "application/octet-stream",
      };
    },
    async readRange(input) {
      fixture.readRanges.push([input.start, input.endInclusive]);
      const bytes = objects.get(input.opaqueReference);
      if (!bytes) return null;
      return {
        bytes: bytes.slice(input.start, input.endInclusive + 1),
        versionToken: "immutable-v1",
      };
    },
  };
  return fixture;
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
