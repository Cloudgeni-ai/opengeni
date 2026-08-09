import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  BoundedObjectReadError,
  BoundedObjectWriteError,
  type ObjectStorage,
} from "@opengeni/storage";

import {
  createEditableArtifactObjectStorageReader,
  createEditableArtifactObjectStorageVerifier,
  createEditableArtifactObjectStorageWriter,
} from "../src/editable-artifact-materializer-storage";
import { EditableArtifactMaterializerPermanentError } from "../src/editable-artifact-materializer";

describe("editable artifact materializer object storage", () => {
  test("writes by digest, reads back, and independently verifies an Office package", async () => {
    const storage = memoryStorage();
    const writer = createEditableArtifactObjectStorageWriter(storage.port);
    const semanticCalls: Array<Record<string, unknown>> = [];
    const verifier = createEditableArtifactObjectStorageVerifier(storage.port, {
      async verify(input) {
        semanticCalls.push(input);
        expect(await consume(input.chunks)).toEqual(bytes);
      },
    });
    const bytes = minimalZip(["[Content_Types].xml", "xl/workbook.xml"]);
    const contentHash = hash(bytes);
    const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const written = await writer.write({
      chunks: chunks(bytes),
      contentType: mimeType,
      maxBytes: 1024 * 1024,
      expectedByteSize: bytes.byteLength,
      expectedContentHash: contentHash,
    });
    const verified = await verifier.verify({
      objectReference: written.opaqueReference,
      expectedByteSize: written.byteSize,
      expectedContentHash: written.contentHash,
      expectedMimeType: mimeType,
      format: "xlsx",
      codecId: "opengeni.xlsx",
      codecVersion: "1",
      expectedSemanticHash: hash(new TextEncoder().encode("semantic")),
      maxBytes: 1024 * 1024,
      signal: new AbortController().signal,
    });

    expect(written.opaqueReference).toBe(
      `editable-artifacts/materializations/v1/sha256/${contentHash.slice(7)}`,
    );
    expect(verified).toMatchObject({ byteSize: bytes.byteLength, contentHash, format: "xlsx" });
    expect(storage.puts).toBe(1);
    expect(semanticCalls).toHaveLength(1);
  });

  test("source reader enforces expected size and detects immutable replacement", async () => {
    const storage = memoryStorage();
    const bytes = new TextEncoder().encode("snapshot");
    const key = `editable-artifacts/snapshots/sha256/${hash(bytes).slice(7)}`;
    storage.seed(key, bytes, "snapshot/type", hash(bytes));
    const reader = createEditableArtifactObjectStorageReader(storage.port);
    const opened = await reader.open({
      opaqueReference: key,
      maxBytes: 100,
      expectedByteSize: bytes.byteLength,
    });
    expect(await consume(opened.chunks())).toEqual(bytes);
    storage.seed(key, new TextEncoder().encode("replaced"), "snapshot/type", hash(bytes));
    await expect(opened.assertUnchanged()).rejects.toBeInstanceOf(BoundedObjectReadError);
    await opened.close();
  });

  test("writer enforces its streaming output bound before conditional create", async () => {
    const storage = memoryStorage();
    const writer = createEditableArtifactObjectStorageWriter(storage.port);
    await expect(
      writer.write({
        chunks: chunks(new Uint8Array([1])),
        contentType: "application/pdf",
        maxBytes: 0,
      }),
    ).rejects.toBeInstanceOf(BoundedObjectWriteError);
    expect(storage.puts).toBe(0);
  });

  test("independent Office verifier rejects a package missing its modality root", async () => {
    const storage = memoryStorage();
    const bytes = minimalZip(["[Content_Types].xml", "word/document.xml"]);
    const key = `editable-artifacts/materializations/v1/sha256/${hash(bytes).slice(7)}`;
    storage.seed(
      key,
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      hash(bytes),
    );
    const verifier = createEditableArtifactObjectStorageVerifier(storage.port, {
      async verify() {
        throw new Error("structurally invalid output must not reach semantic verification");
      },
    });
    await expect(
      verifier.verify({
        objectReference: key,
        expectedByteSize: bytes.byteLength,
        expectedContentHash: hash(bytes),
        expectedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        format: "xlsx",
        codecId: "opengeni.xlsx",
        codecVersion: "1",
        expectedSemanticHash: hash(new TextEncoder().encode("semantic")),
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(BoundedObjectReadError);
  });

  test("rejects a format whose declared MIME type belongs to another Office modality", async () => {
    const storage = memoryStorage();
    const bytes = minimalZip(["[Content_Types].xml", "xl/workbook.xml"]);
    const contentHash = hash(bytes);
    const key = `editable-artifacts/materializations/v1/sha256/${contentHash.slice(7)}`;
    storage.seed(
      key,
      bytes,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentHash,
    );
    const verifier = createEditableArtifactObjectStorageVerifier(storage.port, {
      async verify() {
        throw new Error("MIME mismatch must not reach semantic verification");
      },
    });
    await expect(
      verifier.verify({
        objectReference: key,
        expectedByteSize: bytes.byteLength,
        expectedContentHash: contentHash,
        expectedMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        format: "xlsx",
        codecId: "opengeni.xlsx",
        codecVersion: "1",
        expectedSemanticHash: hash(new TextEncoder().encode("semantic")),
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(BoundedObjectReadError);
  });

  test("preserves an exact verifier kernel compatibility failure", async () => {
    const storage = memoryStorage();
    const bytes = minimalZip(["[Content_Types].xml", "xl/workbook.xml"]);
    const contentHash = hash(bytes);
    const key = `editable-artifacts/materializations/v1/sha256/${contentHash.slice(7)}`;
    const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    storage.seed(key, bytes, mimeType, contentHash);
    const verifier = createEditableArtifactObjectStorageVerifier(storage.port, {
      async verify() {
        throw new EditableArtifactMaterializerPermanentError("kernel_incompatible");
      },
    });
    await expect(
      verifier.verify({
        objectReference: key,
        expectedByteSize: bytes.byteLength,
        expectedContentHash: contentHash,
        expectedMimeType: mimeType,
        format: "xlsx",
        codecId: "opengeni.xlsx",
        codecVersion: "1",
        expectedSemanticHash: hash(new TextEncoder().encode("semantic")),
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "kernel_incompatible" });
  });

  test("streams large verified bytes to the isolated semantic verifier", async () => {
    const storage = memoryStorage();
    const bytes = new Uint8Array(3 * 1024 * 1024 + 5);
    bytes.set(new TextEncoder().encode("%PDF-"), 0);
    bytes.set(new TextEncoder().encode("%%EOF"), bytes.byteLength - 5);
    const contentHash = hash(bytes);
    const key = `editable-artifacts/materializations/v1/sha256/${contentHash.slice(7)}`;
    storage.seed(key, bytes, "application/pdf", contentHash);
    const chunkSizes: number[] = [];
    const verifier = createEditableArtifactObjectStorageVerifier(storage.port, {
      async verify(input) {
        for await (const chunk of input.chunks) chunkSizes.push(chunk.byteLength);
      },
    });

    await verifier.verify({
      objectReference: key,
      expectedByteSize: bytes.byteLength,
      expectedContentHash: contentHash,
      expectedMimeType: "application/pdf",
      format: "pdf",
      codecId: "opengeni.pdf",
      codecVersion: "1",
      expectedSemanticHash: hash(new TextEncoder().encode("semantic")),
      maxBytes: bytes.byteLength,
      signal: new AbortController().signal,
    });

    expect(chunkSizes.length).toBeGreaterThan(3);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(1024 * 1024);
  });
});

function memoryStorage() {
  const objects = new Map<
    string,
    {
      bytes: Uint8Array;
      contentType: string;
      contentHash: string;
      version: string;
    }
  >();
  let puts = 0;
  let generation = 0;
  const port = {
    async headObject(key: string) {
      const value = objects.get(key);
      return value
        ? {
            ContentLength: value.bytes.byteLength,
            ContentType: value.contentType,
            Metadata: { sha256: value.contentHash },
            VersionToken: value.version,
          }
        : null;
    },
    async getObjectRange(input: {
      key: string;
      start: number;
      endInclusive: number;
      expectedVersionToken: string;
    }) {
      const value = objects.get(input.key);
      if (!value || value.version !== input.expectedVersionToken) return null;
      return {
        bytes: value.bytes.slice(input.start, input.endInclusive + 1),
        versionToken: value.version,
      };
    },
    async putObjectStreamIfAbsent(input: {
      key: string;
      contentType: string;
      chunks: AsyncIterable<Uint8Array>;
      byteSize: number;
      sha256: string;
    }) {
      const body = await consume(input.chunks);
      if (body.byteLength !== input.byteSize) throw new Error("stream size mismatch");
      if (objects.has(input.key)) return false;
      puts += 1;
      generation += 1;
      objects.set(input.key, {
        bytes: body,
        contentType: input.contentType,
        contentHash: input.sha256,
        version: `generation:${generation}`,
      });
      return true;
    },
  } as unknown as ObjectStorage;
  return {
    objects,
    port,
    seed(key: string, bytes: Uint8Array, contentType: string, contentHash: string) {
      generation += 1;
      objects.set(key, {
        bytes: bytes.slice(),
        contentType,
        contentHash,
        version: `generation:${generation}`,
      });
    },
    get puts() {
      return puts;
    },
  };
}

async function* chunks(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
  yield bytes.slice(0, midpoint);
  if (midpoint < bytes.byteLength) yield bytes.slice(midpoint);
}

async function consume(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  let length = 0;
  for await (const value of source) {
    values.push(value);
    length += value.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function minimalZip(names: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    localOffset += local.byteLength;
  }
  const centralSize = centrals.reduce((sum, value) => sum + value.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, names.length, true);
  eocdView.setUint16(10, names.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localOffset, true);
  return concat([...locals, ...centrals, eocd]);
}

function concat(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
