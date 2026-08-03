const DEFAULT_DATABASE_NAME = "opengeni-voice-recordings-v1";
const DATABASE_VERSION = 1;
const MANIFEST_STORE = "recordings";
const CHUNK_STORE = "chunks";
const CHUNKS_BY_RECORDING = "by-recording";

export type VoiceRecordingCaptureState = "capturing" | "stopped" | "discarded";
export type VoiceRecordingUploadState = "pending" | "syncing" | "retrying" | "complete";
export type VoiceRecordingTranscriptionState = "pending" | "transcribing" | "retrying" | "complete";
export type VoiceRecordingFinalizationState = "pending" | "transcript-ready" | "handed-off";
export type VoiceRecordingChunkUploadState = "pending" | "syncing" | "complete";

export type VoiceRecordingManifest = {
  version: 1;
  recordingId: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  mimeType: string;
  codec: string | null;
  captureState: VoiceRecordingCaptureState;
  uploadState: VoiceRecordingUploadState;
  transcriptionState: VoiceRecordingTranscriptionState;
  finalizationState: VoiceRecordingFinalizationState;
  /** Tab/process lease. A different owner may take over only after this heartbeat is stale. */
  ownerId: string | null;
  ownerHeartbeatAt: string | null;
  /** Authoritative provider result, persisted before any composer draft mutation. */
  transcriptText: string | null;
  nextChunkNumber: number;
  chunkCount: number;
  totalBytes: number;
  totalDurationMilliseconds: number;
};

export type VoiceRecordingChunk = {
  recordingId: string;
  chunkNumber: number;
  capturedAt: string;
  startMilliseconds: number;
  durationMilliseconds: number;
  mimeType: string;
  codec: string | null;
  byteLength: number;
  sha256: string;
  uploadState: VoiceRecordingChunkUploadState;
  audio: Blob;
};

export type PersistVoiceRecordingChunkInput = {
  recordingId: string;
  ownerId?: string | undefined;
  chunkNumber: number;
  capturedAt: string;
  startMilliseconds: number;
  durationMilliseconds: number;
  mimeType: string;
  audio: Blob;
};

export type PersistVoiceRecordingChunkResult = {
  manifest: VoiceRecordingManifest;
  chunk: VoiceRecordingChunk;
  deduplicated: boolean;
};

export interface VoiceRecordingStore {
  createManifest(manifest: VoiceRecordingManifest): Promise<void>;
  getManifest(recordingId: string): Promise<VoiceRecordingManifest | null>;
  listRecoverableManifests(
    workspaceId: string,
    ownership?: { ownerId: string; staleBefore: string },
  ): Promise<VoiceRecordingManifest[]>;
  claimManifest(
    recordingId: string,
    ownerId: string,
    claimedAt: string,
    staleBefore: string,
  ): Promise<VoiceRecordingManifest>;
  listChunks(recordingId: string): Promise<VoiceRecordingChunk[]>;
  persistChunk(input: PersistVoiceRecordingChunkInput): Promise<PersistVoiceRecordingChunkResult>;
  updateManifest(
    recordingId: string,
    update: Partial<
      Pick<
        VoiceRecordingManifest,
        | "captureState"
        | "uploadState"
        | "transcriptionState"
        | "finalizationState"
        | "ownerId"
        | "ownerHeartbeatAt"
        | "transcriptText"
      >
    >,
    updatedAt: string,
    ownerId?: string | undefined,
  ): Promise<VoiceRecordingManifest>;
  discard(recordingId: string, ownerId?: string | undefined): Promise<void>;
  close(): Promise<void>;
}

export class VoiceRecordingStorageUnavailableError extends Error {
  constructor() {
    super("Durable voice recording storage is unavailable.");
    this.name = "VoiceRecordingStorageUnavailableError";
  }
}

export class VoiceRecordingNotFoundError extends Error {
  constructor(recordingId: string) {
    super(`Voice recording ${recordingId} was not found.`);
    this.name = "VoiceRecordingNotFoundError";
  }
}

export class VoiceRecordingChunkConflictError extends Error {
  constructor(recordingId: string, chunkNumber: number) {
    super(`Voice recording ${recordingId} chunk ${chunkNumber} conflicts with persisted audio.`);
    this.name = "VoiceRecordingChunkConflictError";
  }
}

export class VoiceRecordingChunkSequenceError extends Error {
  constructor(expected: number, received: number) {
    super(`Expected voice recording chunk ${expected}, received ${received}.`);
    this.name = "VoiceRecordingChunkSequenceError";
  }
}

export class VoiceRecordingOwnedError extends Error {
  constructor(recordingId: string) {
    super(`Voice recording ${recordingId} is active in another browser tab.`);
    this.name = "VoiceRecordingOwnedError";
  }
}

export function createVoiceRecordingManifest(input: {
  recordingId: string;
  workspaceId: string;
  mimeType: string;
  createdAt: string;
  ownerId?: string | null | undefined;
}): VoiceRecordingManifest {
  return {
    version: 1,
    recordingId: input.recordingId,
    workspaceId: input.workspaceId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    mimeType: input.mimeType,
    codec: codecForMimeType(input.mimeType),
    captureState: "capturing",
    uploadState: "pending",
    transcriptionState: "pending",
    finalizationState: "pending",
    ownerId: input.ownerId ?? null,
    ownerHeartbeatAt: input.ownerId ? input.createdAt : null,
    transcriptText: null,
    nextChunkNumber: 0,
    chunkCount: 0,
    totalBytes: 0,
    totalDurationMilliseconds: 0,
  };
}

export async function prepareVoiceRecordingChunk(
  input: PersistVoiceRecordingChunkInput,
): Promise<VoiceRecordingChunk> {
  if (!Number.isSafeInteger(input.chunkNumber) || input.chunkNumber < 0) {
    throw new VoiceRecordingChunkSequenceError(0, input.chunkNumber);
  }
  if (!Number.isFinite(input.startMilliseconds) || input.startMilliseconds < 0) {
    throw new RangeError("Voice recording chunk start must be non-negative.");
  }
  if (!Number.isFinite(input.durationMilliseconds) || input.durationMilliseconds < 0) {
    throw new RangeError("Voice recording chunk duration must be non-negative.");
  }
  const bytes = new Uint8Array(await input.audio.arrayBuffer());
  if (bytes.byteLength === 0) throw new RangeError("Voice recording chunks cannot be empty.");
  return {
    recordingId: input.recordingId,
    chunkNumber: input.chunkNumber,
    capturedAt: input.capturedAt,
    startMilliseconds: Math.round(input.startMilliseconds),
    durationMilliseconds: Math.round(input.durationMilliseconds),
    mimeType: input.mimeType,
    codec: codecForMimeType(input.mimeType),
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    uploadState: "pending",
    audio: input.audio,
  };
}

export function planVoiceRecordingChunkCommit(input: {
  manifest: VoiceRecordingManifest;
  chunk: VoiceRecordingChunk;
  existingChunk: VoiceRecordingChunk | null;
}): PersistVoiceRecordingChunkResult {
  const { manifest, chunk, existingChunk } = input;
  if (manifest.recordingId !== chunk.recordingId) {
    throw new VoiceRecordingChunkConflictError(chunk.recordingId, chunk.chunkNumber);
  }
  if (existingChunk) {
    if (
      existingChunk.sha256 !== chunk.sha256 ||
      existingChunk.byteLength !== chunk.byteLength ||
      existingChunk.mimeType !== chunk.mimeType
    ) {
      throw new VoiceRecordingChunkConflictError(chunk.recordingId, chunk.chunkNumber);
    }
    return { manifest, chunk: existingChunk, deduplicated: true };
  }
  if (chunk.chunkNumber !== manifest.nextChunkNumber) {
    throw new VoiceRecordingChunkSequenceError(manifest.nextChunkNumber, chunk.chunkNumber);
  }
  const updatedManifest: VoiceRecordingManifest = {
    ...manifest,
    updatedAt: chunk.capturedAt,
    ownerHeartbeatAt: manifest.ownerId ? chunk.capturedAt : manifest.ownerHeartbeatAt,
    nextChunkNumber: manifest.nextChunkNumber + 1,
    chunkCount: manifest.chunkCount + 1,
    totalBytes: manifest.totalBytes + chunk.byteLength,
    totalDurationMilliseconds: Math.max(
      manifest.totalDurationMilliseconds,
      chunk.startMilliseconds + chunk.durationMilliseconds,
    ),
  };
  return { manifest: updatedManifest, chunk, deduplicated: false };
}

export class IndexedDbVoiceRecordingStore implements VoiceRecordingStore {
  private readonly database: Promise<IDBDatabase>;

  constructor(options?: { indexedDB?: IDBFactory | null; databaseName?: string }) {
    const factory = options && "indexedDB" in options ? options.indexedDB : globalThis.indexedDB;
    if (!factory) throw new VoiceRecordingStorageUnavailableError();
    this.database = openDatabase(factory, options?.databaseName ?? DEFAULT_DATABASE_NAME);
  }

  async createManifest(manifest: VoiceRecordingManifest): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(MANIFEST_STORE, "readwrite");
    transaction.objectStore(MANIFEST_STORE).add(manifest);
    await transactionComplete(transaction);
  }

  async getManifest(recordingId: string): Promise<VoiceRecordingManifest | null> {
    const database = await this.database;
    const transaction = database.transaction(MANIFEST_STORE, "readonly");
    const manifest = await requestResult<VoiceRecordingManifest | undefined>(
      transaction.objectStore(MANIFEST_STORE).get(recordingId),
    );
    await transactionComplete(transaction);
    return manifest ? normalizeManifest(manifest) : null;
  }

  async listRecoverableManifests(
    workspaceId: string,
    ownership?: { ownerId: string; staleBefore: string },
  ): Promise<VoiceRecordingManifest[]> {
    const database = await this.database;
    const transaction = database.transaction(MANIFEST_STORE, "readonly");
    const manifests = await requestResult<VoiceRecordingManifest[]>(
      transaction.objectStore(MANIFEST_STORE).getAll(),
    );
    await transactionComplete(transaction);
    return manifests
      .map(normalizeManifest)
      .filter(
        (manifest) =>
          manifest.workspaceId === workspaceId &&
          manifest.captureState !== "discarded" &&
          manifest.finalizationState !== "handed-off" &&
          manifestAvailableToOwner(manifest, ownership),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async claimManifest(
    recordingId: string,
    ownerId: string,
    claimedAt: string,
    staleBefore: string,
  ): Promise<VoiceRecordingManifest> {
    const database = await this.database;
    const transaction = database.transaction(MANIFEST_STORE, "readwrite");
    const manifests = transaction.objectStore(MANIFEST_STORE);
    const stored = await requestResult<VoiceRecordingManifest | undefined>(
      manifests.get(recordingId),
    );
    if (!stored) {
      transaction.abort();
      throw new VoiceRecordingNotFoundError(recordingId);
    }
    const manifest = normalizeManifest(stored);
    if (
      manifest.finalizationState === "handed-off" ||
      !manifestAvailableToOwner(manifest, { ownerId, staleBefore })
    ) {
      transaction.abort();
      throw new VoiceRecordingOwnedError(recordingId);
    }
    const updated: VoiceRecordingManifest = {
      ...manifest,
      captureState: manifest.captureState === "capturing" ? "stopped" : manifest.captureState,
      ownerId,
      ownerHeartbeatAt: claimedAt,
      updatedAt: claimedAt,
    };
    manifests.put(updated);
    await transactionComplete(transaction);
    return updated;
  }

  async listChunks(recordingId: string): Promise<VoiceRecordingChunk[]> {
    const database = await this.database;
    const transaction = database.transaction(CHUNK_STORE, "readonly");
    const chunks = await requestResult<VoiceRecordingChunk[]>(
      transaction.objectStore(CHUNK_STORE).index(CHUNKS_BY_RECORDING).getAll(recordingId),
    );
    await transactionComplete(transaction);
    return chunks.sort((left, right) => left.chunkNumber - right.chunkNumber);
  }

  async persistChunk(
    input: PersistVoiceRecordingChunkInput,
  ): Promise<PersistVoiceRecordingChunkResult> {
    const chunk = await prepareVoiceRecordingChunk(input);
    const database = await this.database;
    const transaction = database.transaction([MANIFEST_STORE, CHUNK_STORE], "readwrite");
    const manifests = transaction.objectStore(MANIFEST_STORE);
    const chunks = transaction.objectStore(CHUNK_STORE);
    const [manifest, existingChunk] = await Promise.all([
      requestResult<VoiceRecordingManifest | undefined>(manifests.get(input.recordingId)),
      requestResult<VoiceRecordingChunk | undefined>(
        chunks.get([input.recordingId, input.chunkNumber]),
      ),
    ]);
    if (!manifest) {
      transaction.abort();
      throw new VoiceRecordingNotFoundError(input.recordingId);
    }
    const normalizedManifest = normalizeManifest(manifest);
    assertManifestOwnership(normalizedManifest, input.ownerId);
    const result = planVoiceRecordingChunkCommit({
      manifest: normalizedManifest,
      chunk,
      existingChunk: existingChunk ?? null,
    });
    if (!result.deduplicated) {
      chunks.add(result.chunk);
      manifests.put(result.manifest);
    }
    await transactionComplete(transaction);
    return result;
  }

  async updateManifest(
    recordingId: string,
    update: Partial<
      Pick<
        VoiceRecordingManifest,
        | "captureState"
        | "uploadState"
        | "transcriptionState"
        | "finalizationState"
        | "ownerId"
        | "ownerHeartbeatAt"
        | "transcriptText"
      >
    >,
    updatedAt: string,
    ownerId?: string | undefined,
  ): Promise<VoiceRecordingManifest> {
    const database = await this.database;
    const transaction = database.transaction(MANIFEST_STORE, "readwrite");
    const manifests = transaction.objectStore(MANIFEST_STORE);
    const manifest = await requestResult<VoiceRecordingManifest | undefined>(
      manifests.get(recordingId),
    );
    if (!manifest) {
      transaction.abort();
      throw new VoiceRecordingNotFoundError(recordingId);
    }
    const normalizedManifest = normalizeManifest(manifest);
    assertManifestOwnership(normalizedManifest, ownerId);
    const updated = { ...normalizedManifest, ...update, updatedAt };
    manifests.put(updated);
    await transactionComplete(transaction);
    return updated;
  }

  async discard(recordingId: string, ownerId?: string | undefined): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction([MANIFEST_STORE, CHUNK_STORE], "readwrite");
    const manifests = transaction.objectStore(MANIFEST_STORE);
    const stored = await requestResult<VoiceRecordingManifest | undefined>(
      manifests.get(recordingId),
    );
    if (!stored) {
      transaction.abort();
      throw new VoiceRecordingNotFoundError(recordingId);
    }
    assertManifestOwnership(normalizeManifest(stored), ownerId);
    const chunks = transaction.objectStore(CHUNK_STORE);
    const chunkKeys = await requestResult<IDBValidKey[]>(
      chunks.index(CHUNKS_BY_RECORDING).getAllKeys(recordingId),
    );
    for (const key of chunkKeys) chunks.delete(key);
    manifests.delete(recordingId);
    await transactionComplete(transaction);
  }

  async close(): Promise<void> {
    (await this.database).close();
  }
}

function normalizeManifest(manifest: VoiceRecordingManifest): VoiceRecordingManifest {
  return {
    ...manifest,
    ownerId: manifest.ownerId ?? null,
    ownerHeartbeatAt: manifest.ownerHeartbeatAt ?? null,
    transcriptText: manifest.transcriptText ?? null,
  };
}

function manifestAvailableToOwner(
  manifest: VoiceRecordingManifest,
  ownership?: { ownerId: string; staleBefore: string },
): boolean {
  if (!manifest.ownerId) return true;
  if (!ownership) return false;
  if (manifest.ownerId === ownership.ownerId) return true;
  return !manifest.ownerHeartbeatAt || manifest.ownerHeartbeatAt <= ownership.staleBefore;
}

function assertManifestOwnership(
  manifest: VoiceRecordingManifest,
  ownerId: string | undefined,
): void {
  if (manifest.ownerId !== (ownerId ?? null)) {
    throw new VoiceRecordingOwnedError(manifest.recordingId);
  }
}

function codecForMimeType(mimeType: string): string | null {
  const match = /(?:^|;)\s*codecs?\s*=\s*"?([^;"]+)/iu.exec(mimeType);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
        database.createObjectStore(MANIFEST_STORE, { keyPath: "recordingId" });
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = database.createObjectStore(CHUNK_STORE, {
          keyPath: ["recordingId", "chunkNumber"],
        });
        chunks.createIndex(CHUNKS_BY_RECORDING, "recordingId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open voice storage."));
    request.onblocked = () => reject(new Error("Voice recording storage upgrade is blocked."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Voice recording storage failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Voice storage aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Voice storage failed."));
  });
}
