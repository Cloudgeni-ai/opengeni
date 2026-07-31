import {
  COMPUTER_SCREENSHOT_MAX_BYTES,
  COMPUTER_SCREENSHOT_MAX_DIMENSION,
  COMPUTER_SCREENSHOT_MAX_PIXELS,
  COMPUTER_SCREENSHOT_RETENTION_MS,
  COMPUTER_SCREENSHOT_WORKSPACE_QUOTA_BYTES,
  RetainedArtifactMetadataSchema,
  retainedScreenshotReferenceFromFile,
  type RetainedArtifactMetadata,
  type RetainedArtifactReference,
  type RetainedOutputUnavailableReason,
} from "@opengeni/contracts";
import {
  RetainedScreenshotQuotaExceededError,
  getRetainedScreenshotArtifact,
  prepareRetainedScreenshotArtifact,
  recordRetainedScreenshotArtifactError,
  settleRetainedScreenshotArtifactReady,
  type Database,
  type RetainedScreenshotArtifact,
} from "@opengeni/db";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import { createHash } from "node:crypto";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_ALLOWED_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const PNG_MAX_CHUNKS = 16_384;
const RETAINED_IMAGE_MARKER = "retained_artifact";

export type TypedScreenshotToolOutput = {
  callId: string;
  toolOutputId: string;
  bytes: Uint8Array;
  mediaType: string;
};

export type ValidatedScreenshot = {
  bytes: Uint8Array;
  mediaType: "image/png";
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
};

export class ScreenshotValidationError extends Error {
  constructor(
    readonly reason: "invalid_content" | "oversized" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "ScreenshotValidationError";
  }
}

export class RetainedScreenshotUnavailableError extends Error {
  constructor(
    readonly artifactId: string,
    readonly reason: RetainedOutputUnavailableReason,
  ) {
    super(`Retained screenshot ${artifactId} is unavailable: ${reason}`);
    this.name = "RetainedScreenshotUnavailableError";
  }
}

/** Read the SDK's trusted typed image before event/history serialization. */
export function typedScreenshotFromSdkEvent(event: unknown): TypedScreenshotToolOutput | null {
  if (!event || typeof event !== "object") return null;
  const streamEvent = event as {
    type?: unknown;
    item?: {
      id?: unknown;
      type?: unknown;
      rawItem?: unknown;
      output?: unknown;
    };
  };
  if (streamEvent.type !== "run_item_stream_event") return null;
  const item = streamEvent.item;
  if (!item || item.type !== "tool_call_output_item") return null;
  const output = item.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const outputRecord = output as Record<string, unknown>;
  if (
    outputRecord.type !== "image" ||
    !outputRecord.image ||
    typeof outputRecord.image !== "object"
  ) {
    return null;
  }
  const image = outputRecord.image as Record<string, unknown>;
  if (!(image.data instanceof Uint8Array) || typeof image.mediaType !== "string") return null;
  const raw =
    item.rawItem && typeof item.rawItem === "object" && !Array.isArray(item.rawItem)
      ? (item.rawItem as Record<string, unknown>)
      : {};
  const callId = raw.callId ?? raw.call_id;
  if (typeof callId !== "string" || callId.length === 0) return null;
  const toolOutputId = raw.id ?? item.id ?? callId;
  if (typeof toolOutputId !== "string" || toolOutputId.length === 0) return null;
  return {
    callId,
    toolOutputId,
    bytes: image.data,
    mediaType: image.mediaType,
  };
}

/** Validate the complete canonical PNG and derive exact integrity metadata. */
export function validateComputerScreenshot(
  input: { bytes: Uint8Array; mediaType: string },
  limits: {
    maxBytes?: number;
    maxDimension?: number;
    maxPixels?: number;
  } = {},
): ValidatedScreenshot {
  const maxBytes = limits.maxBytes ?? COMPUTER_SCREENSHOT_MAX_BYTES;
  const maxDimension = limits.maxDimension ?? COMPUTER_SCREENSHOT_MAX_DIMENSION;
  const maxPixels = limits.maxPixels ?? COMPUTER_SCREENSHOT_MAX_PIXELS;
  if (input.mediaType !== "image/png") {
    throw new ScreenshotValidationError(
      "unsupported",
      "computer screenshot MIME must be image/png",
    );
  }
  if (input.bytes.byteLength === 0) {
    throw new ScreenshotValidationError("invalid_content", "computer screenshot is empty");
  }
  if (input.bytes.byteLength > maxBytes) {
    throw new ScreenshotValidationError(
      "oversized",
      `computer screenshot exceeds ${maxBytes} bytes`,
    );
  }
  if (input.bytes.byteLength < PNG_SIGNATURE.byteLength + 25) {
    throw new ScreenshotValidationError("invalid_content", "computer screenshot PNG is truncated");
  }
  for (let index = 0; index < PNG_SIGNATURE.byteLength; index += 1) {
    if (input.bytes[index] !== PNG_SIGNATURE[index]) {
      throw new ScreenshotValidationError(
        "invalid_content",
        "computer screenshot PNG signature is invalid",
      );
    }
  }

  let offset = PNG_SIGNATURE.byteLength;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  while (offset < input.bytes.byteLength) {
    chunks += 1;
    if (chunks > PNG_MAX_CHUNKS || offset + 12 > input.bytes.byteLength) {
      throw new ScreenshotValidationError(
        "invalid_content",
        "computer screenshot PNG chunk table is invalid",
      );
    }
    const length = readUint32(input.bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const crcOffset = dataEnd;
    const nextOffset = crcOffset + 4;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > input.bytes.byteLength) {
      throw new ScreenshotValidationError(
        "invalid_content",
        "computer screenshot PNG chunk is truncated",
      );
    }
    const type = asciiChunkType(input.bytes, typeOffset);
    const expectedCrc = readUint32(input.bytes, crcOffset);
    const actualCrc = crc32(input.bytes.subarray(typeOffset, dataEnd));
    if (expectedCrc !== actualCrc) {
      throw new ScreenshotValidationError(
        "invalid_content",
        `computer screenshot PNG ${type} CRC is invalid`,
      );
    }
    if (chunks === 1 && type !== "IHDR") {
      throw new ScreenshotValidationError(
        "invalid_content",
        "computer screenshot PNG must begin with IHDR",
      );
    }
    if (isCriticalChunk(type) && !PNG_ALLOWED_CRITICAL_CHUNKS.has(type)) {
      throw new ScreenshotValidationError(
        "invalid_content",
        `computer screenshot PNG has unsupported critical chunk ${type}`,
      );
    }

    if (type === "IHDR") {
      if (sawIhdr || length !== 13) {
        throw new ScreenshotValidationError(
          "invalid_content",
          "computer screenshot PNG IHDR is invalid",
        );
      }
      sawIhdr = true;
      width = readUint32(input.bytes, dataOffset);
      height = readUint32(input.bytes, dataOffset + 4);
      const bitDepth = input.bytes[dataOffset + 8];
      const colorType = input.bytes[dataOffset + 9];
      const compression = input.bytes[dataOffset + 10];
      const filter = input.bytes[dataOffset + 11];
      const interlace = input.bytes[dataOffset + 12];
      if (
        !validPngColorMode(bitDepth, colorType) ||
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        throw new ScreenshotValidationError(
          "invalid_content",
          "computer screenshot PNG IHDR fields are invalid",
        );
      }
      if (
        width <= 0 ||
        height <= 0 ||
        width > maxDimension ||
        height > maxDimension ||
        width * height > maxPixels
      ) {
        throw new ScreenshotValidationError(
          "oversized",
          "computer screenshot dimensions exceed policy",
        );
      }
    } else if (type === "IDAT") {
      if (!sawIhdr || sawIend || endedIdat || length === 0) {
        throw new ScreenshotValidationError(
          "invalid_content",
          "computer screenshot PNG IDAT ordering is invalid",
        );
      }
      sawIdat = true;
    } else if (sawIdat && type !== "IEND") {
      endedIdat = true;
    }

    if (type === "IEND") {
      if (!sawIhdr || !sawIdat || sawIend || length !== 0) {
        throw new ScreenshotValidationError(
          "invalid_content",
          "computer screenshot PNG IEND is invalid",
        );
      }
      sawIend = true;
      if (nextOffset !== input.bytes.byteLength) {
        throw new ScreenshotValidationError(
          "invalid_content",
          "computer screenshot PNG has trailing/polyglot bytes",
        );
      }
    }
    offset = nextOffset;
  }
  if (!sawIhdr || !sawIdat || !sawIend || offset !== input.bytes.byteLength) {
    throw new ScreenshotValidationError("invalid_content", "computer screenshot PNG is incomplete");
  }
  return {
    bytes: input.bytes,
    mediaType: "image/png",
    sizeBytes: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    width,
    height,
  };
}

export function retainedScreenshotIdentity(input: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  toolOutputId: string;
}): { artifactId: string; settlementKey: string } {
  const settlementKey = createHash("sha256")
    .update("opengeni:computer-screenshot:v1\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.turnId)
    .update("\0")
    .update(input.attemptId)
    .update("\0")
    .update(input.toolCallId)
    .update("\0")
    .update(input.toolOutputId)
    .digest("hex");
  const uuidBytes = Uint8Array.from(Buffer.from(settlementKey.slice(0, 32), "hex"));
  uuidBytes[6] = (uuidBytes[6]! & 0x0f) | 0x80;
  uuidBytes[8] = (uuidBytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(uuidBytes).toString("hex");
  return {
    artifactId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    settlementKey,
  };
}

export async function retainComputerScreenshot(input: {
  db: Database;
  objectStorage: ObjectStorage | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  output: TypedScreenshotToolOutput;
  now?: Date;
  retentionMs?: number;
  workspaceQuotaBytes?: number;
}): Promise<RetainedArtifactMetadata> {
  const identity = retainedScreenshotIdentity({
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    toolCallId: input.output.callId,
    toolOutputId: input.output.toolOutputId,
  });
  let screenshot: ValidatedScreenshot;
  try {
    screenshot = validateComputerScreenshot(input.output);
  } catch (error) {
    if (error instanceof ScreenshotValidationError) {
      return unavailable(identity.artifactId, error.reason);
    }
    throw error;
  }
  if (!input.objectStorage) return unavailable(identity.artifactId, "missing_storage");

  const now = input.now ?? new Date();
  const retentionExpiresAt = new Date(
    now.getTime() + (input.retentionMs ?? COMPUTER_SCREENSHOT_RETENTION_MS),
  );
  const objectKey = `workspaces/${input.workspaceId}/files/${identity.artifactId}/retained/computer-screenshot.png`;
  let prepared: RetainedScreenshotArtifact;
  try {
    prepared = (
      await prepareRetainedScreenshotArtifact(input.db, {
        artifactId: identity.artifactId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        attemptId: input.attemptId,
        settlementKey: identity.settlementKey,
        toolCallId: input.output.callId,
        toolOutputId: input.output.toolOutputId,
        mediaType: screenshot.mediaType,
        sizeBytes: screenshot.sizeBytes,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
        retentionExpiresAt,
        bucket: input.objectStorage.bucket,
        objectKey,
        workspaceQuotaBytes: input.workspaceQuotaBytes ?? COMPUTER_SCREENSHOT_WORKSPACE_QUOTA_BYTES,
      })
    ).artifact;
  } catch (error) {
    if (error instanceof RetainedScreenshotQuotaExceededError) {
      return unavailable(identity.artifactId, "quota_exceeded");
    }
    throw error;
  }

  if (prepared.status === "ready") {
    return (await verifyReadyArtifact(input.objectStorage, prepared))
      ? reference(prepared)
      : unavailable(identity.artifactId, "missing_storage");
  }
  if (prepared.status !== "pending" && prepared.status !== "reconciling") {
    return unavailable(identity.artifactId, unavailableReasonForStatus(prepared.status));
  }

  try {
    await input.objectStorage.putObject({
      key: objectKey,
      contentType: screenshot.mediaType,
      body: screenshot.bytes,
      sha256: screenshot.sha256,
    });
    const head = await input.objectStorage.headFile(prepared.file);
    assertStoredScreenshotHead(head, screenshot);
  } catch (error) {
    await recordRetainedScreenshotArtifactError(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      artifactId: identity.artifactId,
      settlementKey: identity.settlementKey,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return unavailable(identity.artifactId, "storage_write_failed");
  }

  try {
    const settled = await settleRetainedScreenshotArtifactReady(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      artifactId: identity.artifactId,
      settlementKey: identity.settlementKey,
    });
    return reference(settled);
  } catch (error) {
    // PUT completed. If a concurrent cascade removed the deterministic intent,
    // compensate the now-unreferenced key. Otherwise leave the pending row for
    // exact retry/background reconciliation instead of deleting live truth.
    const stillReferenced = await getRetainedScreenshotArtifact(
      input.db,
      input.workspaceId,
      input.sessionId,
      identity.artifactId,
    ).catch(() => undefined);
    if (
      stillReferenced === null ||
      stillReferenced?.status === "failed" ||
      stillReferenced?.status === "expired" ||
      stillReferenced?.status === "deleted"
    ) {
      await input.objectStorage.deleteObject(objectKey).catch(() => undefined);
    } else if (stillReferenced) {
      await recordRetainedScreenshotArtifactError(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        artifactId: identity.artifactId,
        settlementKey: identity.settlementKey,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    return unavailable(identity.artifactId, "pending");
  }
}

/** Replace only new screenshot bytes with a compact receipt before first persistence. */
export function compactRetainedScreenshotHistory(
  history: Array<Record<string, unknown>>,
  receiptsByCallId: ReadonlyMap<string, RetainedArtifactMetadata>,
): Array<Record<string, unknown>> {
  if (receiptsByCallId.size === 0) return history;
  return history.map((item) => {
    const callId = historyCallId(item);
    const receipt = callId ? receiptsByCallId.get(callId) : undefined;
    if (!receipt || !Array.isArray(item.output)) return item;
    let changed = false;
    const output = item.output.map((entry) => {
      if (!isInlineImageContent(entry)) return entry;
      changed = true;
      return {
        ...(entry as Record<string, unknown>),
        image: { type: RETAINED_IMAGE_MARKER, artifact: receipt },
      };
    });
    return changed ? { ...item, output } : item;
  });
}

/** Collect durable screenshot receipts before their provider-only expansion. */
export function collectRetainedScreenshotReceipts(
  history: ReadonlyArray<Record<string, unknown>>,
  target: Map<string, RetainedArtifactMetadata> = new Map(),
): Map<string, RetainedArtifactMetadata> {
  for (const item of history) {
    const callId = historyCallId(item);
    if (!callId || !Array.isArray(item.output)) continue;
    for (const entry of item.output) {
      const receipt = retainedReceiptFromImageContent(entry);
      if (receipt) {
        target.set(callId, receipt);
        break;
      }
    }
  }
  return target;
}

/**
 * Compact every protocol-item copy inside an SDK RunState before persistence.
 * The traversal intentionally mirrors the repository's existing serialized
 * RunState sanitizers. A parse failure or no-op returns the original string.
 */
export function compactRetainedScreenshotRunState(
  serialized: string,
  receiptsByCallId: ReadonlyMap<string, RetainedArtifactMetadata>,
): string {
  if (receiptsByCallId.size === 0) return serialized;
  const parsed = parseSerializedRunState(serialized);
  if (!parsed) return serialized;
  let changed = false;
  visitSerializedRunStateItemArrays(parsed, (items) => {
    const compacted = compactRetainedScreenshotHistory(items, receiptsByCallId);
    if (compacted !== items && compacted.some((item, index) => item !== items[index])) {
      items.splice(0, items.length, ...compacted);
      changed = true;
    }
  });
  return changed ? JSON.stringify(parsed) : serialized;
}

export function collectRetainedScreenshotRunStateReceipts(
  serialized: string,
  target: Map<string, RetainedArtifactMetadata> = new Map(),
): Map<string, RetainedArtifactMetadata> {
  const parsed = parseSerializedRunState(serialized);
  if (!parsed) return target;
  visitSerializedRunStateItemArrays(parsed, (items) => {
    collectRetainedScreenshotReceipts(items, target);
  });
  return target;
}

/**
 * Materialize canonical receipts to the exact SDK input_image data URL shape.
 * Missing/deleted/expired/corrupt bytes fail closed; no item is omitted,
 * reordered, rewritten in storage, or converted to text.
 */
export async function materializeRetainedScreenshotHistory(input: {
  db: Database;
  objectStorage: ObjectStorage | null;
  workspaceId: string;
  sessionId: string;
  history: Array<Record<string, unknown>>;
  now?: Date;
}): Promise<Array<Record<string, unknown>>> {
  return await materializeRetainedScreenshotHistoryWithCache(input, new Map());
}

/** Expand durable markers in an SDK RunState immediately before resume. */
export async function materializeRetainedScreenshotRunState(input: {
  db: Database;
  objectStorage: ObjectStorage | null;
  workspaceId: string;
  sessionId: string;
  serialized: string;
  now?: Date;
}): Promise<string> {
  const parsed = parseSerializedRunState(input.serialized);
  if (!parsed) return input.serialized;
  const cache = new Map<string, string>();
  let changed = false;
  await visitSerializedRunStateItemArraysAsync(parsed, async (items) => {
    const materialized = await materializeRetainedScreenshotHistoryWithCache(
      { ...input, history: items },
      cache,
    );
    if (materialized.some((item, index) => item !== items[index])) {
      items.splice(0, items.length, ...materialized);
      changed = true;
    }
  });
  return changed ? JSON.stringify(parsed) : input.serialized;
}

async function materializeRetainedScreenshotHistoryWithCache(
  input: {
    db: Database;
    objectStorage: ObjectStorage | null;
    workspaceId: string;
    sessionId: string;
    history: Array<Record<string, unknown>>;
    now?: Date;
  },
  cache: Map<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const now = input.now ?? new Date();
  const materializeEntry = async (entry: unknown): Promise<unknown> => {
    const receipt = retainedReceiptFromImageContent(entry);
    if (!receipt) return entry;
    if (!receipt.available) {
      throw new RetainedScreenshotUnavailableError(receipt.artifactId, receipt.reason);
    }
    let dataUrl = cache.get(receipt.artifactId);
    if (!dataUrl) {
      if (!input.objectStorage) {
        throw new RetainedScreenshotUnavailableError(receipt.artifactId, "missing_storage");
      }
      const artifact = await getRetainedScreenshotArtifact(
        input.db,
        input.workspaceId,
        input.sessionId,
        receipt.artifactId,
      );
      if (!artifact) throw new RetainedScreenshotUnavailableError(receipt.artifactId, "deleted");
      if (artifact.status !== "ready") {
        throw new RetainedScreenshotUnavailableError(
          receipt.artifactId,
          unavailableReasonForStatus(artifact.status),
        );
      }
      if (artifact.retentionExpiresAt.getTime() <= now.getTime()) {
        throw new RetainedScreenshotUnavailableError(receipt.artifactId, "expired");
      }
      const bytes = await input.objectStorage.getFileBytes(artifact.file).catch(() => null);
      if (!bytes)
        throw new RetainedScreenshotUnavailableError(receipt.artifactId, "missing_storage");
      const validated = validateComputerScreenshot({
        bytes,
        mediaType: artifact.mediaType,
      });
      if (
        validated.sizeBytes !== artifact.sizeBytes ||
        validated.sha256 !== artifact.sha256 ||
        validated.width !== artifact.width ||
        validated.height !== artifact.height ||
        receipt.sha256 !== artifact.sha256 ||
        receipt.originalBytes !== artifact.sizeBytes
      ) {
        throw new RetainedScreenshotUnavailableError(receipt.artifactId, "invalid_content");
      }
      dataUrl = `data:${validated.mediaType};base64,${Buffer.from(validated.bytes).toString("base64")}`;
      cache.set(receipt.artifactId, dataUrl);
    }
    return { ...(entry as Record<string, unknown>), image: dataUrl };
  };

  const materialized: Array<Record<string, unknown>> = [];
  for (const item of input.history) {
    if (!Array.isArray(item.output)) {
      materialized.push(item);
      continue;
    }
    let changed = false;
    const output: unknown[] = [];
    for (const entry of item.output) {
      const next = await materializeEntry(entry);
      changed ||= next !== entry;
      output.push(next);
    }
    materialized.push(changed ? { ...item, output } : item);
  }
  return materialized;
}

function parseSerializedRunState(serialized: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function visitSerializedRunStateItemArrays(
  root: Record<string, unknown>,
  visitor: (items: Array<Record<string, unknown>>) => void,
): void {
  const originalInput = root.originalInput;
  if (Array.isArray(originalInput)) {
    visitor(originalInput as Array<Record<string, unknown>>);
  }
  if (Array.isArray(root.generatedItems)) {
    for (const wrapper of root.generatedItems) {
      if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) continue;
      const record = wrapper as Record<string, unknown>;
      const rawItem = record.rawItem;
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
      const items = [rawItem as Record<string, unknown>];
      visitor(items);
      if (items[0] !== rawItem) record.rawItem = items[0];
    }
  }
  if (Array.isArray(root.modelResponses)) {
    for (const response of root.modelResponses) {
      if (!response || typeof response !== "object" || Array.isArray(response)) continue;
      const output = (response as Record<string, unknown>).output;
      if (Array.isArray(output)) visitor(output as Array<Record<string, unknown>>);
    }
  }
  const lastModelResponse = root.lastModelResponse;
  if (
    lastModelResponse &&
    typeof lastModelResponse === "object" &&
    !Array.isArray(lastModelResponse)
  ) {
    const output = (lastModelResponse as Record<string, unknown>).output;
    if (Array.isArray(output)) visitor(output as Array<Record<string, unknown>>);
  }
}

async function visitSerializedRunStateItemArraysAsync(
  root: Record<string, unknown>,
  visitor: (items: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const originalInput = root.originalInput;
  if (Array.isArray(originalInput)) {
    await visitor(originalInput as Array<Record<string, unknown>>);
  }
  if (Array.isArray(root.generatedItems)) {
    for (const wrapper of root.generatedItems) {
      if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) continue;
      const record = wrapper as Record<string, unknown>;
      const rawItem = record.rawItem;
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
      const items = [rawItem as Record<string, unknown>];
      await visitor(items);
      if (items[0] !== rawItem) record.rawItem = items[0];
    }
  }
  if (Array.isArray(root.modelResponses)) {
    for (const response of root.modelResponses) {
      if (!response || typeof response !== "object" || Array.isArray(response)) continue;
      const output = (response as Record<string, unknown>).output;
      if (Array.isArray(output)) await visitor(output as Array<Record<string, unknown>>);
    }
  }
  const lastModelResponse = root.lastModelResponse;
  if (
    lastModelResponse &&
    typeof lastModelResponse === "object" &&
    !Array.isArray(lastModelResponse)
  ) {
    const output = (lastModelResponse as Record<string, unknown>).output;
    if (Array.isArray(output)) await visitor(output as Array<Record<string, unknown>>);
  }
}

function reference(artifact: RetainedScreenshotArtifact): RetainedArtifactReference {
  const value = retainedScreenshotReferenceFromFile({
    ...artifact.file,
    sessionId: artifact.sessionId,
    width: artifact.width,
    height: artifact.height,
    expiresAt: artifact.retentionExpiresAt.toISOString(),
  });
  if (!value)
    throw new Error(`Ready retained screenshot receipt is invalid: ${artifact.artifactId}`);
  return value;
}

function unavailable(
  artifactId: string,
  reason: RetainedOutputUnavailableReason,
): RetainedArtifactMetadata {
  return RetainedArtifactMetadataSchema.parse({
    available: false,
    artifactId,
    reason,
  });
}

function unavailableReasonForStatus(
  status: RetainedScreenshotArtifact["status"],
): RetainedOutputUnavailableReason {
  switch (status) {
    case "pending":
    case "reconciling":
      return "pending";
    case "cleanup_pending":
      return "failed";
    case "failed":
    case "expired":
    case "deleted":
      return status;
    case "ready":
      return "missing_storage";
  }
}

async function verifyReadyArtifact(
  storage: ObjectStorage,
  artifact: RetainedScreenshotArtifact,
): Promise<boolean> {
  try {
    assertStoredScreenshotHead(await storage.headFile(artifact.file), {
      sizeBytes: artifact.sizeBytes,
      mediaType: "image/png",
      sha256: artifact.sha256,
    });
    return true;
  } catch {
    return false;
  }
}

function assertStoredScreenshotHead(
  head: ObjectHead,
  expected: Pick<ValidatedScreenshot, "sizeBytes" | "mediaType" | "sha256">,
): void {
  if (head.ContentLength !== expected.sizeBytes) {
    throw new Error("retained screenshot object size mismatch");
  }
  if (head.ContentType !== expected.mediaType) {
    throw new Error("retained screenshot object MIME mismatch");
  }
  if (head.Metadata?.sha256 !== expected.sha256) {
    throw new Error("retained screenshot object SHA-256 metadata mismatch");
  }
}

function retainedReceiptFromImageContent(entry: unknown): RetainedArtifactMetadata | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const image = (entry as Record<string, unknown>).image;
  if (!image || typeof image !== "object" || Array.isArray(image)) return null;
  const marker = image as Record<string, unknown>;
  if (marker.type !== RETAINED_IMAGE_MARKER) return null;
  const parsed = RetainedArtifactMetadataSchema.safeParse(marker.artifact);
  if (!parsed.success) return null;
  return parsed.data.available && parsed.data.kind !== "computer_screenshot" ? null : parsed.data;
}

function isInlineImageContent(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  return (
    record.type === "input_image" &&
    typeof record.image === "string" &&
    record.image.startsWith("data:image/png;base64,")
  );
}

function historyCallId(item: Record<string, unknown>): string | null {
  const value = item.callId ?? item.call_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function asciiChunkType(bytes: Uint8Array, offset: number): string {
  const chars = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (
    chars.some(
      (value) => value === undefined || value < 65 || (value > 90 && value < 97) || value > 122,
    )
  ) {
    throw new ScreenshotValidationError(
      "invalid_content",
      "computer screenshot PNG chunk type is invalid",
    );
  }
  return String.fromCharCode(...(chars as number[]));
}

function isCriticalChunk(type: string): boolean {
  return type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
}

function validPngColorMode(bitDepth: number | undefined, colorType: number | undefined): boolean {
  if (bitDepth === undefined || colorType === undefined) return false;
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth);
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    case 3:
      return [1, 2, 4, 8].includes(bitDepth);
    default:
      return false;
  }
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }
  return current >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
