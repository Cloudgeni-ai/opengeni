/**
 * Local-first meeting recording for any JavaScript host.
 *
 * {@link OpenGeniRecordingsClient} is the typed client for the recordings API.
 * Capture never waits on the network: every chunk is written to a local
 * {@link RecordingChunkStore} first, then a {@link RecordingUploader} pushes
 * it straight to object storage through presigned URLs and confirms it.
 * A reload, a crash or an hour offline loses nothing; {@link RecordingUploader.resume}
 * finishes whatever an earlier page left behind.
 *
 * - {@link createBrowserRecorder} captures the microphone and, where the
 *   browser can share it, a tab's or the system's audio, as separate tracks.
 * - Other hosts (React Native, desktop shells) feed their own encoded chunks
 *   to a {@link RecordingUploader} with {@link RecordingUploader.addChunk}.
 */
import type {
  CompleteRecordingChunksRequest,
  CompleteRecordingChunksResponse,
  CreateRecordingPersonRequest,
  CreateRecordingRequest,
  CreateRecordingTranscriptRequest,
  CreateRecordingUploadsRequest,
  CreateRecordingUploadsResponse,
  FinalizeRecordingRequest,
  FinalizeRecordingResponse,
  ListRecordingModelsResponse,
  ListRecordingPeopleResponse,
  ListRecordingsResponse,
  ListRecordingTranscriptVersionsResponse,
  Recording,
  RecordingPerson,
  RecordingTrackAudio,
  RecordingTrackSource,
  RecordingTranscriptPage,
  RecordingTranscriptionOptions,
  RecordingTranscriptVersion,
  RecordingVisibility,
  UpdateRecordingRequest,
  UpdateRecordingSegmentsRequest,
  UpdateRecordingSegmentsResponse,
  UpdateRecordingSpeakersRequest,
  UpdateRecordingSpeakersResponse,
} from "@opengeni/contracts";
import type { OpenGeniClient } from "./client";

/** What {@link OpenGeniRecordingsClient} needs from the core client. */
export type OpenGeniRecordingsTransport = Pick<OpenGeniClient, "requestJson">;

/**
 * Typed client for the recordings API:
 * `new OpenGeniRecordingsClient(client).listRecordings(workspaceId)`.
 */
export class OpenGeniRecordingsClient {
  constructor(private readonly client: OpenGeniRecordingsTransport) {}

  // A recording is one or more audio tracks captured on the client. Record
  // locally, reserve chunks to get presigned PUT URLs, upload the bytes
  // straight to storage, confirm them, then finalize. Every step is
  // idempotent, so a client resumes after a lost connection or a reload.
  // RecordingUploader below does all of that from a local-first store.

  /** Recordings the caller can see, newest first. */
  async listRecordings(
    workspaceId: string,
    options: {
      query?: string;
      externalRef?: string;
      before?: { startedAt: string; id: string };
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ListRecordingsResponse> {
    return await this.client.requestJson<ListRecordingsResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings`,
      undefined,
      {
        ...(options.query ? { query: options.query } : {}),
        ...(options.externalRef ? { externalRef: options.externalRef } : {}),
        ...(options.before
          ? { beforeStartedAt: options.before.startedAt, beforeId: options.before.id }
          : {}),
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
      options.signal ? { signal: options.signal } : {},
    );
  }

  /** Create a recording with a client-chosen id; creating the same id again returns it. */
  async createRecording(workspaceId: string, request: CreateRecordingRequest): Promise<Recording> {
    return await this.client.requestJson<Recording>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings`,
      request,
    );
  }

  async getRecording(
    workspaceId: string,
    recordingId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Recording> {
    return await this.client.requestJson<Recording>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}`,
      undefined,
      {},
      options.signal ? { signal: options.signal } : {},
    );
  }

  async updateRecording(
    workspaceId: string,
    recordingId: string,
    request: UpdateRecordingRequest,
  ): Promise<Recording> {
    return await this.client.requestJson<Recording>(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}`,
      request,
    );
  }

  /** Delete a recording with its audio, transcripts and speaker matches. Only the owner can. */
  async deleteRecording(workspaceId: string, recordingId: string): Promise<void> {
    await this.client.requestJson<void>(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}`,
      undefined,
      {},
      { responseType: "void" },
    );
  }

  /** Reserve chunks of one track and get presigned URLs to PUT their bytes to. */
  async createRecordingUploads(
    workspaceId: string,
    recordingId: string,
    request: CreateRecordingUploadsRequest,
  ): Promise<CreateRecordingUploadsResponse> {
    return await this.client.requestJson<CreateRecordingUploadsResponse>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/uploads`,
      request,
    );
  }

  /** Confirm uploaded chunks; the server checks storage and reports any still missing. */
  async completeRecordingChunks(
    workspaceId: string,
    recordingId: string,
    request: CompleteRecordingChunksRequest,
  ): Promise<CompleteRecordingChunksResponse> {
    return await this.client.requestJson<CompleteRecordingChunksResponse>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/chunks/complete`,
      request,
    );
  }

  /** End capture and start transcription. Finalizing again is safe. */
  async finalizeRecording(
    workspaceId: string,
    recordingId: string,
    request: FinalizeRecordingRequest,
  ): Promise<FinalizeRecordingResponse> {
    return await this.client.requestJson<FinalizeRecordingResponse>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/finalize`,
      request,
    );
  }

  async listRecordingTranscriptVersions(
    workspaceId: string,
    recordingId: string,
  ): Promise<RecordingTranscriptVersion[]> {
    const response = await this.client.requestJson<ListRecordingTranscriptVersionsResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/transcripts`,
    );
    return response.versions;
  }

  /** Transcribe the recording again, optionally with another model, as a new version. */
  async createRecordingTranscript(
    workspaceId: string,
    recordingId: string,
    request: CreateRecordingTranscriptRequest = {},
  ): Promise<RecordingTranscriptVersion> {
    return await this.client.requestJson<RecordingTranscriptVersion>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/transcripts`,
      request,
    );
  }

  /** One page of a transcript: the current version unless `versionId` names another. */
  async getRecordingTranscript(
    workspaceId: string,
    recordingId: string,
    options: { versionId?: string; after?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<RecordingTranscriptPage> {
    return await this.client.requestJson<RecordingTranscriptPage>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/transcript`,
      undefined,
      {
        ...(options.versionId ? { version: options.versionId } : {}),
        ...(options.after !== undefined ? { after: String(options.after) } : {}),
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
      options.signal ? { signal: options.signal } : {},
    );
  }

  /** Make a completed version the one everyone sees. */
  async setCurrentRecordingTranscript(
    workspaceId: string,
    recordingId: string,
    versionId: string,
  ): Promise<RecordingTranscriptVersion> {
    return await this.client.requestJson<RecordingTranscriptVersion>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/transcripts/${encodeURIComponent(versionId)}/current`,
    );
  }

  /** Name, merge or reassign speakers in one version (the current one by default). */
  async updateRecordingSpeakers(
    workspaceId: string,
    recordingId: string,
    request: UpdateRecordingSpeakersRequest,
    options: { versionId?: string } = {},
  ): Promise<UpdateRecordingSpeakersResponse> {
    return await this.client.requestJson<UpdateRecordingSpeakersResponse>(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/speakers`,
      request,
      options.versionId ? { version: options.versionId } : {},
    );
  }

  /** Correct segment text in one version; `text: null` restores the original. */
  async updateRecordingSegments(
    workspaceId: string,
    recordingId: string,
    request: UpdateRecordingSegmentsRequest,
    options: { versionId?: string } = {},
  ): Promise<UpdateRecordingSegmentsResponse> {
    return await this.client.requestJson<UpdateRecordingSegmentsResponse>(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/segments`,
      request,
      options.versionId ? { version: options.versionId } : {},
    );
  }

  /** A short-lived link to one track's prepared audio; 409 `audio_not_ready` while processing. */
  async getRecordingTrackAudio(
    workspaceId: string,
    recordingId: string,
    trackNumber: number,
  ): Promise<RecordingTrackAudio> {
    return await this.client.requestJson<RecordingTrackAudio>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/tracks/${trackNumber}/audio`,
    );
  }

  /** The organization's people directory, used to name speakers. */
  async listRecordingPeople(
    workspaceId: string,
    options: { query?: string } = {},
  ): Promise<RecordingPerson[]> {
    const response = await this.client.requestJson<ListRecordingPeopleResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recording-people`,
      undefined,
      options.query ? { query: options.query } : {},
    );
    return response.people;
  }

  async createRecordingPerson(
    workspaceId: string,
    request: CreateRecordingPersonRequest,
  ): Promise<RecordingPerson> {
    return await this.client.requestJson<RecordingPerson>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recording-people`,
      request,
    );
  }

  /** Transcription models this workspace can use, with their capabilities and default. */
  async listRecordingModels(workspaceId: string): Promise<ListRecordingModelsResponse> {
    return await this.client.requestJson<ListRecordingModelsResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recording-models`,
    );
  }
}

/** The client calls a recorder needs. An {@link OpenGeniRecordingsClient} satisfies it. */
export type RecordingTransport = Pick<
  OpenGeniRecordingsClient,
  | "createRecording"
  | "createRecordingUploads"
  | "completeRecordingChunks"
  | "finalizeRecording"
  | "deleteRecording"
>;

/** One encoded piece of one track, as captured. */
export type RecordingChunk = {
  recordingId: string;
  trackNumber: number;
  chunkNumber: number;
  bytes: Uint8Array;
  /** Lowercase hex SHA-256 of `bytes`. */
  sha256: string;
  /** When the chunk's audio starts, from the start of the recording. */
  startMilliseconds: number;
  durationMilliseconds: number;
};

/** What the local store knows about a recording until the server has all of it. */
export type StoredRecording = {
  workspaceId: string;
  recordingId: string;
  create: CreateRecordingRequest;
  /** The server has the recording. */
  created: boolean;
  /** `stopped` once capture ended; the recording is then finalized after its last upload. */
  phase: "capturing" | "stopped";
  endedAt: string | null;
  /** Chunks captured so far per track number. */
  chunkCounts: Record<number, number>;
  updatedAt: number;
};

/** Durable local storage for chunks that are not confirmed by the server yet. */
export interface RecordingChunkStore {
  putRecording(recording: StoredRecording): Promise<void>;
  getRecording(recordingId: string): Promise<StoredRecording | null>;
  listRecordings(): Promise<StoredRecording[]>;
  /** Removes the recording and every chunk it still has. */
  deleteRecording(recordingId: string): Promise<void>;
  putChunk(chunk: RecordingChunk): Promise<void>;
  /** Every stored chunk of the recording, ordered by track then chunk number. */
  listChunks(recordingId: string): Promise<RecordingChunk[]>;
  deleteChunks(recordingId: string, trackNumber: number, chunkNumbers: number[]): Promise<void>;
}

export type RecordingUploadStatus = {
  recordingId: string;
  /** Chunks stored locally and not confirmed by the server yet. */
  pendingChunks: number;
  pendingBytes: number;
  /** A transfer is running now. */
  uploading: boolean;
  /** The last transfer failed and will be retried; null once a retry succeeds. */
  retryingAfterError: string | null;
  /** A failure retrying cannot fix, such as the recording being deleted elsewhere. */
  failed: { code: string; message: string } | null;
  finalized: boolean;
};

const UPLOAD_BATCH = 50;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export type RecordingUploaderOptions = {
  client: RecordingTransport;
  store: RecordingChunkStore;
  /** Used for the presigned PUTs. Defaults to the global fetch. */
  fetch?: typeof fetch;
  onStatus?: (status: RecordingUploadStatus) => void;
  /** Recordings another live recorder owns; resume() leaves them alone. Defaults to Web Locks. */
  isCaptureActive?: (recordingId: string) => Promise<boolean>;
  /** Overridable for tests. */
  sleep?: (milliseconds: number) => Promise<void>;
};

type Pump = {
  running: Promise<void> | null;
  again: boolean;
  status: RecordingUploadStatus;
  waiters: Array<() => void>;
  wake: (() => void) | null;
  backoff: number;
};

class PermanentRecordingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PermanentRecordingError";
  }
}

/**
 * Pushes locally stored chunks to the server and finalizes stopped
 * recordings. One uploader can serve many recordings; each runs serially.
 */
export class RecordingUploader {
  private readonly pumps = new Map<string, Pump>();
  private readonly listeners = new Set<(status: RecordingUploadStatus) => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private disposed = false;
  private readonly onOnline = () => {
    for (const pump of this.pumps.values()) pump.wake?.();
  };

  constructor(private readonly options: RecordingUploaderOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
    if (options.onStatus) this.listeners.add(options.onStatus);
    globalThis.addEventListener?.("online", this.onOnline);
  }

  /** Listen to upload progress of every recording; returns an unsubscribe function. */
  subscribe(listener: (status: RecordingUploadStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop background work. Stored chunks stay for a later resume(). */
  dispose(): void {
    this.disposed = true;
    globalThis.removeEventListener?.("online", this.onOnline);
    for (const pump of this.pumps.values()) pump.wake?.();
  }

  /** Remember a new recording locally and start telling the server about it. */
  async begin(
    recording: Omit<StoredRecording, "created" | "updatedAt" | "phase" | "endedAt" | "chunkCounts">,
  ): Promise<void> {
    await this.options.store.putRecording({
      ...recording,
      created: false,
      phase: "capturing",
      endedAt: null,
      chunkCounts: Object.fromEntries(
        recording.create.tracks.map((track) => [track.trackNumber, 0]),
      ),
      updatedAt: Date.now(),
    });
    this.kick(recording.recordingId);
  }

  /** Store one captured chunk locally, then upload it in the background. */
  async addChunk(chunk: RecordingChunk): Promise<void> {
    const store = this.options.store;
    await store.putChunk(chunk);
    const recording = await store.getRecording(chunk.recordingId);
    if (recording) {
      const count = Math.max(recording.chunkCounts[chunk.trackNumber] ?? 0, chunk.chunkNumber + 1);
      await store.putRecording({
        ...recording,
        chunkCounts: { ...recording.chunkCounts, [chunk.trackNumber]: count },
        updatedAt: Date.now(),
      });
    }
    this.kick(chunk.recordingId);
  }

  /**
   * Capture is over: upload what is left, then finalize, which starts
   * transcription. Resolves once the server has every chunk, retrying while
   * offline; pass a signal to stop waiting (the upload continues).
   */
  async finish(
    recordingId: string,
    options: { endedAt?: Date; signal?: AbortSignal } = {},
  ): Promise<RecordingUploadStatus> {
    const store = this.options.store;
    const recording = await store.getRecording(recordingId);
    if (recording && recording.phase === "capturing") {
      await store.putRecording({
        ...recording,
        phase: "stopped",
        endedAt: (options.endedAt ?? new Date()).toISOString(),
        updatedAt: Date.now(),
      });
    }
    return await this.settled(recordingId, options.signal);
  }

  /** Throw a recording away: its local chunks and whatever the server already has. */
  async discard(recordingId: string): Promise<void> {
    const store = this.options.store;
    const recording = await store.getRecording(recordingId);
    await store.deleteRecording(recordingId);
    this.pumps.delete(recordingId);
    if (recording?.created) {
      await this.options.client
        .deleteRecording(recording.workspaceId, recordingId)
        .catch((error: unknown) => {
          if ((error as { status?: unknown }).status !== 404) throw error;
        });
    }
  }

  /**
   * Finish every recording an earlier page or app run left behind: upload its
   * stored chunks and finalize it with what was captured. Recordings a live
   * recorder still owns are skipped.
   */
  async resume(): Promise<string[]> {
    const store = this.options.store;
    const resumed: string[] = [];
    for (const recording of await store.listRecordings()) {
      if (await this.captureActive(recording.recordingId)) continue;
      if (recording.phase === "capturing") {
        await store.putRecording({
          ...recording,
          phase: "stopped",
          endedAt: new Date(recording.updatedAt).toISOString(),
          updatedAt: Date.now(),
        });
      }
      resumed.push(recording.recordingId);
      this.kick(recording.recordingId);
    }
    return resumed;
  }

  status(recordingId: string): RecordingUploadStatus | null {
    return this.pumps.get(recordingId)?.status ?? null;
  }

  /** The finalize result, once a finished recording is on the server. */
  readonly finalized = new Map<string, FinalizeRecordingResponse>();

  private async captureActive(recordingId: string): Promise<boolean> {
    if (this.options.isCaptureActive) return await this.options.isCaptureActive(recordingId);
    return await recordingLockHeld(recordingId);
  }

  private async settled(recordingId: string, signal?: AbortSignal): Promise<RecordingUploadStatus> {
    const pump = this.kick(recordingId);
    for (;;) {
      signal?.throwIfAborted();
      if (pump.status.finalized || pump.status.failed) return pump.status;
      await new Promise<void>((done, fail) => {
        const onAbort = () => fail(signal!.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        pump.waiters.push(() => {
          signal?.removeEventListener("abort", onAbort);
          done();
        });
      });
    }
  }

  private kick(recordingId: string): Pump {
    let pump = this.pumps.get(recordingId);
    if (!pump) {
      pump = {
        running: null,
        again: false,
        wake: null,
        backoff: MIN_BACKOFF_MS,
        waiters: [],
        status: {
          recordingId,
          pendingChunks: 0,
          pendingBytes: 0,
          uploading: false,
          retryingAfterError: null,
          failed: null,
          finalized: false,
        },
      };
      this.pumps.set(recordingId, pump);
    }
    pump.again = true;
    pump.wake?.();
    if (!pump.running && !this.disposed) {
      const current = pump;
      current.running = this.run(recordingId, current).finally(() => {
        current.running = null;
      });
    }
    return pump;
  }

  private update(pump: Pump, patch: Partial<RecordingUploadStatus>): void {
    pump.status = { ...pump.status, ...patch };
    for (const listener of this.listeners) listener(pump.status);
    const waiters = pump.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private async run(recordingId: string, pump: Pump): Promise<void> {
    while (pump.again && !this.disposed) {
      pump.again = false;
      try {
        const done = await this.step(recordingId, pump);
        pump.backoff = MIN_BACKOFF_MS;
        if (pump.status.retryingAfterError) this.update(pump, { retryingAfterError: null });
        if (done) return;
      } catch (error) {
        if (error instanceof PermanentRecordingError) {
          this.update(pump, {
            uploading: false,
            failed: { code: error.code, message: error.message },
          });
          return;
        }
        this.update(pump, { uploading: false, retryingAfterError: errorMessage(error) });
        const delay = pump.backoff;
        pump.backoff = Math.min(pump.backoff * 2, MAX_BACKOFF_MS);
        await new Promise<void>((done) => {
          const finish = () => {
            pump.wake = null;
            done();
          };
          pump.wake = finish;
          void this.sleep(delay).then(finish);
        });
        pump.again = true;
      }
    }
  }

  /** One pass: create, upload everything stored, finalize when stopped. True when nothing is left. */
  private async step(recordingId: string, pump: Pump): Promise<boolean> {
    const { store, client } = this.options;
    let recording = await store.getRecording(recordingId);
    if (!recording) {
      // Finalized earlier (its local copy is removed then) or discarded: nothing is left to send.
      this.update(pump, { pendingChunks: 0, pendingBytes: 0, uploading: false, finalized: true });
      return true;
    }
    if (!recording.created) {
      await guarded(() => client.createRecording(recording!.workspaceId, recording!.create));
      recording = { ...recording, created: true, updatedAt: Date.now() };
      await store.putRecording(recording);
    }
    let chunks = await store.listChunks(recordingId);
    this.update(pump, {
      pendingChunks: chunks.length,
      pendingBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0),
      uploading: chunks.length > 0,
    });
    let alreadyFinalized = false;
    while (chunks.length > 0) {
      const trackNumber = chunks[0]!.trackNumber;
      const batch = chunks
        .filter((chunk) => chunk.trackNumber === trackNumber)
        .slice(0, UPLOAD_BATCH);
      try {
        await this.uploadBatch(recording, batch);
      } catch (error) {
        // Another device or an earlier attempt already finalized it: the server has what it needs.
        if (error instanceof PermanentRecordingError && error.code === "not_capturing") {
          alreadyFinalized = true;
          break;
        }
        throw error;
      }
      chunks = await store.listChunks(recordingId);
      this.update(pump, {
        pendingChunks: chunks.length,
        pendingBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0),
      });
    }
    this.update(pump, { uploading: false });
    recording = (await store.getRecording(recordingId)) ?? recording;
    if (recording.phase !== "stopped") return !pump.again;
    const finalized = await guarded(() =>
      client.finalizeRecording(recording!.workspaceId, recordingId, {
        ...(recording!.endedAt ? { endedAt: recording!.endedAt } : {}),
        tracks: Object.entries(recording!.chunkCounts).map(([track, chunkCount]) => ({
          trackNumber: Number(track),
          chunkCount,
        })),
      }),
    ).catch((error: unknown) => {
      if (alreadyFinalized && error instanceof PermanentRecordingError) return null;
      throw error;
    });
    if (finalized) this.finalized.set(recordingId, finalized);
    await store.deleteRecording(recordingId);
    this.update(pump, { pendingChunks: 0, pendingBytes: 0, finalized: true });
    return true;
  }

  private async uploadBatch(recording: StoredRecording, batch: RecordingChunk[]): Promise<void> {
    const { client, store } = this.options;
    const trackNumber = batch[0]!.trackNumber;
    const { uploads } = await guarded(() =>
      client.createRecordingUploads(recording.workspaceId, recording.recordingId, {
        trackNumber,
        chunks: batch.map((chunk) => ({
          chunkNumber: chunk.chunkNumber,
          byteLength: chunk.bytes.byteLength,
          sha256: chunk.sha256,
          startMilliseconds: Math.max(0, Math.round(chunk.startMilliseconds)),
          durationMilliseconds: Math.max(0, Math.round(chunk.durationMilliseconds)),
        })),
      }),
    );
    const byNumber = new Map(batch.map((chunk) => [chunk.chunkNumber, chunk]));
    const put: number[] = [];
    for (const upload of uploads) {
      const chunk = byNumber.get(upload.chunkNumber);
      if (!chunk) continue;
      if (upload.uploaded || !upload.url) {
        put.push(upload.chunkNumber);
        continue;
      }
      const response = await this.fetchImpl(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: chunk.bytes as unknown as BodyInit,
      });
      if (!response.ok) {
        // An expired or refused URL: the next pass reserves again and gets a fresh one.
        throw new Error(`Storage refused a chunk upload (HTTP ${response.status}).`);
      }
      put.push(upload.chunkNumber);
    }
    if (put.length === 0) return;
    const result = await guarded(() =>
      client.completeRecordingChunks(recording.workspaceId, recording.recordingId, {
        trackNumber,
        chunkNumbers: put,
      }),
    );
    if (result.uploaded.length > 0) {
      await store.deleteChunks(recording.recordingId, trackNumber, result.uploaded);
    }
    if (result.missing.length > 0) {
      throw new Error(`${result.missing.length} chunk(s) did not reach storage; retrying.`);
    }
  }
}

/** Turn API refusals that retrying cannot fix into a permanent error. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const retryable = (error as { retryable?: unknown }).retryable;
    if (typeof status === "number" && status >= 400 && status < 500 && retryable !== true) {
      const details = (error as { details?: { code?: unknown } }).details;
      const code =
        typeof details?.code === "string"
          ? details.code
          : typeof (error as { code?: unknown }).code === "string"
            ? String((error as { code: string }).code)
            : `http_${status}`;
      throw new PermanentRecordingError(code, errorMessage(error));
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Local stores -------------------------------------------------------------

/** A store that lives only as long as the page or process. For tests and short captures. */
export function createMemoryRecordingChunkStore(): RecordingChunkStore {
  const recordings = new Map<string, StoredRecording>();
  const chunks = new Map<string, RecordingChunk>();
  const key = (recordingId: string, track: number, chunk: number) =>
    `${recordingId}:${track}:${chunk}`;
  return {
    async putRecording(recording) {
      recordings.set(recording.recordingId, structuredClone(recording));
    },
    async getRecording(recordingId) {
      const found = recordings.get(recordingId);
      return found ? structuredClone(found) : null;
    },
    async listRecordings() {
      return [...recordings.values()].map((recording) => structuredClone(recording));
    },
    async deleteRecording(recordingId) {
      recordings.delete(recordingId);
      for (const [id, chunk] of chunks) if (chunk.recordingId === recordingId) chunks.delete(id);
    },
    async putChunk(chunk) {
      chunks.set(key(chunk.recordingId, chunk.trackNumber, chunk.chunkNumber), chunk);
    },
    async listChunks(recordingId) {
      return [...chunks.values()]
        .filter((chunk) => chunk.recordingId === recordingId)
        .sort((a, b) => a.trackNumber - b.trackNumber || a.chunkNumber - b.chunkNumber);
    },
    async deleteChunks(recordingId, trackNumber, chunkNumbers) {
      for (const chunk of chunkNumbers) chunks.delete(key(recordingId, trackNumber, chunk));
    },
  };
}

const IDB_VERSION = 1;

/**
 * A browser store in IndexedDB that survives reloads, crashes and closed tabs.
 * Asks the browser to keep it from eviction where it can.
 */
export function createIndexedDbRecordingChunkStore(
  options: { databaseName?: string; indexedDB?: IDBFactory } = {},
): RecordingChunkStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory)
    throw new Error("IndexedDB is not available here; use another RecordingChunkStore.");
  const name = options.databaseName ?? "opengeni-recordings";
  let opening: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("recordings")) {
          db.createObjectStore("recordings", { keyPath: "recordingId" });
        }
        if (!db.objectStoreNames.contains("chunks")) {
          const chunks = db.createObjectStore("chunks", {
            keyPath: ["recordingId", "trackNumber", "chunkNumber"],
          });
          chunks.createIndex("recordingId", "recordingId");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
      void globalThis.navigator?.storage?.persist?.().catch(() => false);
    }));
  const run = async <T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => IDBRequest<T> | void,
  ): Promise<T> => {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const request = work(tx);
      tx.oncomplete = () => resolve((request ? request.result : undefined) as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  };
  return {
    async putRecording(recording) {
      await run(["recordings"], "readwrite", (tx) => tx.objectStore("recordings").put(recording));
    },
    async getRecording(recordingId) {
      const found = await run<StoredRecording | undefined>(["recordings"], "readonly", (tx) =>
        tx.objectStore("recordings").get(recordingId),
      );
      return found ?? null;
    },
    async listRecordings() {
      return await run<StoredRecording[]>(["recordings"], "readonly", (tx) =>
        tx.objectStore("recordings").getAll(),
      );
    },
    async deleteRecording(recordingId) {
      await run(["recordings", "chunks"], "readwrite", (tx) => {
        const chunks = tx.objectStore("chunks");
        const keys = chunks.index("recordingId").getAllKeys(recordingId);
        keys.onsuccess = () => {
          for (const key of keys.result) chunks.delete(key);
        };
        tx.objectStore("recordings").delete(recordingId);
      });
    },
    async putChunk(chunk) {
      await run(["chunks"], "readwrite", (tx) => tx.objectStore("chunks").put(chunk));
    },
    async listChunks(recordingId) {
      // The index orders equal keys by primary key: track number, then chunk number.
      return await run<RecordingChunk[]>(["chunks"], "readonly", (tx) =>
        tx.objectStore("chunks").index("recordingId").getAll(recordingId),
      );
    },
    async deleteChunks(recordingId, trackNumber, chunkNumbers) {
      await run(["chunks"], "readwrite", (tx) => {
        const chunks = tx.objectStore("chunks");
        for (const chunk of chunkNumbers) chunks.delete([recordingId, trackNumber, chunk]);
      });
    },
  };
}

// --- Capture locks --------------------------------------------------------------

const LOCK_PREFIX = "opengeni-recording:";

type LockManagerLike = {
  request(name: string, callback: () => Promise<void>): Promise<void>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
};

function lockManager(): LockManagerLike | null {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

async function recordingLockHeld(recordingId: string): Promise<boolean> {
  const locks = lockManager();
  if (!locks) return false;
  const state = await locks.query();
  return (state.held ?? []).some((lock) => lock.name === `${LOCK_PREFIX}${recordingId}`);
}

/** Hold the recording's capture lock (across tabs) until release() is called. */
function holdRecordingLock(recordingId: string): { release: () => void } {
  const locks = lockManager();
  let release = () => {};
  if (locks) {
    const held = new Promise<void>((done) => {
      release = done;
    });
    void locks.request(`${LOCK_PREFIX}${recordingId}`, () => held).catch(() => undefined);
  }
  return { release: () => release() };
}

// --- Browser capture -------------------------------------------------------------

export type BrowserRecorderState =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

export type BrowserRecorderSnapshot = {
  state: BrowserRecorderState;
  recordingId: string | null;
  /** Recorded time, excluding pauses. */
  elapsedMilliseconds: number;
  tracks: Array<{ trackNumber: number; source: RecordingTrackSource; label: string }>;
  upload: RecordingUploadStatus | null;
  error: { code: BrowserRecorderErrorCode; message: string } | null;
};

export type BrowserRecorderErrorCode =
  | "microphone_denied"
  | "microphone_unavailable"
  | "system_audio_unavailable"
  | "system_audio_not_shared"
  | "unsupported"
  | "capture_failed"
  | "upload_failed";

export type BrowserRecorderOptions = {
  client: RecordingTransport;
  workspaceId: string;
  /** Defaults to IndexedDB, so nothing is lost on reload. */
  store?: RecordingChunkStore;
  /** Share one uploader between recorders; one is created otherwise. */
  uploader?: RecordingUploader;
  title?: string;
  visibility?: RecordingVisibility;
  externalRef?: string;
  metadata?: CreateRecordingRequest["metadata"];
  transcription?: RecordingTranscriptionOptions;
  /** Microphone constraints; false records no microphone. Default: on. */
  microphone?: boolean | MediaTrackConstraints;
  /** Also record a tab's or the system's audio (Chromium browsers). Default: off. */
  systemAudio?: boolean;
  /** How often a chunk is cut and saved. Default 5 seconds. */
  timesliceMilliseconds?: number;
  /** Keep the screen awake while recording on phones. Default: on. */
  keepAwake?: boolean;
  onChange?: (snapshot: BrowserRecorderSnapshot) => void;
};

export type BrowserRecorder = {
  readonly snapshot: BrowserRecorderSnapshot;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Stop capture; resolves when the server has every chunk and transcription has started. */
  stop(options?: { signal?: AbortSignal }): Promise<RecordingUploadStatus | null>;
  /** Stop and throw everything away, local and on the server's side of the upload. */
  discard(): Promise<void>;
  /** Current input level per track, 0 to 1, for a meter. */
  levels(): Record<number, number>;
};

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

/** The audio format this browser records in, or null when it cannot record. */
export function preferredRecordingMimeType(): string | null {
  const recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!recorder) return null;
  if (typeof recorder.isTypeSupported !== "function") return "";
  return PREFERRED_MIME_TYPES.find((type) => recorder.isTypeSupported(type)) ?? "";
}

/** Whether this browser can share a tab's or the system's audio (Chromium on desktop). */
export function canCaptureSystemAudio(): boolean {
  const media = globalThis.navigator?.mediaDevices;
  if (!media || typeof media.getDisplayMedia !== "function") return false;
  const agent = globalThis.navigator.userAgent ?? "";
  const chromium = /\b(Chrome|Chromium|Edg)\//u.test(agent) && !/\bMobile\b/u.test(agent);
  return chromium;
}

/** SHA-256 of bytes as lowercase hex, with Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type TrackCapture = {
  trackNumber: number;
  source: RecordingTrackSource;
  label: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  analyser: AnalyserNode | null;
  nextChunk: number;
  chunkStartedAt: number;
  writes: Promise<void>;
};

/**
 * Record the microphone and, optionally, shared tab or system audio in the
 * browser, each as its own track, saving every few seconds locally and
 * uploading in the background.
 */
export function createBrowserRecorder(options: BrowserRecorderOptions): BrowserRecorder {
  let snapshot: BrowserRecorderSnapshot = {
    state: "idle",
    recordingId: null,
    elapsedMilliseconds: 0,
    tracks: [],
    upload: null,
    error: null,
  };
  const emit = (patch: Partial<BrowserRecorderSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    options.onChange?.(snapshot);
  };
  const uploader =
    options.uploader ??
    new RecordingUploader({
      client: options.client,
      store: options.store ?? createIndexedDbRecordingChunkStore(),
    });
  let unsubscribe: (() => void) | null = null;
  const watchUploads = () => {
    unsubscribe ??= uploader.subscribe((status) => {
      if (status.recordingId !== snapshot.recordingId) return;
      emit({
        upload: status,
        ...(status.failed
          ? { error: { code: "upload_failed" as const, message: status.failed.message } }
          : {}),
      });
    });
  };
  const captures: TrackCapture[] = [];
  let audioContext: AudioContext | null = null;
  let lock: { release: () => void } | null = null;
  let wakeLock: { release(): Promise<void> } | null = null;
  let startedAt = 0;
  let pausedAt: number | null = null;
  let pausedTotal = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  const elapsed = () => Math.max(0, (pausedAt ?? performance.now()) - startedAt - pausedTotal);
  const onHidden = () => {
    if (globalThis.document?.visibilityState === "hidden") {
      for (const capture of captures) {
        if (capture.recorder.state === "recording") capture.recorder.requestData();
      }
    }
  };

  const fail = (code: BrowserRecorderErrorCode, message: string) => {
    emit({ state: "failed", error: { code, message } });
  };

  const cleanupMedia = () => {
    for (const capture of captures) {
      for (const track of capture.stream.getTracks()) track.stop();
    }
    void audioContext?.close().catch(() => undefined);
    audioContext = null;
    if (ticker) clearInterval(ticker);
    ticker = null;
    globalThis.document?.removeEventListener("visibilitychange", onHidden);
    void wakeLock?.release().catch(() => undefined);
    wakeLock = null;
  };

  const openStreams = async (): Promise<
    Array<Omit<TrackCapture, "recorder" | "analyser" | "nextChunk" | "chunkStartedAt" | "writes">>
  > => {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia)
      throw new CaptureError("unsupported", "This browser cannot record audio.");
    const opened: Array<
      Omit<TrackCapture, "recorder" | "analyser" | "nextChunk" | "chunkStartedAt" | "writes">
    > = [];
    try {
      if (options.microphone !== false) {
        const constraints: MediaTrackConstraints =
          typeof options.microphone === "object"
            ? options.microphone
            : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        let stream: MediaStream;
        try {
          stream = await media.getUserMedia({ audio: constraints });
        } catch (error) {
          const name = (error as { name?: string }).name;
          throw new CaptureError(
            name === "NotAllowedError" || name === "SecurityError"
              ? "microphone_denied"
              : "microphone_unavailable",
            name === "NotAllowedError" || name === "SecurityError"
              ? "Microphone access was not allowed."
              : "No microphone could be opened.",
          );
        }
        opened.push({
          trackNumber: 0,
          source: "microphone",
          label: stream.getAudioTracks()[0]?.label || "Microphone",
          stream,
        });
      }
      if (options.systemAudio) {
        if (!media.getDisplayMedia) {
          throw new CaptureError(
            "system_audio_unavailable",
            "This browser cannot share tab or system audio.",
          );
        }
        let display: MediaStream;
        try {
          display = await media.getDisplayMedia({ audio: true, video: true });
        } catch {
          throw new CaptureError("system_audio_not_shared", "Audio sharing was cancelled.");
        }
        for (const track of display.getVideoTracks()) {
          track.stop();
          display.removeTrack(track);
        }
        const audio = display.getAudioTracks();
        if (audio.length === 0) {
          throw new CaptureError(
            "system_audio_not_shared",
            "No audio was shared. Choose a tab or screen and turn on audio sharing.",
          );
        }
        opened.push({
          trackNumber: opened.length,
          source: "system",
          label: audio[0]?.label || "Shared audio",
          stream: display,
        });
      }
    } catch (error) {
      for (const item of opened) for (const track of item.stream.getTracks()) track.stop();
      throw error;
    }
    if (opened.length === 0) {
      throw new CaptureError("unsupported", "Choose at least one audio source to record.");
    }
    return opened;
  };

  const saveChunk = async (capture: TrackCapture, data: Blob, recordingId: string) => {
    const now = elapsed();
    const start = capture.chunkStartedAt;
    capture.chunkStartedAt = now;
    if (data.size === 0) return;
    const chunkNumber = capture.nextChunk++;
    const bytes = new Uint8Array(await data.arrayBuffer());
    await uploader.addChunk({
      recordingId,
      trackNumber: capture.trackNumber,
      chunkNumber,
      bytes,
      sha256: await sha256Hex(bytes),
      startMilliseconds: start,
      durationMilliseconds: Math.max(0, now - start),
    });
  };

  return {
    get snapshot() {
      return snapshot;
    },

    async start() {
      if (
        snapshot.state !== "idle" &&
        snapshot.state !== "failed" &&
        snapshot.state !== "stopped"
      ) {
        return;
      }
      const mimeType = preferredRecordingMimeType();
      if (mimeType === null) {
        fail("unsupported", "This browser cannot record audio.");
        return;
      }
      emit({ state: "starting", error: null, upload: null, elapsedMilliseconds: 0 });
      let streams: Awaited<ReturnType<typeof openStreams>>;
      try {
        streams = await openStreams();
      } catch (error) {
        if (error instanceof CaptureError) fail(error.code, error.message);
        else fail("capture_failed", errorMessage(error));
        return;
      }
      const recordingId = crypto.randomUUID();
      const AudioContextClass =
        (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      audioContext = AudioContextClass ? new AudioContextClass() : null;
      captures.length = 0;
      for (const item of streams) {
        const recorder = new MediaRecorder(item.stream, {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: 32_000,
        });
        let analyser: AnalyserNode | null = null;
        if (audioContext) {
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 512;
          audioContext.createMediaStreamSource(item.stream).connect(analyser);
        }
        captures.push({
          ...item,
          recorder,
          analyser,
          nextChunk: 0,
          chunkStartedAt: 0,
          writes: Promise.resolve(),
        });
      }
      const recordedType = captures[0]!.recorder.mimeType || mimeType || "audio/webm";
      watchUploads();
      emit({ recordingId });
      await uploader.begin({
        workspaceId: options.workspaceId,
        recordingId,
        create: {
          recordingId,
          ...(options.title ? { title: options.title } : {}),
          ...(options.visibility ? { visibility: options.visibility } : {}),
          startedAt: new Date().toISOString(),
          ...(options.externalRef ? { externalRef: options.externalRef } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.transcription ? { transcription: options.transcription } : {}),
          tracks: captures.map((capture) => ({
            trackNumber: capture.trackNumber,
            source: capture.source,
            mimeType: capture.recorder.mimeType || recordedType,
          })),
        },
      });
      lock = holdRecordingLock(recordingId);
      startedAt = performance.now();
      pausedAt = null;
      pausedTotal = 0;
      for (const capture of captures) {
        capture.recorder.ondataavailable = (event) => {
          // Chain writes so chunks of a track are stored in order.
          capture.writes = capture.writes
            .then(() => saveChunk(capture, event.data, recordingId))
            .catch((error: unknown) => fail("capture_failed", errorMessage(error)));
        };
        for (const track of capture.stream.getAudioTracks()) {
          track.addEventListener("ended", () => {
            // The person stopped sharing, or the device went away: keep the other tracks.
            if (capture.recorder.state !== "inactive") capture.recorder.stop();
          });
        }
        capture.recorder.start(options.timesliceMilliseconds ?? 5_000);
      }
      globalThis.document?.addEventListener("visibilitychange", onHidden);
      if (options.keepAwake !== false) {
        const wake = (
          globalThis.navigator as {
            wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
          }
        ).wakeLock;
        void wake
          ?.request("screen")
          .then((sentinel) => {
            wakeLock = sentinel;
          })
          .catch(() => undefined);
      }
      ticker = setInterval(() => emit({ elapsedMilliseconds: elapsed() }), 250);
      emit({
        state: "recording",
        recordingId,
        tracks: captures.map(({ trackNumber, source, label }) => ({ trackNumber, source, label })),
      });
    },

    pause() {
      if (snapshot.state !== "recording") return;
      for (const capture of captures)
        if (capture.recorder.state === "recording") capture.recorder.pause();
      pausedAt = performance.now();
      emit({ state: "paused", elapsedMilliseconds: elapsed() });
    },

    resume() {
      if (snapshot.state !== "paused") return;
      if (pausedAt !== null) pausedTotal += performance.now() - pausedAt;
      pausedAt = null;
      for (const capture of captures)
        if (capture.recorder.state === "paused") capture.recorder.resume();
      emit({ state: "recording" });
    },

    async stop(stopOptions = {}) {
      const recordingId = snapshot.recordingId;
      if (!recordingId || (snapshot.state !== "recording" && snapshot.state !== "paused")) {
        return snapshot.upload;
      }
      emit({ state: "stopping", elapsedMilliseconds: elapsed() });
      await Promise.all(
        captures.map(
          (capture) =>
            new Promise<void>((done) => {
              if (capture.recorder.state === "inactive") return done();
              capture.recorder.addEventListener("stop", () => done(), { once: true });
              capture.recorder.stop();
            }),
        ),
      );
      await Promise.all(captures.map((capture) => capture.writes));
      cleanupMedia();
      lock?.release();
      lock = null;
      const status = await uploader.finish(recordingId, { ...stopOptions, endedAt: new Date() });
      emit({
        state: status.failed ? "failed" : "stopped",
        upload: status,
        ...(status.failed
          ? { error: { code: "upload_failed" as const, message: status.failed.message } }
          : {}),
      });
      return status;
    },

    async discard() {
      const recordingId = snapshot.recordingId;
      for (const capture of captures) {
        capture.recorder.ondataavailable = null;
        if (capture.recorder.state !== "inactive") capture.recorder.stop();
      }
      cleanupMedia();
      lock?.release();
      lock = null;
      if (recordingId) await uploader.discard(recordingId);
      emit({ state: "idle", recordingId: null, elapsedMilliseconds: 0, tracks: [], upload: null });
    },

    levels() {
      const levels: Record<number, number> = {};
      for (const capture of captures) {
        if (!capture.analyser) continue;
        const samples = new Float32Array(capture.analyser.fftSize);
        capture.analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        // RMS mapped onto a perceptual-ish 0..1 scale.
        levels[capture.trackNumber] = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      }
      return levels;
    },
  };
}

class CaptureError extends Error {
  constructor(
    readonly code: BrowserRecorderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}
