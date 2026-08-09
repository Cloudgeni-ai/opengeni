import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BoundedObjectReadError,
  createObjectStorageBoundedPorts,
  type BoundedImmutableObjectWritePort,
  type BoundedObjectReadPort,
  type ObjectStorage,
} from "@opengeni/storage";

import {
  EditableArtifactMaterializerPermanentError,
  mimeTypeForFormat,
  type EditableArtifactMaterializationFormat,
  type EditableArtifactMaterializationMimeType,
  type EditableArtifactMaterializationSemanticVerifierPort,
  type EditableArtifactMaterializationVerifierPort,
  type VerifiedEditableArtifactMaterialization,
} from "./editable-artifact-materializer";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SNAPSHOT_KEY_PREFIX = "editable-artifacts/snapshots/sha256/";
const MATERIALIZATION_KEY_PREFIX = "editable-artifacts/materializations/v1/sha256/";
const SEMANTIC_VERIFIER_CHUNK_BYTES = 1024 * 1024;
const ZIP_EOCD_SEARCH_BYTES = 65_557;
const MAX_ZIP_ENTRY_NAME_BYTES = 4_096;
const MAX_ZIP_TOTAL_NAME_BYTES = 16 * 1024 * 1024;

/** Provider-versioned, immutable range reader. No whole-object fallback. */
export function createEditableArtifactObjectStorageReader(
  storage: ObjectStorage,
): BoundedObjectReadPort {
  return createObjectStorageBoundedPorts(storage, { keyPrefix: SNAPSHOT_KEY_PREFIX }).read;
}

/** Conditional-create digest writer with independent version-pinned readback. */
export function createEditableArtifactObjectStorageWriter(
  storage: ObjectStorage,
): BoundedImmutableObjectWritePort {
  return createObjectStorageBoundedPorts(storage, {
    keyPrefix: MATERIALIZATION_KEY_PREFIX,
  }).write;
}

/**
 * Independent immutable readback + structural parser. When the native source
 * projection supplies a semantic digest, a second isolated codec process must
 * re-import the published Office bytes and prove that digest before success.
 */
export function createEditableArtifactObjectStorageVerifier(
  storage: ObjectStorage,
  semanticVerifier: EditableArtifactMaterializationSemanticVerifierPort,
): EditableArtifactMaterializationVerifierPort {
  const read = createObjectStorageBoundedPorts(storage, {
    keyPrefix: MATERIALIZATION_KEY_PREFIX,
  }).read;
  return Object.freeze({
    async verify(
      input: Parameters<EditableArtifactMaterializationVerifierPort["verify"]>[0],
    ): Promise<VerifiedEditableArtifactMaterialization> {
      validateReference(input.objectReference);
      validateLimit(input.maxBytes);
      if (
        !Number.isSafeInteger(input.expectedByteSize) ||
        input.expectedByteSize <= 0 ||
        input.expectedByteSize > input.maxBytes ||
        !SHA256.test(input.expectedContentHash)
      ) {
        throw new BoundedObjectReadError("invalid_request");
      }
      throwIfAborted(input.signal);
      const stagingDirectory = await mkdtemp(join(tmpdir(), "opengeni-artifact-verify-"));
      const stagingPath = join(stagingDirectory, "payload");
      let stagingHandle: FileHandle | null = null;
      try {
        await chmod(stagingDirectory, 0o700);
        stagingHandle = await open(stagingPath, "wx", 0o600);
        const reader = await read.open({
          opaqueReference: input.objectReference,
          maxBytes: input.maxBytes,
          expectedByteSize: input.expectedByteSize,
          signal: input.signal,
        });
        try {
          if (reader.contentType !== undefined && reader.contentType !== input.expectedMimeType) {
            throw new BoundedObjectReadError("object_changed");
          }
          const digest = createHash("sha256");
          let offset = 0;
          for await (const chunk of reader.chunks({ signal: input.signal })) {
            if (offset + chunk.byteLength > input.expectedByteSize) {
              throw new BoundedObjectReadError("object_changed");
            }
            await writeAll(stagingHandle, chunk, offset);
            digest.update(chunk);
            offset += chunk.byteLength;
          }
          if (
            offset !== input.expectedByteSize ||
            `sha256:${digest.digest("hex")}` !== input.expectedContentHash
          ) {
            throw new BoundedObjectReadError("object_changed");
          }
          await reader.assertUnchanged(input.signal);
        } finally {
          await reader.close();
        }
        await stagingHandle.close();
        stagingHandle = null;
        await verifyFormat(
          stagingPath,
          input.expectedByteSize,
          input.format,
          input.expectedMimeType,
          input.signal,
        );
        try {
          await semanticVerifier.verify({
            format: input.format,
            codecId: input.codecId,
            codecVersion: input.codecVersion,
            expectedSemanticHash: input.expectedSemanticHash,
            byteSize: input.expectedByteSize,
            chunks: fileChunks(stagingPath, input.expectedByteSize, input.signal),
            signal: input.signal,
          });
        } catch (error) {
          throwIfAborted(input.signal);
          preserveKernelCompatibilityFailure(error);
          throw new BoundedObjectReadError("object_changed");
        }
        throwIfAborted(input.signal);
        return Object.freeze({
          objectReference: input.objectReference,
          byteSize: input.expectedByteSize,
          contentHash: input.expectedContentHash,
          mimeType: input.expectedMimeType,
          format: input.format,
          codecId: input.codecId,
          codecVersion: input.codecVersion,
        });
      } finally {
        if (stagingHandle) await stagingHandle.close().catch(() => undefined);
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    },
  });
}

async function verifyFormat(
  path: string,
  byteSize: number,
  format: EditableArtifactMaterializationFormat,
  mimeType: EditableArtifactMaterializationMimeType,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (mimeType !== mimeTypeForFormat(format)) {
    throw new BoundedObjectReadError("object_changed");
  }
  const handle = await open(path, "r");
  try {
    throwIfAborted(signal);
    switch (format) {
      case "xlsx":
        await assertOfficePackage(handle, byteSize, "xl/workbook.xml", signal);
        break;
      case "pptx":
        await assertOfficePackage(handle, byteSize, "ppt/presentation.xml", signal);
        break;
      case "docx":
        await assertOfficePackage(handle, byteSize, "word/document.xml", signal);
        break;
      case "pdf": {
        const start = await readExact(handle, 0, 5);
        const end = await readExact(handle, byteSize - 5, 5);
        if (!startsWithAscii(start, "%PDF-") || !startsWithAscii(end, "%%EOF")) {
          throw new Error("invalid PDF framing");
        }
        break;
      }
      case "png":
        if (
          !equalPrefix(
            await readExact(handle, 0, 8),
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          )
        ) {
          throw new Error("invalid PNG signature");
        }
        break;
      case "webp": {
        const header = await readExact(handle, 0, 12);
        if (!startsWithAscii(header, "RIFF") || !asciiAt(header, 8, "WEBP")) {
          throw new Error("invalid WebP signature");
        }
        break;
      }
    }
  } catch {
    throwIfAborted(signal);
    throw new BoundedObjectReadError("object_changed");
  } finally {
    await handle.close();
  }
}

async function assertOfficePackage(
  handle: FileHandle,
  byteSize: number,
  requiredPart: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!equalPrefix(await readExact(handle, 0, 4), [0x50, 0x4b, 0x03, 0x04])) {
    throw new Error("invalid ZIP");
  }
  const tailSize = Math.min(byteSize, ZIP_EOCD_SEARCH_BYTES);
  const tail = await readExact(handle, byteSize - tailSize, tailSize);
  const eocdInTail = findEndOfCentralDirectory(tail);
  const eocd = byteSize - tailSize + eocdInTail;
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const disk = view.getUint16(eocdInTail + 4, true);
  const centralDisk = view.getUint16(eocdInTail + 6, true);
  const diskEntries = view.getUint16(eocdInTail + 8, true);
  const entries = view.getUint16(eocdInTail + 10, true);
  const centralSize = view.getUint32(eocdInTail + 12, true);
  const centralOffset = view.getUint32(eocdInTail + 16, true);
  const commentLength = view.getUint16(eocdInTail + 20, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entries ||
    entries === 0 ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocd + 22 + commentLength !== byteSize ||
    centralOffset + centralSize !== eocd ||
    centralOffset > byteSize
  ) {
    throw new Error("invalid ZIP central directory");
  }
  const names = new Set<string>();
  let offset = centralOffset;
  let totalNameBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    throwIfAborted(signal);
    if (offset + 46 > eocd) {
      throw new Error("invalid ZIP entry");
    }
    const header = await readExact(handle, offset, 46);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (headerView.getUint32(0, true) !== 0x02014b50) throw new Error("invalid ZIP entry");
    if ((headerView.getUint16(8, true) & 1) !== 0) throw new Error("encrypted ZIP entry");
    const nameLength = headerView.getUint16(28, true);
    const extraLength = headerView.getUint16(30, true);
    const commentBytes = headerView.getUint16(32, true);
    const next = offset + 46 + nameLength + extraLength + commentBytes;
    totalNameBytes += nameLength;
    if (
      nameLength === 0 ||
      nameLength > MAX_ZIP_ENTRY_NAME_BYTES ||
      totalNameBytes > MAX_ZIP_TOTAL_NAME_BYTES ||
      next > eocd
    ) {
      throw new Error("truncated ZIP entry");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      await readExact(handle, offset + 46, nameLength),
    );
    if (!isSafeZipEntryName(name) || names.has(name)) {
      throw new Error("unsafe ZIP entry name");
    }
    names.add(name);
    offset = next;
  }
  if (offset !== eocd || !names.has("[Content_Types].xml") || !names.has(requiredPart)) {
    throw new Error("Office package is missing required parts");
  }
}

function isSafeZipEntryName(name: string): boolean {
  if (name.startsWith("/") || name.includes("\\")) return false;
  const segments = name.split("/");
  // Office writers commonly include explicit directory entries. A single
  // trailing slash is canonical for those entries; empty interior segments
  // remain forbidden so no alternate path spelling reaches a parser.
  if (segments.at(-1) === "") segments.pop();
  return (
    segments.length > 0 &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    )
      return offset;
  }
  throw new Error("missing ZIP EOCD");
}

async function* fileChunks(
  path: string,
  byteSize: number,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<Uint8Array> {
  const handle = await open(path, "r");
  try {
    let offset = 0;
    const buffer = new Uint8Array(SEMANTIC_VERIFIER_CHUNK_BYTES);
    while (offset < byteSize) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, byteSize - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new BoundedObjectReadError("object_changed");
      offset += bytesRead;
      yield buffer.slice(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (bytesWritten <= 0) throw new BoundedObjectReadError("object_changed");
    offset += bytesWritten;
  }
}

async function readExact(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new Error("invalid file range");
  }
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(result, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw new Error("truncated file range");
    offset += bytesRead;
  }
  return result;
}

function validateReference(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new BoundedObjectReadError("invalid_request");
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BoundedObjectReadError("invalid_request");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BoundedObjectReadError("aborted");
}

function preserveKernelCompatibilityFailure(error: unknown): void {
  if (
    error instanceof EditableArtifactMaterializerPermanentError &&
    error.code === "kernel_incompatible"
  ) {
    throw error;
  }
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return asciiAt(bytes, 0, value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function equalPrefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}
