import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  BoundedObjectReadError,
  BoundedObjectWriteError,
  createObjectStorageBoundedPorts,
  type ObjectHead,
  type ObjectStorage,
} from "../src";

const SNAPSHOT_TYPE = "application/vnd.opengeni.editable-artifact-snapshot";

describe("ObjectStorage bounded immutable ports", () => {
  test("writes by digest and independently version-pins exact range readback", async () => {
    const fixture = memoryStorage();
    const ports = createObjectStorageBoundedPorts(fixture.storage);
    const bytes = new TextEncoder().encode("canonical native snapshot");
    const contentHash = sha256(bytes);
    const result = await ports.write.write({
      chunks: chunks(bytes, 7),
      contentType: SNAPSHOT_TYPE,
      maxBytes: 1_024,
      expectedByteSize: bytes.byteLength,
      expectedContentHash: contentHash,
    });
    expect(result).toEqual({
      opaqueReference: `editable-artifacts/snapshots/sha256/${contentHash.slice(7)}`,
      byteSize: bytes.byteLength,
      contentHash,
      contentType: SNAPSHOT_TYPE,
    });
    expect(fixture.acceptedCreates).toBe(1);

    const reader = await ports.read.open({
      opaqueReference: result.opaqueReference,
      maxBytes: 1_024,
      expectedByteSize: bytes.byteLength,
    });
    const read: Uint8Array[] = [];
    for await (const chunk of reader.chunks({ chunkBytes: 5 })) read.push(chunk);
    await reader.assertUnchanged();
    await reader.close();
    expect(concatenate(read)).toEqual(bytes);
  });

  test("rejects a digest reference whose immutable metadata does not match", async () => {
    const fixture = memoryStorage();
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = sha256(bytes);
    fixture.seed(
      `editable-artifacts/snapshots/sha256/${digest.slice(7)}`,
      bytes,
      SNAPSHOT_TYPE,
      `sha256:${"0".repeat(64)}`,
    );
    const ports = createObjectStorageBoundedPorts(fixture.storage);
    await expect(
      ports.read.open({
        opaqueReference: `editable-artifacts/snapshots/sha256/${digest.slice(7)}`,
        maxBytes: 100,
      }),
    ).rejects.toBeInstanceOf(BoundedObjectReadError);
  });

  test("never overwrites a concurrent digest-key winner with conflicting metadata", async () => {
    const fixture = memoryStorage();
    const ports = createObjectStorageBoundedPorts(fixture.storage);
    const bytes = new TextEncoder().encode("same digest, one immutable generation");
    const contentHash = sha256(bytes);
    const writes = await Promise.allSettled([
      ports.write.write({
        chunks: chunks(bytes, bytes.byteLength),
        contentType: SNAPSHOT_TYPE,
        maxBytes: 1_024,
        expectedContentHash: contentHash,
      }),
      ports.write.write({
        chunks: chunks(bytes, bytes.byteLength),
        contentType: "application/x-conflicting-snapshot",
        maxBytes: 1_024,
        expectedContentHash: contentHash,
      }),
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (writes.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(BoundedObjectWriteError);
    expect(fixture.acceptedCreates).toBe(1);
  });

  test("streams a large immutable object to the provider in fixed-size chunks", async () => {
    const fixture = memoryStorage();
    const ports = createObjectStorageBoundedPorts(fixture.storage);
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17);
    crypto.getRandomValues(bytes.subarray(0, 65_536));
    await ports.write.write({
      chunks: chunks(bytes, 64 * 1024),
      contentType: SNAPSHOT_TYPE,
      maxBytes: bytes.byteLength,
      expectedByteSize: bytes.byteLength,
      expectedContentHash: sha256(bytes),
    });

    expect(fixture.providerChunks).toBeGreaterThan(3);
    expect(fixture.maximumProviderChunkBytes).toBeLessThanOrEqual(1024 * 1024);
  });
});

function memoryStorage(): {
  storage: ObjectStorage;
  readonly acceptedCreates: number;
  readonly providerChunks: number;
  readonly maximumProviderChunkBytes: number;
  seed(key: string, bytes: Uint8Array, contentType: string, contentHash: string): void;
} {
  type Entry = {
    bytes: Uint8Array;
    contentType: string;
    contentHash: string;
    version: string;
  };
  const entries = new Map<string, Entry>();
  let generation = 0;
  let acceptedCreates = 0;
  let providerChunks = 0;
  let maximumProviderChunkBytes = 0;
  const partial = {
    async headObject(key: string): Promise<ObjectHead | null> {
      const entry = entries.get(key);
      return entry
        ? {
            ContentLength: entry.bytes.byteLength,
            ContentType: entry.contentType,
            Metadata: { sha256: entry.contentHash },
            VersionToken: entry.version,
          }
        : null;
    },
    async getObjectRange(input: {
      key: string;
      start: number;
      endInclusive: number;
      expectedVersionToken: string;
    }) {
      const entry = entries.get(input.key);
      if (!entry || entry.version !== input.expectedVersionToken) return null;
      return {
        bytes: entry.bytes.slice(input.start, input.endInclusive + 1),
        versionToken: entry.version,
      };
    },
    async putObjectStreamIfAbsent(input: {
      key: string;
      contentType: string;
      chunks: AsyncIterable<Uint8Array>;
      byteSize: number;
      sha256: string;
    }) {
      const body = await consume(input.chunks, (chunk) => {
        providerChunks += 1;
        maximumProviderChunkBytes = Math.max(maximumProviderChunkBytes, chunk.byteLength);
      });
      if (body.byteLength !== input.byteSize) throw new Error("stream size mismatch");
      if (entries.has(input.key)) return false;
      generation += 1;
      acceptedCreates += 1;
      entries.set(input.key, {
        bytes: body,
        contentType: input.contentType,
        contentHash: input.sha256,
        version: `generation:${generation}`,
      });
      return true;
    },
  };
  return {
    storage: partial as unknown as ObjectStorage,
    get acceptedCreates() {
      return acceptedCreates;
    },
    get providerChunks() {
      return providerChunks;
    },
    get maximumProviderChunkBytes() {
      return maximumProviderChunkBytes;
    },
    seed(key, bytes, contentType, contentHash) {
      generation += 1;
      entries.set(key, {
        bytes: bytes.slice(),
        contentType,
        contentHash,
        version: `generation:${generation}`,
      });
    },
  };
}

async function* chunks(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.slice(offset, Math.min(bytes.byteLength, offset + size));
  }
}

async function consume(
  source: AsyncIterable<Uint8Array>,
  inspect: (chunk: Uint8Array) => void = () => undefined,
): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  for await (const value of source) {
    inspect(value);
    values.push(value);
  }
  return concatenate(values);
}

function concatenate(segments: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(segments.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of segments) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
