export type BoundedZipEntry = {
  name: string;
  flags: number;
  compression: 0 | 8;
  checksum: number;
  compressedSize: number;
  expandedSize: number;
  localHeaderOffset: number;
  dataStart: number;
  dataEnd: number;
  recordEnd: number;
  directory: boolean;
};

export type BoundedZipLimits = {
  entries: number;
  compressedEntryBytes: number;
  expandedEntryBytes: number;
  expandedBytes: number;
  compressionRatio: number;
  compressionRatioThreshold?: number;
};

export type BoundedZipFailure = (
  kind: "invalid" | "unsupported" | "encrypted" | "limit" | "platform",
  message: string,
  entryName?: string,
) => never;

/** Parses ZIP metadata and validates every local record without inflating payloads. */
export function parseBoundedZip(
  bytes: Uint8Array,
  limits: BoundedZipLimits,
  fail: BoundedZipFailure,
): BoundedZipEntry[] {
  if (bytes.byteLength < 22) fail("invalid", "ZIP end record is missing");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view, fail);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    fail("unsupported", "Multi-disk ZIP archives are unsupported");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail("unsupported", "ZIP64 archives are unsupported");
  }
  if (entryCount > limits.entries) fail("limit", "ZIP exceeds its entry limit");
  if (centralOffset + centralSize !== end || centralOffset > bytes.byteLength) {
    fail("invalid", "ZIP central-directory bounds are invalid");
  }
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    fail("unsupported", "ZIP64 archives are unsupported");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set<string>();
  const entries: BoundedZipEntry[] = [];
  let offset = centralOffset;
  let expandedBytes = 0;
  let compressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(bytes, offset, 46, fail, "ZIP central-directory entry");
    if (view.getUint32(offset, true) !== 0x02014b50) {
      fail("invalid", "ZIP central-directory signature is invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const expandedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const startDisk = view.getUint16(offset + 34, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    ensureRange(bytes, offset, recordLength, fail, "ZIP central-directory entry");
    if (offset + recordLength > centralOffset + centralSize) {
      fail("invalid", "ZIP central-directory entry is out of bounds");
    }
    if (startDisk !== 0) fail("unsupported", "Multi-disk ZIP entries are unsupported");
    if ((flags & 0x0041) !== 0) fail("encrypted", "Encrypted ZIP entries are unsupported");
    if ((flags & ~0x080e) !== 0 || (compression === 0 && (flags & 0x0006) !== 0)) {
      fail("unsupported", "ZIP entry flags are unsupported");
    }
    if (compression !== 0 && compression !== 8) {
      fail("unsupported", `ZIP compression method ${compression} is unsupported`);
    }
    if (
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      fail("unsupported", "ZIP64 entries are unsupported");
    }
    rejectZip64Extra(
      bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
      fail,
    );
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      fail("invalid", "ZIP entry name is not valid UTF-8");
    }
    validatePath(name, fail);
    const collisionKey = name.normalize("NFC").toLowerCase();
    if (names.has(collisionKey))
      fail("invalid", "ZIP contains duplicate normalized entry names", name);
    names.add(collisionKey);
    if (compressedSize > limits.compressedEntryBytes)
      fail("limit", "ZIP entry exceeds its compressed-size limit", name);
    if (expandedSize > limits.expandedEntryBytes)
      fail("limit", "ZIP entry exceeds its expanded-size limit", name);
    if (compressedSize === 0 && expandedSize !== 0)
      fail("invalid", "ZIP entry has impossible sizes", name);
    if (
      expandedSize > (limits.compressionRatioThreshold ?? 0) &&
      expandedSize / Math.max(1, compressedSize) > limits.compressionRatio
    )
      fail("limit", "ZIP entry exceeds its compression-ratio limit", name);
    expandedBytes += expandedSize;
    compressedBytes += compressedSize;
    if (expandedBytes > limits.expandedBytes) fail("limit", "ZIP exceeds its expanded-size limit");
    if (
      expandedBytes > (limits.compressionRatioThreshold ?? 0) &&
      expandedBytes / Math.max(1, compressedBytes) > limits.compressionRatio
    ) {
      fail("limit", "ZIP exceeds its aggregate compression-ratio limit", name);
    }

    const entry = localBounds(
      bytes,
      view,
      decoder,
      {
        name,
        flags,
        compression,
        checksum,
        compressedSize,
        expandedSize,
        localHeaderOffset,
        directory: name.endsWith("/"),
      },
      centralOffset,
      fail,
    );
    entries.push(entry);
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize)
    fail("invalid", "ZIP central-directory size is inconsistent");
  const localOrder = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  for (let index = 1; index < localOrder.length; index += 1) {
    const previous = localOrder[index - 1]!;
    const current = localOrder[index]!;
    if (previous.recordEnd > current.localHeaderOffset) {
      fail("invalid", `ZIP local entries overlap: ${previous.name}`, current.name);
    }
  }
  return entries;
}

async function consumeZipEntry(
  archive: Uint8Array,
  entry: BoundedZipEntry,
  maximumBytes: number,
  fail: BoundedZipFailure,
  collect: boolean,
): Promise<Uint8Array | undefined> {
  if (entry.expandedSize > maximumBytes) {
    fail("limit", "ZIP entry exceeds its configured expanded-size limit", entry.name);
  }
  const compressed = archive.subarray(entry.dataStart, entry.dataEnd);
  if (entry.compression === 0) {
    if (compressed.byteLength !== entry.expandedSize || zipCrc32(compressed) !== entry.checksum) {
      fail("invalid", "ZIP entry failed size or checksum validation", entry.name);
    }
    return collect ? compressed.slice() : undefined;
  }
  if (typeof DecompressionStream === "undefined") {
    return inflateWithNode(compressed, entry, fail, collect);
  }
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([Uint8Array.from(compressed)])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
  } catch {
    return inflateWithNode(compressed, entry, fail, collect);
  }
  const output = collect ? new Uint8Array(entry.expandedSize) : undefined;
  const reader = stream.getReader();
  let offset = 0;
  let checksum = 0xffffffff;
  try {
    while (true) {
      const result = await reader
        .read()
        .catch(() => fail("invalid", "DEFLATE stream is invalid", entry.name));
      if (result.done) break;
      if (offset + result.value.byteLength > entry.expandedSize) {
        await reader.cancel().catch(() => undefined);
        fail("limit", "Inflated ZIP entry exceeds its declared or configured size", entry.name);
      }
      output?.set(result.value, offset);
      offset += result.value.byteLength;
      checksum = zipCrc32Update(checksum, result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== entry.expandedSize || (checksum ^ 0xffffffff) >>> 0 !== entry.checksum) {
    fail("invalid", "ZIP entry failed size or checksum validation", entry.name);
  }
  return output;
}

async function inflateWithNode(
  compressed: Uint8Array,
  entry: BoundedZipEntry,
  fail: BoundedZipFailure,
  collect: boolean,
): Promise<Uint8Array | undefined> {
  if (typeof process === "undefined" || !process.versions?.node) {
    fail("platform", "Raw DEFLATE is unavailable", entry.name);
  }
  try {
    const { inflateRawSync } = await loadNodeZlib();
    const output = inflateRawSync(compressed, { maxOutputLength: entry.expandedSize });
    if (output.byteLength !== entry.expandedSize || zipCrc32(output) !== entry.checksum) {
      fail("invalid", "ZIP entry failed size or checksum validation", entry.name);
    }
    return collect ? Uint8Array.from(output) : undefined;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      fail("limit", "Inflated ZIP entry exceeds its declared or configured size", entry.name);
    }
    fail("invalid", "DEFLATE stream is invalid", entry.name);
  }
}

async function loadNodeZlib(): Promise<typeof import("node:zlib")> {
  // Literal dynamic imports are still resolved and polyfilled by browser
  // bundlers. Keep the fallback available to Node/Bun without granting the
  // browser codec graph an eager Node compatibility closure.
  return importRuntimeModule<typeof import("node:zlib")>("node:zlib");
}

function importRuntimeModule<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

export async function inflateBoundedZipEntry(
  archive: Uint8Array,
  entry: BoundedZipEntry,
  maximumBytes: number,
  fail: BoundedZipFailure,
): Promise<Uint8Array> {
  return (await consumeZipEntry(archive, entry, maximumBytes, fail, true))!;
}

export async function verifyBoundedZipEntry(
  archive: Uint8Array,
  entry: BoundedZipEntry,
  maximumBytes: number,
  fail: BoundedZipFailure,
): Promise<void> {
  await consumeZipEntry(archive, entry, maximumBytes, fail, false);
}

function findEndRecord(view: DataView, fail: BoundedZipFailure): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === view.byteLength
    )
      return offset;
  }
  return fail("invalid", "ZIP end record is missing");
}

function localBounds(
  bytes: Uint8Array,
  view: DataView,
  decoder: TextDecoder,
  entry: Omit<BoundedZipEntry, "dataStart" | "dataEnd" | "recordEnd">,
  centralOffset: number,
  fail: BoundedZipFailure,
): BoundedZipEntry {
  const header = entry.localHeaderOffset;
  ensureRange(bytes, header, 30, fail, "ZIP local header", entry.name);
  if (header + 30 > centralOffset || view.getUint32(header, true) !== 0x04034b50) {
    fail("invalid", "ZIP local-file header is invalid", entry.name);
  }
  const flags = view.getUint16(header + 6, true);
  const compression = view.getUint16(header + 8, true);
  if (flags !== entry.flags || compression !== entry.compression) {
    fail("invalid", "ZIP local and central entry metadata disagree", entry.name);
  }
  const checksum = view.getUint32(header + 14, true);
  const compressedSize = view.getUint32(header + 18, true);
  const expandedSize = view.getUint32(header + 22, true);
  const descriptor = (entry.flags & 0x0008) !== 0;
  if (
    (!descriptor &&
      (checksum !== entry.checksum ||
        compressedSize !== entry.compressedSize ||
        expandedSize !== entry.expandedSize)) ||
    (descriptor &&
      ((checksum !== 0 && checksum !== entry.checksum) ||
        (compressedSize !== 0 && compressedSize !== entry.compressedSize) ||
        (expandedSize !== 0 && expandedSize !== entry.expandedSize)))
  )
    fail("invalid", "ZIP local and central sizes or checksum disagree", entry.name);
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const nameStart = header + 30;
  const nameEnd = nameStart + nameLength;
  ensureRange(
    bytes,
    header,
    30 + nameLength + extraLength + entry.compressedSize,
    fail,
    "ZIP local entry",
    entry.name,
  );
  let localName: string;
  try {
    localName = decoder.decode(bytes.subarray(nameStart, nameEnd));
  } catch {
    fail("invalid", "ZIP local entry name is not valid UTF-8", entry.name);
  }
  if (localName !== entry.name)
    fail("invalid", "ZIP local and central entry names disagree", entry.name);
  const dataStart = nameEnd + extraLength;
  const payloadEnd = dataStart + entry.compressedSize;
  rejectZip64Extra(bytes.subarray(nameEnd, dataStart), fail, entry.name);
  let recordEnd = payloadEnd;
  if (descriptor) recordEnd = validateDescriptor(bytes, view, recordEnd, entry, fail);
  if (dataStart < nameEnd || recordEnd > centralOffset) {
    fail("invalid", "ZIP entry data is outside the local-file area", entry.name);
  }
  if (entry.directory && (entry.compressedSize !== 0 || entry.expandedSize !== 0)) {
    fail("invalid", "ZIP directory entry contains data", entry.name);
  }
  return { ...entry, dataStart, dataEnd: payloadEnd, recordEnd };
}

function validateDescriptor(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  entry: Omit<BoundedZipEntry, "dataStart" | "dataEnd" | "recordEnd">,
  fail: BoundedZipFailure,
): number {
  ensureRange(bytes, offset, 12, fail, "ZIP data descriptor", entry.name);
  const matches = (start: number): boolean =>
    start + 12 <= bytes.byteLength &&
    view.getUint32(start, true) === entry.checksum &&
    view.getUint32(start + 4, true) === entry.compressedSize &&
    view.getUint32(start + 8, true) === entry.expandedSize;
  if (matches(offset)) return offset + 12;
  if (view.getUint32(offset, true) === 0x08074b50 && matches(offset + 4)) return offset + 16;
  return fail("invalid", "ZIP data descriptor disagrees with central directory", entry.name);
}

function rejectZip64Extra(extra: Uint8Array, fail: BoundedZipFailure, entryName?: string): void {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) fail("invalid", "ZIP extra field is malformed", entryName);
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (offset + 4 + size > extra.byteLength)
      fail("invalid", "ZIP extra field is malformed", entryName);
    if (id === 0x0001) fail("unsupported", "ZIP64 entries are unsupported", entryName);
    offset += 4 + size;
  }
}

function validatePath(name: string, fail: BoundedZipFailure): void {
  if (
    name.length === 0 ||
    name.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    /%(?:2e|2f|5c)/i.test(name)
  )
    fail("invalid", "ZIP entry path is unsafe", name);
  const segments = name.split("/");
  if (
    segments.some(
      (segment, index) =>
        segment === "." || segment === ".." || (segment === "" && index !== segments.length - 1),
    )
  ) {
    fail("invalid", "ZIP entry path is unsafe", name);
  }
}

function ensureRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  fail: BoundedZipFailure,
  description: string,
  entryName?: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    fail("invalid", `${description} is out of bounds`, entryName);
  }
}

let crcTable: Uint32Array | undefined;

export function zipCrc32Update(initial: number, bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1)
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let value = initial;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return value >>> 0;
}

export function zipCrc32(bytes: Uint8Array): number {
  return (zipCrc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
