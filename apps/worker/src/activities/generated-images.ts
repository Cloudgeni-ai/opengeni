import {
  COMPUTER_SCREENSHOT_MAX_DIMENSION,
  COMPUTER_SCREENSHOT_MAX_PIXELS,
  GENERATED_IMAGE_MAX_BYTES,
  GeneratedImageReceiptSchema,
  retainedGeneratedImageReferenceFromFile,
  type GeneratedImageReceipt,
} from "@opengeni/contracts";
import {
  completeFileUpload,
  prepareGeneratedImageArtifact,
  recordGeneratedImageArtifactError,
  settleGeneratedImageArtifactReady,
  type Database,
  type GeneratedImageArtifact,
  type GeneratedImageSourceStrategy,
} from "@opengeni/db";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import { createHash } from "node:crypto";
import { ScreenshotValidationError, validateRetainableSessionImage } from "./retained-screenshots";

const GENERATED_IMAGE_MARKER = "generated_image";
const UPLOAD_INTENT_TTL_MS = 60 * 60_000;

export type GeneratedImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type ValidatedGeneratedImage = {
  bytes: Uint8Array;
  mediaType: GeneratedImageMediaType;
  extension: "png" | "jpg" | "webp";
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
};

export type GeneratedImageOutput = {
  toolCallId: string;
  providerItemId: string | null;
  bytes: Uint8Array;
  declaredMediaType?: string;
};

export type { GeneratedImageReceipt };

export type RetainedGeneratedImage = {
  receipt: GeneratedImageReceipt;
  artifact: GeneratedImageArtifact;
};

export class GeneratedImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratedImageValidationError";
  }
}

/** Extract the completed Responses hosted-tool payload before JSON serialization. */
export function generatedImageFromSdkEvent(event: unknown): GeneratedImageOutput | null {
  if (!event || typeof event !== "object") return null;
  const streamEvent = event as {
    type?: unknown;
    item?: { type?: unknown; rawItem?: unknown; id?: unknown };
  };
  if (streamEvent.type !== "run_item_stream_event") return null;
  const item = streamEvent.item;
  if (!item || item.type !== "tool_call_item") return null;
  if (!item.rawItem || typeof item.rawItem !== "object" || Array.isArray(item.rawItem)) return null;
  const raw = item.rawItem as Record<string, unknown>;
  if (
    raw.type !== "hosted_tool_call" ||
    raw.name !== "image_generation_call" ||
    raw.status !== "completed"
  ) {
    return null;
  }
  const providerData =
    raw.providerData && typeof raw.providerData === "object" && !Array.isArray(raw.providerData)
      ? (raw.providerData as Record<string, unknown>)
      : null;
  const encoded =
    typeof raw.output === "string"
      ? raw.output
      : typeof providerData?.result === "string"
        ? providerData.result
        : null;
  if (!encoded) return null;
  const providerItemId = raw.id ?? providerData?.id ?? item.id;
  const toolCallId = providerItemId;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return null;
  return {
    toolCallId,
    providerItemId: typeof providerItemId === "string" ? providerItemId : null,
    bytes: decodeGeneratedImageBase64(encoded),
  };
}

/** Classify the native terminal item independently from its current payload shape. */
export function isCompletedGeneratedImageSdkEvent(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "run_item_stream_event") return false;
  const item = event.item;
  if (!isRecord(item) || item.type !== "tool_call_item" || !isRecord(item.rawItem)) return false;
  return (
    item.rawItem.type === "hosted_tool_call" &&
    item.rawItem.name === "image_generation_call" &&
    item.rawItem.status === "completed"
  );
}

export function generatedImagesFromHistory(
  history: ReadonlyArray<Record<string, unknown>>,
  retainedProviderItems?: Pick<ReadonlyMap<string, unknown>, "has">,
): GeneratedImageOutput[] {
  const outputs: GeneratedImageOutput[] = [];
  for (const item of history) {
    if (
      item.type !== "hosted_tool_call" ||
      item.name !== "image_generation_call" ||
      item.status !== "completed" ||
      typeof item.id !== "string" ||
      (typeof item.output !== "string" &&
        !(
          item.providerData &&
          typeof item.providerData === "object" &&
          !Array.isArray(item.providerData) &&
          typeof (item.providerData as Record<string, unknown>).result === "string"
        ))
    ) {
      continue;
    }
    if (retainedProviderItems?.has(item.id)) continue;
    if (generatedImageReceiptFromUnknown(item.output)) continue;
    outputs.push({
      toolCallId: item.id,
      providerItemId: item.id,
      bytes: decodeGeneratedImageBase64(
        typeof item.output === "string"
          ? item.output
          : ((item.providerData as Record<string, unknown>).result as string),
      ),
    });
  }
  return outputs;
}

/** Refuse to serialize a completed native item unless its bytes have a receipt. */
export function assertGeneratedImageHistoryRetained(
  history: ReadonlyArray<Record<string, unknown>>,
  receiptsByProviderItemId: Pick<ReadonlyMap<string, unknown>, "has">,
): void {
  for (const item of history) {
    if (
      item.type !== "hosted_tool_call" ||
      item.name !== "image_generation_call" ||
      item.status !== "completed"
    ) {
      continue;
    }
    if (
      typeof item.id !== "string" ||
      (!receiptsByProviderItemId.has(item.id) && !generatedImageReceiptFromUnknown(item.output))
    ) {
      throw new Error("Completed native image history has no retained-artifact receipt");
    }
  }
}

export function decodeGeneratedImageBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new GeneratedImageValidationError("generated image base64 has invalid length");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > GENERATED_IMAGE_MAX_BYTES) {
    throw new GeneratedImageValidationError("generated image exceeds the byte limit");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new GeneratedImageValidationError("generated image base64 is malformed");
  }
  const lastSextet = base64Sextet(value.charCodeAt(value.length - padding - 1));
  if (
    (padding === 2 && (lastSextet & 0x0f) !== 0) ||
    (padding === 1 && (lastSextet & 0x03) !== 0)
  ) {
    throw new GeneratedImageValidationError("generated image base64 is non-canonical");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== decodedBytes) {
    throw new GeneratedImageValidationError("generated image base64 is non-canonical");
  }
  return bytes;
}

/** Validate signatures and dimensions; never trust provider-declared MIME metadata. */
export function validateGeneratedImage(input: {
  bytes: Uint8Array;
  declaredMediaType?: string;
}): ValidatedGeneratedImage {
  try {
    return validateRetainableSessionImage(
      {
        bytes: input.bytes,
        ...(input.declaredMediaType ? { declaredMediaType: input.declaredMediaType } : {}),
      },
      {
        maxBytes: GENERATED_IMAGE_MAX_BYTES,
        maxDimension: COMPUTER_SCREENSHOT_MAX_DIMENSION,
        maxPixels: COMPUTER_SCREENSHOT_MAX_PIXELS,
      },
    );
  } catch (error) {
    if (error instanceof ScreenshotValidationError) {
      throw new GeneratedImageValidationError(error.message);
    }
    throw error;
  }
}

type GeneratedImageIdentityInput = {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  providerId: string;
  providerBindingHash: string;
  toolCallId: string;
} & (
  | { sourceStrategy: "native_hosted"; providerItemId: string }
  | { sourceStrategy: "provider_adapter"; providerItemId: null }
);

export function generatedImageIdentity(input: GeneratedImageIdentityInput): {
  artifactId: string;
  uploadId: string;
  settlementKey: string;
} {
  const hash = createHash("sha256")
    .update("opengeni:generated-image:v2\0")
    .update(input.workspaceId)
    .update("\0")
    .update(input.sourceStrategy)
    .update("\0")
    .update(input.providerId)
    .update("\0")
    .update(input.providerBindingHash)
    .update("\0");
  if (input.sourceStrategy === "native_hosted") {
    hash.update(input.providerItemId);
  } else {
    hash
      .update(input.sessionId)
      .update("\0")
      .update(input.turnId)
      .update("\0")
      .update(input.toolCallId);
  }
  const settlementKey = hash.digest("hex");
  return {
    settlementKey,
    artifactId: uuidFromDigest(settlementKey, 0),
    uploadId: uuidFromDigest(settlementKey, 16),
  };
}

export async function retainGeneratedImage(input: {
  db: Database;
  objectStorage: ObjectStorage | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  sourceStrategy: GeneratedImageSourceStrategy;
  providerId: string;
  providerBindingHash: string;
  output: GeneratedImageOutput;
  now?: Date;
}): Promise<RetainedGeneratedImage> {
  if (!input.objectStorage) {
    throw new Error("Generated image retention requires configured object storage");
  }
  const image = validateGeneratedImage(input.output);
  const identityInput = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    providerId: input.providerId,
    providerBindingHash: input.providerBindingHash,
    toolCallId: input.output.toolCallId,
  };
  let identity: ReturnType<typeof generatedImageIdentity>;
  if (input.sourceStrategy === "native_hosted") {
    if (!input.output.providerItemId) {
      throw new Error("Native generated image has no provider item identity");
    }
    identity = generatedImageIdentity({
      ...identityInput,
      sourceStrategy: "native_hosted",
      providerItemId: input.output.providerItemId,
    });
  } else {
    if (input.output.providerItemId !== null) {
      throw new Error("Adapter-generated image cannot carry a native provider item identity");
    }
    identity = generatedImageIdentity({
      ...identityInput,
      sourceStrategy: "provider_adapter",
      providerItemId: null,
    });
  }
  const filename = `generated-image-${identity.artifactId}.${image.extension}`;
  const sandboxPath = `/workspace/generated-images/${filename}`;
  const objectKey = `workspaces/${input.workspaceId}/files/${identity.artifactId}/generated/${filename}`;
  const prepared = await prepareGeneratedImageArtifact(input.db, {
    artifactId: identity.artifactId,
    uploadId: identity.uploadId,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    settlementKey: identity.settlementKey,
    toolCallId: input.output.toolCallId,
    sourceStrategy: input.sourceStrategy,
    providerId: input.providerId,
    providerBindingHash: input.providerBindingHash,
    providerItemId: input.output.providerItemId,
    mediaType: image.mediaType,
    sizeBytes: image.sizeBytes,
    sha256: image.sha256,
    width: image.width,
    height: image.height,
    sandboxPath,
    filename,
    safeFilename: filename,
    bucket: input.objectStorage.bucket,
    objectKey,
    uploadExpiresAt: new Date((input.now ?? new Date()).getTime() + UPLOAD_INTENT_TTL_MS),
  });

  if (prepared.artifact.status === "ready") {
    await verifyReadyGeneratedImage(input.objectStorage, prepared.artifact, image);
    return retainedGeneratedImageFromArtifact(prepared.artifact);
  }

  try {
    // A crash may leave the file complete while the correlation row is pending.
    // Verify and settle that state without rewriting the object.
    if (
      prepared.artifact.file.status !== "ready" ||
      prepared.artifact.uploadStatus !== "completed"
    ) {
      if (!(await input.objectStorage.fileExists(prepared.artifact.file))) {
        await input.objectStorage.putObject({
          key: objectKey,
          contentType: image.mediaType,
          body: image.bytes,
          sha256: image.sha256,
        });
      }
      assertStoredGeneratedImageHead(
        await input.objectStorage.headFile(prepared.artifact.file),
        image,
      );
      await completeFileUpload(input.db, input.workspaceId, identity.uploadId);
    } else {
      await verifyReadyGeneratedImage(input.objectStorage, prepared.artifact, image);
    }
    const settled = await settleGeneratedImageArtifactReady(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      artifactId: identity.artifactId,
      settlementKey: identity.settlementKey,
    });
    return retainedGeneratedImageFromArtifact(settled);
  } catch (error) {
    await recordGeneratedImageArtifactError(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      artifactId: identity.artifactId,
      settlementKey: identity.settlementKey,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

/** Replace provider bytes before they can enter event/history serialization. */
export function compactGeneratedImageHistory(
  history: Array<Record<string, unknown>>,
  receiptsByProviderItemId: ReadonlyMap<string, GeneratedImageReceipt>,
): Array<Record<string, unknown>> {
  if (receiptsByProviderItemId.size === 0) return history;
  return history.map((item) => {
    if (item.type !== "hosted_tool_call" || item.name !== "image_generation_call") return item;
    const id = typeof item.id === "string" ? item.id : null;
    const receipt = id ? receiptsByProviderItemId.get(id) : undefined;
    if (!receipt) return item;
    const existingReceipt = generatedImageReceiptFromUnknown(item.output);
    const providerDataContainsBytes =
      isRecord(item.providerData) && typeof item.providerData.result === "string";
    if (
      existingReceipt?.artifact.artifactId === receipt.artifact.artifactId &&
      !providerDataContainsBytes
    ) {
      return item;
    }
    return {
      ...item,
      output: receipt,
      ...(item.providerData ? { providerData: withoutNativeImageResult(item.providerData) } : {}),
    };
  });
}

export function compactGeneratedImageSdkEvent(
  event: unknown,
  receipt: GeneratedImageReceipt,
): unknown {
  if (!event || typeof event !== "object") return event;
  const streamEvent = event as Record<string, unknown>;
  const item = streamEvent.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return event;
  const itemRecord = item as Record<string, unknown>;
  const raw = itemRecord.rawItem;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return event;
  const rawRecord = raw as Record<string, unknown>;
  if (rawRecord.type !== "hosted_tool_call" || rawRecord.name !== "image_generation_call") {
    return event;
  }
  return {
    ...streamEvent,
    item: {
      ...itemRecord,
      rawItem: {
        ...rawRecord,
        output: receipt,
        ...(rawRecord.providerData
          ? { providerData: withoutNativeImageResult(rawRecord.providerData) }
          : {}),
      },
    },
  };
}

export function collectGeneratedImageReceipts(
  history: ReadonlyArray<Record<string, unknown>>,
  target: Map<string, GeneratedImageReceipt> = new Map(),
): Map<string, GeneratedImageReceipt> {
  for (const item of history) {
    if (item.type !== "hosted_tool_call" || item.name !== "image_generation_call") continue;
    if (typeof item.id !== "string") continue;
    const receipt = generatedImageReceiptFromUnknown(item.output);
    if (receipt) target.set(item.id, receipt);
  }
  return target;
}

export function collectGeneratedImageArtifactReceipts(
  history: ReadonlyArray<Record<string, unknown>>,
  target: Map<string, GeneratedImageReceipt> = new Map(),
): Map<string, GeneratedImageReceipt> {
  for (const item of history) {
    const candidates = Array.isArray(item.output) ? item.output : [item.output];
    for (const candidate of candidates) {
      const receipt = generatedImageReceiptFromUnknown(candidate);
      if (receipt) target.set(receipt.artifact.artifactId, receipt);
    }
  }
  return target;
}

/**
 * Project native image calls to one provider-neutral, cache-stable model fact.
 * The canonical hosted-tool item remains available to the UI, but its provider
 * id and compact receipt are never replayed as a counterfeit native result.
 */
export function projectGeneratedImageHistoryForModel(
  history: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected: Array<Record<string, unknown>> = [];
  for (const item of history) {
    if (item.type !== "hosted_tool_call" || item.name !== "image_generation_call") {
      projected.push(item);
      continue;
    }
    const receipt = generatedImageReceiptFromUnknown(item.output);
    if (!receipt) {
      projected.push(item);
      continue;
    }
    changed = true;
    projected.push(generatedImageModelMessage(receipt, "history"));
  }
  return changed ? projected : history;
}

/**
 * Build the attempt-local RunState view consumed by the Agents SDK on resume.
 *
 * OpenAI serializes a hosted image call from `providerData.result`, not from
 * the SDK item's generic `output`. Our durable state deliberately replaces
 * those bytes with a compact receipt, so replaying the hosted item would send
 * a counterfeit `result: null`. Convert it to the same provider-neutral fact
 * used for ordinary history instead. Durable state is never modified.
 */
export function projectGeneratedImageRunStateForModel(serialized: string): string {
  const parsed = parseRunState(serialized);
  if (!parsed) return serialized;
  let changed = false;

  visitRunStateProtocolItems(parsed, (items) => {
    const projected = projectGeneratedImageRunStateItemsForModel(items);
    if (projected !== items) {
      items.splice(0, items.length, ...projected);
      changed = true;
    }
  });
  visitRunStateItemWrappers(parsed, (wrappers) => {
    for (let index = 0; index < wrappers.length; index += 1) {
      const projected = projectGeneratedImageRunItemWrapper(wrappers[index]!);
      if (projected !== wrappers[index]) {
        wrappers[index] = projected;
        changed = true;
      }
    }
  });

  return changed ? JSON.stringify(parsed) : serialized;
}

function projectGeneratedImageRunStateItemsForModel(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = items.map((item) => {
    const receipt = generatedImageReceiptFromHostedItem(item);
    if (!receipt) return item;
    changed = true;
    return generatedImageModelMessage(receipt, "run_state");
  });
  return changed ? projected : items;
}

export function compactGeneratedImageRunState(
  serialized: string,
  receiptsByProviderItemId: ReadonlyMap<string, GeneratedImageReceipt>,
): string {
  if (receiptsByProviderItemId.size === 0) return serialized;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) return serialized;
    parsed = value as Record<string, unknown>;
  } catch {
    return serialized;
  }
  let changed = false;
  visitRunStateProtocolItems(parsed, (items) => {
    const compacted = compactGeneratedImageRunStateItems(items, receiptsByProviderItemId);
    if (compacted.some((item, index) => item !== items[index])) {
      items.splice(0, items.length, ...compacted);
      changed = true;
    }
  });
  visitRunStateItemWrappers(parsed, (wrappers) => {
    for (const wrapper of wrappers) {
      if (!isRecord(wrapper) || !isRecord(wrapper.rawItem)) continue;
      const compacted = compactGeneratedImageRunStateItems(
        [wrapper.rawItem],
        receiptsByProviderItemId,
      )[0];
      if (compacted && compacted !== wrapper.rawItem) {
        wrapper.rawItem = compacted;
        changed = true;
      }
    }
  });
  return changed ? JSON.stringify(parsed) : serialized;
}

function compactGeneratedImageRunStateItems(
  items: Array<Record<string, unknown>>,
  receiptsByProviderItemId: ReadonlyMap<string, GeneratedImageReceipt>,
): Array<Record<string, unknown>> {
  const compacted = compactGeneratedImageHistory(items, receiptsByProviderItemId);
  let serializedReceipt = false;
  const serialized = compacted.map((item) => {
    const receipt = generatedImageReceiptFromUnknown(item.output);
    if (!receipt || typeof item.output === "string") return item;
    serializedReceipt = true;
    return { ...item, output: JSON.stringify(receipt) };
  });
  return serializedReceipt ? serialized : compacted;
}

export function collectGeneratedImageRunStateArtifactReceipts(
  serialized: string,
  target: Map<string, GeneratedImageReceipt> = new Map(),
): Map<string, GeneratedImageReceipt> {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) return target;
    visitRunStateProtocolItems(value as Record<string, unknown>, (items) => {
      collectGeneratedImageArtifactReceipts(items, target);
    });
    visitRunStateItemWrappers(value as Record<string, unknown>, (wrappers) => {
      for (const wrapper of wrappers) {
        if (isRecord(wrapper) && isRecord(wrapper.rawItem)) {
          collectGeneratedImageArtifactReceipts([wrapper.rawItem], target);
        }
      }
    });
  } catch {
    // A provider-owned or legacy state format is opaque to this collector.
  }
  return target;
}

export function generatedImageReceiptFromUnknown(value: unknown): GeneratedImageReceipt | null {
  if (typeof value === "string" && value.length <= 4_096) {
    try {
      return generatedImageReceiptFromUnknown(JSON.parse(value));
    } catch {
      return null;
    }
  }
  // Function-tool results are durably normalized to the Agents SDK's typed
  // text envelope. Unwrap that canonical transport shape before validating the
  // closed receipt; otherwise a later turn sees the path in model history but
  // cannot discover the artifact that must be copied into its sandbox.
  if (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string" &&
    value.text.length <= 4_096
  ) {
    return generatedImageReceiptFromUnknown(value.text);
  }
  const parsed = GeneratedImageReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function visitRunStateProtocolItems(
  root: Record<string, unknown>,
  visitor: (items: Array<Record<string, unknown>>) => void,
): void {
  if (Array.isArray(root.originalInput)) {
    visitor(root.originalInput as Array<Record<string, unknown>>);
  }
  if (Array.isArray(root.modelResponses)) {
    for (const response of root.modelResponses) {
      if (!response || typeof response !== "object" || Array.isArray(response)) continue;
      const output = (response as Record<string, unknown>).output;
      if (Array.isArray(output)) visitor(output as Array<Record<string, unknown>>);
    }
  }
  if (root.lastModelResponse && typeof root.lastModelResponse === "object") {
    const output = (root.lastModelResponse as Record<string, unknown>).output;
    if (Array.isArray(output)) visitor(output as Array<Record<string, unknown>>);
  }
}

function visitRunStateItemWrappers(
  root: Record<string, unknown>,
  visitor: (items: Array<Record<string, unknown>>) => void,
): void {
  if (Array.isArray(root.generatedItems)) {
    visitor(root.generatedItems as Array<Record<string, unknown>>);
  }
  const processed = root.lastProcessedResponse;
  if (isRecord(processed) && Array.isArray(processed.newItems)) {
    visitor(processed.newItems as Array<Record<string, unknown>>);
  }
}

function projectGeneratedImageRunItemWrapper(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (value.type !== "tool_call_item" || !isRecord(value.rawItem) || !isRecord(value.agent)) {
    return value;
  }
  const receipt = generatedImageReceiptFromHostedItem(value.rawItem);
  if (!receipt) return value;
  return {
    type: "message_output_item",
    rawItem: generatedImageModelMessage(receipt, "run_state"),
    agent: value.agent,
  };
}

function generatedImageReceiptFromHostedItem(
  item: Record<string, unknown>,
): GeneratedImageReceipt | null {
  if (item.type !== "hosted_tool_call" || item.name !== "image_generation_call") {
    return null;
  }
  return generatedImageReceiptFromUnknown(item.output);
}

function generatedImageModelFact(receipt: GeneratedImageReceipt): string {
  return [
    "Generated image artifact:",
    `Artifact ID: ${receipt.artifact.artifactId}`,
    `Sandbox path: ${receipt.sandboxPath}`,
    `Format: ${receipt.artifact.contentType}`,
    `Dimensions: ${receipt.artifact.dimensions?.width ?? "?"}x${receipt.artifact.dimensions?.height ?? "?"}`,
  ].join("\n");
}

function generatedImageModelMessage(
  receipt: GeneratedImageReceipt,
  shape: "history" | "run_state",
): Record<string, unknown> {
  const text = generatedImageModelFact(receipt);
  return shape === "history"
    ? { type: "message", role: "assistant", content: text }
    : {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      };
}

function parseRunState(serialized: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function retainedGeneratedImageFromArtifact(
  artifact: GeneratedImageArtifact,
): RetainedGeneratedImage {
  const reference = retainedGeneratedImageReferenceFromFile({
    ...artifact.file,
    width: artifact.width,
    height: artifact.height,
  });
  if (!reference)
    throw new Error(`Ready generated image receipt is invalid: ${artifact.artifactId}`);
  return {
    artifact,
    receipt: {
      type: GENERATED_IMAGE_MARKER,
      artifact: reference,
      sandboxPath: artifact.sandboxPath,
    },
  };
}

/** Verify a recovered ready correlation against the immutable object metadata. */
export async function verifyReadyGeneratedImageArtifact(
  storage: ObjectStorage,
  artifact: GeneratedImageArtifact,
): Promise<void> {
  if (artifact.status !== "ready" || artifact.file.status !== "ready") {
    throw new Error("Generated image artifact is not durably ready");
  }
  assertStoredGeneratedImageHead(await storage.headFile(artifact.file), {
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType as GeneratedImageMediaType,
    sha256: artifact.sha256,
  });
}

/**
 * Finish a crash-interrupted upload from immutable DB/object metadata without
 * provider replay. A missing object is not proof that generation failed: the
 * paid outcome remains unknown and the caller may check again later.
 */
export async function recoverGeneratedImageArtifact(input: {
  db: Database;
  storage: ObjectStorage;
  accountId: string;
  workspaceId: string;
  artifact: GeneratedImageArtifact;
}): Promise<GeneratedImageArtifact | null> {
  const { artifact } = input;
  if (artifact.status === "ready") {
    await verifyReadyGeneratedImageArtifact(input.storage, artifact);
    return artifact;
  }
  if (artifact.status !== "pending") return null;
  if (!(await input.storage.fileExists(artifact.file))) return null;
  assertStoredGeneratedImageHead(await input.storage.headFile(artifact.file), {
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType as GeneratedImageMediaType,
    sha256: artifact.sha256,
  });
  if (artifact.file.status !== "ready" || artifact.uploadStatus !== "completed") {
    if (!artifact.uploadId) return null;
    await completeFileUpload(input.db, input.workspaceId, artifact.uploadId);
  }
  return await settleGeneratedImageArtifactReady(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    artifactId: artifact.artifactId,
    settlementKey: artifact.settlementKey,
  });
}

async function verifyReadyGeneratedImage(
  storage: ObjectStorage,
  artifact: GeneratedImageArtifact,
  expected: ValidatedGeneratedImage,
): Promise<void> {
  assertStoredGeneratedImageHead(await storage.headFile(artifact.file), expected);
  if (
    artifact.sizeBytes !== expected.sizeBytes ||
    artifact.sha256 !== expected.sha256 ||
    artifact.mediaType !== expected.mediaType ||
    artifact.width !== expected.width ||
    artifact.height !== expected.height
  ) {
    throw new Error("ready generated image metadata does not match provider bytes");
  }
}

function assertStoredGeneratedImageHead(
  head: ObjectHead,
  expected: Pick<ValidatedGeneratedImage, "sizeBytes" | "mediaType" | "sha256">,
): void {
  if (head.ContentLength !== expected.sizeBytes)
    throw new Error("generated image object size mismatch");
  if (head.ContentType !== expected.mediaType)
    throw new Error("generated image object MIME mismatch");
  if (head.Metadata?.sha256 !== expected.sha256) {
    throw new Error("generated image object SHA-256 metadata mismatch");
  }
}

function uuidFromDigest(digest: string, startByte: number): string {
  const source = Buffer.from(digest, "hex");
  const bytes = Uint8Array.from(source.subarray(startByte, startByte + 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64Sextet(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  return code === 0x2b ? 62 : 63;
}

function withoutNativeImageResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { result: _result, ...rest } = value as Record<string, unknown>;
  return rest;
}
