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
 * - Other hosts (React Native, desktop shells) implement {@link Recorder} on
 *   their own capture and feed its encoded chunks to a {@link RecordingUploader}
 *   with {@link RecordingUploader.addChunk}; a {@link RecorderPlatform} hands
 *   such a recorder to the React hooks.
 */
import type {
  AppendRecordingLiveSegmentsRequest,
  CompleteRecordingChunksRequest,
  CompleteRecordingChunksResponse,
  CreateRecordingLiveSessionRequest,
  CreateRecordingPersonRequest,
  CreateRecordingRequest,
  CreateRecordingTranscriptRequest,
  CreateRecordingUploadsRequest,
  CreateRecordingUploadsResponse,
  FinalizeRecordingRequest,
  FinalizeRecordingResponse,
  ListRecordingModelsResponse,
  ListRecordingLiveSegmentsResponse,
  ListRecordingNotesResponse,
  ListRecordingPeopleResponse,
  ListRecordingsResponse,
  ListRecordingTranscriptVersionsResponse,
  Recording,
  RecordingLiveSession,
  RecordingNote,
  RecordingNoteKind,
  RecordingPerson,
  RecordingCapturePurpose,
  RecordingCaptureSource,
  RecordingTrackAudio,
  RecordingTranscriptPage,
  RecordingTranscriptionRequest,
  RecordingTranscriptVersion,
  RecordingVisibility,
  RememberRecordingPersonVoiceRequest,
  SaveRecordingNoteRequest,
  UpdateRecordingRequest,
  UpdateRecordingSegmentsRequest,
  UpdateRecordingSegmentsResponse,
  UpdateRecordingSpeakersRequest,
  UpdateRecordingSpeakersResponse,
} from "@opengeni/contracts";
import type { OpenGeniClient } from "./client";
import { type DesktopBridge, getDesktopBridge, getDesktopSystemAudio } from "./desktop-bridge";
import {
  createLiveTranscriber,
  type LiveTranscriber,
  type LiveTranscriptTrackSnapshot,
  type LiveTranscriptTransport,
  type LiveWebSocketConstructor,
} from "./recording-live";

export * from "./recording-live";

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
      /** Words in titles and current transcripts. */
      query?: string;
      /** A named speaker: a people-directory id, or part of their name. */
      person?: string;
      /** Started at or after this ISO date and time. */
      startedFrom?: string;
      /** Started before this ISO date and time. */
      startedTo?: string;
      externalRef?: string;
      /** meeting (the default), or the caller's own dictations not yet deleted. */
      purpose?: RecordingCapturePurpose;
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
        ...(options.person ? { person: options.person } : {}),
        ...(options.startedFrom ? { startedFrom: options.startedFrom } : {}),
        ...(options.startedTo ? { startedTo: options.startedTo } : {}),
        ...(options.externalRef ? { externalRef: options.externalRef } : {}),
        ...(options.purpose ? { purpose: options.purpose } : {}),
        ...(options.before
          ? {
              beforeStartedAt: options.before.startedAt,
              beforeId: options.before.id,
            }
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
    options: {
      versionId?: string;
      after?: number;
      limit?: number;
      signal?: AbortSignal;
    } = {},
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

  /**
   * Agree to have a person's voice remembered, so later meetings suggest
   * them by voice. Members agree for themselves (`self`); for someone outside
   * the workspace, the caller confirms they agreed (`attested`). Needs the
   * workspace to recognize voices (`settings.recordings.voiceprints`).
   */
  async rememberRecordingPersonVoice(
    workspaceId: string,
    personId: string,
    request: RememberRecordingPersonVoiceRequest,
  ): Promise<RecordingPerson> {
    return await this.client.requestJson<RecordingPerson>(
      "PUT",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recording-people/${encodeURIComponent(personId)}/voice`,
      request,
    );
  }

  /** Forget a person's voice and withdraw their agreement. */
  async forgetRecordingPersonVoice(
    workspaceId: string,
    personId: string,
  ): Promise<RecordingPerson> {
    return await this.client.requestJson<RecordingPerson>(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recording-people/${encodeURIComponent(personId)}/voice`,
    );
  }

  /** Transcription models this workspace can use, with their capabilities and default. */
  async listRecordingModels(workspaceId: string): Promise<ListRecordingModelsResponse> {
    return await this.client.requestJson<ListRecordingModelsResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recording-models`,
    );
  }

  /**
   * A grant to stream one track of a recording being captured to a live
   * model, for the live transcript preview. Only the person recording may.
   */
  async createRecordingLiveSession(
    workspaceId: string,
    recordingId: string,
    request: CreateRecordingLiveSessionRequest,
  ): Promise<RecordingLiveSession> {
    return await this.client.requestJson<RecordingLiveSession>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/live-session`,
      request,
    );
  }

  /** Save finished live text for one track; a segment number sent again keeps its first copy. */
  async appendRecordingLiveSegments(
    workspaceId: string,
    recordingId: string,
    request: AppendRecordingLiveSegmentsRequest,
  ): Promise<{ saved: number; ended: boolean }> {
    return await this.client.requestJson<{ saved: number; ended: boolean }>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/live-segments`,
      request,
    );
  }

  /** Live text saved after `after` (a sequence number), oldest first. */
  async listRecordingLiveSegments(
    workspaceId: string,
    recordingId: string,
    options: { after?: number } = {},
  ): Promise<ListRecordingLiveSegmentsResponse> {
    return await this.client.requestJson<ListRecordingLiveSegmentsResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/live-segments`,
      undefined,
      options.after ? { after: String(options.after) } : {},
    );
  }

  /** The meeting's notepad and written-up notes; a kind nobody has written is absent. */
  async listRecordingNotes(
    workspaceId: string,
    recordingId: string,
  ): Promise<ListRecordingNotesResponse> {
    return await this.client.requestJson<ListRecordingNotesResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/notes`,
    );
  }

  /**
   * Replace the notepad or the notes. Pass the revision you loaded as
   * `expectedRevision` (0 when there were none) to get 409 `notes_changed`
   * instead of overwriting a newer save.
   */
  async saveRecordingNote(
    workspaceId: string,
    recordingId: string,
    kind: RecordingNoteKind,
    request: SaveRecordingNoteRequest,
  ): Promise<RecordingNote> {
    return await this.client.requestJson<RecordingNote>(
      "PUT",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/recordings/${encodeURIComponent(recordingId)}/notes/${encodeURIComponent(kind)}`,
      request,
    );
  }
}

/**
 * The client calls a recorder needs. An {@link OpenGeniRecordingsClient}
 * satisfies it; the live calls are needed only for `liveTranscript`.
 */
export type RecordingTransport = Pick<
  OpenGeniRecordingsClient,
  | "createRecording"
  | "createRecordingUploads"
  | "completeRecordingChunks"
  | "finalizeRecording"
  | "deleteRecording"
> &
  /** Needed to rename a recording once the server has it. */
  Partial<Pick<OpenGeniRecordingsClient, "updateRecording">> &
  Partial<LiveTranscriptTransport>;

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

/** A chunk the local store holds, without its bytes (read them with `readChunk`). */
export type StoredRecordingChunk = Omit<RecordingChunk, "bytes"> & {
  byteLength: number;
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
  /** A title given after the server had the recording, still to be sent. */
  pendingTitle?: string;
  updatedAt: number;
};

/**
 * Durable local storage for chunks that are not confirmed by the server yet.
 * Listing returns chunk details only, so a long recording that waited
 * offline is never read into memory at once; bytes are read one chunk at a
 * time as they are sent.
 */
export interface RecordingChunkStore {
  putRecording(recording: StoredRecording): Promise<void>;
  getRecording(recordingId: string): Promise<StoredRecording | null>;
  listRecordings(): Promise<StoredRecording[]>;
  /** Removes the recording and every chunk it still has. */
  deleteRecording(recordingId: string): Promise<void>;
  putChunk(chunk: RecordingChunk): Promise<void>;
  /** Every stored chunk of the recording, ordered by track then chunk number. */
  listChunks(recordingId: string): Promise<StoredRecordingChunk[]>;
  /** One stored chunk's bytes; null once it is gone. */
  readChunk(
    recordingId: string,
    trackNumber: number,
    chunkNumber: number,
  ): Promise<Uint8Array | null>;
  deleteChunks(recordingId: string, trackNumber: number, chunkNumbers: number[]): Promise<void>;
}

export type RecordingUploadStatus = {
  recordingId: string;
  /** The server has the recording, so it shows in recording lists. */
  created: boolean;
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
  /**
   * Capture ended before any audio was recorded (stopped at once, or the app was
   * killed first), so the empty recording was removed instead of finalized.
   */
  discarded: boolean;
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
    readonly status: number | null = null,
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
  /** The last metadata write per recording; each write waits for the one before. */
  private readonly writes = new Map<string, Promise<unknown>>();
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

  /**
   * Read, change and write one recording's stored record with no other write to
   * it in between. Capture (chunk counts), stop (phase) and the upload pass
   * (created) all update the same record concurrently; without this a slower
   * write would put back a copy that loses the other's change, such as a stop.
   */
  private async mutate(
    recordingId: string,
    change: (recording: StoredRecording) => StoredRecording | null,
  ): Promise<StoredRecording | null> {
    const store = this.options.store;
    return await this.exclusive(recordingId, async () => {
      const current = await store.getRecording(recordingId);
      if (!current) return null;
      const changed = change(current);
      if (!changed) return current;
      await store.putRecording(changed);
      return changed;
    });
  }

  /**
   * Run `work` with no other change to this recording's stored record in
   * between. Discarding takes a turn too, so a change already reading the
   * record can't write it back after the recording was thrown away.
   */
  private async exclusive<T>(recordingId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(recordingId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.writes.set(recordingId, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(recordingId) === next) this.writes.delete(recordingId);
    }
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

  /**
   * Give a recording a new title. Before the server has the recording, the
   * title goes out when it is created; after, with the next upload pass, so a
   * dropped connection only delays it. Once the recording is finalized and its
   * local copy is gone, the server is updated directly.
   */
  async rename(workspaceId: string, recordingId: string, title: string): Promise<void> {
    const stored = await this.mutate(recordingId, (recording) => ({
      ...recording,
      create: { ...recording.create, title },
      ...(recording.created ? { pendingTitle: title } : {}),
      updatedAt: Date.now(),
    }));
    if (stored) {
      this.kick(recordingId);
      return;
    }
    const client = this.options.client;
    if (!client.updateRecording) {
      throw new Error("This recordings client can't rename a recording (no updateRecording).");
    }
    await client.updateRecording(workspaceId, recordingId, { title });
  }

  /** Store one captured chunk locally, then upload it in the background. */
  async addChunk(chunk: RecordingChunk): Promise<void> {
    const store = this.options.store;
    await store.putChunk(chunk);
    await this.mutate(chunk.recordingId, (recording) => {
      const count = Math.max(recording.chunkCounts[chunk.trackNumber] ?? 0, chunk.chunkNumber + 1);
      return {
        ...recording,
        chunkCounts: { ...recording.chunkCounts, [chunk.trackNumber]: count },
        updatedAt: Date.now(),
      };
    });
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
    await this.mutate(recordingId, (recording) =>
      recording.phase === "capturing"
        ? {
            ...recording,
            phase: "stopped",
            endedAt: (options.endedAt ?? new Date()).toISOString(),
            updatedAt: Date.now(),
          }
        : null,
    );
    return await this.settled(recordingId, options.signal);
  }

  /** Throw a recording away: its local chunks and whatever the server already has. */
  async discard(recordingId: string): Promise<void> {
    const store = this.options.store;
    const recording = await this.exclusive(recordingId, async () => {
      const current = await store.getRecording(recordingId);
      await store.deleteRecording(recordingId);
      return current;
    });
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
   * recorder still owns are skipped, and so are those `only` leaves out, such
   * as another feature's recordings sharing the same store.
   */
  async resume(
    options: { only?: (recording: StoredRecording) => boolean } = {},
  ): Promise<string[]> {
    const store = this.options.store;
    const resumed: string[] = [];
    for (const recording of await store.listRecordings()) {
      if (options.only && !options.only(recording)) continue;
      if (await this.captureActive(recording.recordingId)) continue;
      if (recording.phase === "capturing") {
        await this.mutate(recording.recordingId, (current) =>
          current.phase === "capturing"
            ? {
                ...current,
                phase: "stopped",
                endedAt: new Date(current.updatedAt).toISOString(),
                updatedAt: Date.now(),
              }
            : null,
        );
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
      if (pump.status.finalized || pump.status.discarded || pump.status.failed) {
        return pump.status;
      }
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
          created: false,
          pendingChunks: 0,
          pendingBytes: 0,
          uploading: false,
          retryingAfterError: null,
          failed: null,
          finalized: false,
          discarded: false,
        },
      };
      this.pumps.set(recordingId, pump);
    }
    pump.again = true;
    pump.wake?.();
    this.startPump(recordingId, pump);
    return pump;
  }

  private startPump(recordingId: string, pump: Pump): void {
    if (pump.running || this.disposed) return;
    pump.running = this.run(recordingId, pump).finally(() => {
      pump.running = null;
      // A kick that landed after the last pass decided it was done, but before
      // this cleanup ran, found the pump still running: serve it now.
      if (pump.again) this.startPump(recordingId, pump);
    });
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
        this.update(pump, {
          uploading: false,
          retryingAfterError: errorMessage(error),
        });
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
      this.update(pump, {
        pendingChunks: 0,
        pendingBytes: 0,
        uploading: false,
        finalized: true,
      });
      return true;
    }
    if (!recording.created) {
      const workspaceId = recording.workspaceId;
      const sent = recording.create;
      await guarded(() => client.createRecording(workspaceId, sent));
      recording = await this.mutate(recordingId, (current) => ({
        ...current,
        created: true,
        // Renamed while the server was creating it: send the newer title too.
        ...(current.create.title !== sent.title && current.create.title !== undefined
          ? { pendingTitle: current.create.title }
          : {}),
        updatedAt: Date.now(),
      }));
      if (!recording) {
        // Discarded while the server was creating it: discard saw no server
        // copy to remove, so remove the one just made.
        await guarded(() => client.deleteRecording(workspaceId, recordingId)).catch(
          (error: unknown) => {
            if (error instanceof PermanentRecordingError && error.status === 404) return;
            throw error;
          },
        );
        this.update(pump, {
          pendingChunks: 0,
          pendingBytes: 0,
          uploading: false,
          discarded: true,
        });
        return true;
      }
    }
    if (!pump.status.created) this.update(pump, { created: true });
    if (recording.pendingTitle !== undefined) {
      const title = recording.pendingTitle;
      const workspaceId = recording.workspaceId;
      const update = client.updateRecording?.bind(client);
      // A title the server refuses for good is dropped; it never holds up the audio.
      if (update) {
        await guarded(() => update(workspaceId, recordingId, { title })).catch((error: unknown) => {
          if (!(error instanceof PermanentRecordingError)) throw error;
        });
      }
      recording =
        (await this.mutate(recordingId, (current) => {
          if (current.pendingTitle !== title) return null;
          const { pendingTitle: _sent, ...rest } = current;
          return { ...rest, updatedAt: Date.now() };
        })) ?? recording;
    }
    // A native recorder writes each chunk file where the store keeps it before
    // capture counts it. While capturing, send only counted chunks: otherwise a
    // chunk could be uploaded and removed before capture reads it, and the
    // recording would be finalized without it. The record is read before each
    // listing, so a stopped recording's listing holds everything it captured.
    const pending = async () => {
      const current: StoredRecording = (await store.getRecording(recordingId)) ?? recording!;
      recording = current;
      const listed = await store.listChunks(recordingId);
      if (current.phase !== "capturing") return listed;
      return listed.filter(
        (chunk) => chunk.chunkNumber < (current.chunkCounts[chunk.trackNumber] ?? 0),
      );
    };
    let chunks = await pending();
    this.update(pump, {
      pendingChunks: chunks.length,
      pendingBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
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
      chunks = await pending();
      this.update(pump, {
        pendingChunks: chunks.length,
        pendingBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      });
    }
    this.update(pump, { uploading: false });
    if (recording.phase !== "stopped") return !pump.again;
    const captured = Object.values(recording.chunkCounts).reduce((sum, count) => sum + count, 0);
    if (captured === 0 && !alreadyFinalized) {
      await this.removeEmpty(recording, pump);
      return true;
    }
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
      if (error instanceof PermanentRecordingError && error.code === "empty_recording") {
        return "empty" as const;
      }
      throw error;
    });
    if (finalized === "empty") {
      await this.removeEmpty(recording, pump);
      return true;
    }
    if (finalized) this.finalized.set(recordingId, finalized);
    await store.deleteRecording(recordingId);
    this.update(pump, { pendingChunks: 0, pendingBytes: 0, finalized: true });
    return true;
  }

  /** Remove a recording that ended without any audio, on the server and here. */
  private async removeEmpty(recording: StoredRecording, pump: Pump): Promise<void> {
    const { client, store } = this.options;
    if (recording.created) {
      await guarded(() =>
        client.deleteRecording(recording.workspaceId, recording.recordingId),
      ).catch((error: unknown) => {
        // Already gone (deleted elsewhere): nothing is left to remove there.
        if (error instanceof PermanentRecordingError && error.status === 404) return;
        throw error;
      });
    }
    await store.deleteRecording(recording.recordingId);
    this.update(pump, { pendingChunks: 0, pendingBytes: 0, discarded: true });
  }

  private async uploadBatch(
    recording: StoredRecording,
    batch: StoredRecordingChunk[],
  ): Promise<void> {
    const { client, store } = this.options;
    const trackNumber = batch[0]!.trackNumber;
    const { uploads } = await guarded(() =>
      client.createRecordingUploads(recording.workspaceId, recording.recordingId, {
        trackNumber,
        chunks: batch.map((chunk) => ({
          chunkNumber: chunk.chunkNumber,
          byteLength: chunk.byteLength,
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
      const bytes = await store.readChunk(recording.recordingId, trackNumber, chunk.chunkNumber);
      // Gone since the listing (another uploader confirmed it): the next pass lists again.
      if (!bytes) continue;
      const response = await this.fetchImpl(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: bytes as unknown as BodyInit,
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
/**
 * Refusals that time or a fresh credential fix: an expired or not yet loaded
 * sign-in, a timeout, and rate limiting. The recording itself is fine, so
 * these are retried with backoff instead of failing the upload.
 */
const RETRYABLE_REFUSALS = new Set([401, 408, 425, 429]);

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const retryable = (error as { retryable?: unknown }).retryable;
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      retryable !== true &&
      !RETRYABLE_REFUSALS.has(status)
    ) {
      const details = (error as { details?: { code?: unknown } }).details;
      const code =
        typeof details?.code === "string"
          ? details.code
          : typeof (error as { code?: unknown }).code === "string"
            ? String((error as { code: string }).code)
            : `http_${status}`;
      throw new PermanentRecordingError(code, errorMessage(error), status);
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
        .sort((a, b) => a.trackNumber - b.trackNumber || a.chunkNumber - b.chunkNumber)
        .map(({ bytes, ...chunk }) => ({
          ...chunk,
          byteLength: bytes.byteLength,
        }));
    },
    async readChunk(recordingId, trackNumber, chunkNumber) {
      return chunks.get(key(recordingId, trackNumber, chunkNumber))?.bytes ?? null;
    },
    async deleteChunks(recordingId, trackNumber, chunkNumbers) {
      for (const chunk of chunkNumbers) chunks.delete(key(recordingId, trackNumber, chunk));
    },
  };
}

// Version 2 keeps chunk bytes apart from chunk details, so listing never reads audio.
const IDB_VERSION = 2;

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
      request.onupgradeneeded = (event) => {
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
        if (!db.objectStoreNames.contains("chunkBytes")) {
          db.createObjectStore("chunkBytes");
        }
        if (event.oldVersion === 1) {
          // Version 1 kept the bytes on the chunk record: move them out.
          const tx = request.transaction!;
          const bytesStore = tx.objectStore("chunkBytes");
          const cursor = tx.objectStore("chunks").openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) return;
            const { bytes, ...chunk } = current.value as RecordingChunk;
            if (bytes) {
              bytesStore.put(bytes, [chunk.recordingId, chunk.trackNumber, chunk.chunkNumber]);
              current.update({ ...chunk, byteLength: bytes.byteLength });
            }
            current.continue();
          };
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
      await run(["recordings", "chunks", "chunkBytes"], "readwrite", (tx) => {
        const chunks = tx.objectStore("chunks");
        const bytes = tx.objectStore("chunkBytes");
        const keys = chunks.index("recordingId").getAllKeys(recordingId);
        keys.onsuccess = () => {
          for (const key of keys.result) {
            chunks.delete(key);
            bytes.delete(key);
          }
        };
        tx.objectStore("recordings").delete(recordingId);
      });
    },
    async putChunk(chunk) {
      const { bytes, ...details } = chunk;
      await run(["chunks", "chunkBytes"], "readwrite", (tx) => {
        tx.objectStore("chunkBytes").put(bytes, [
          chunk.recordingId,
          chunk.trackNumber,
          chunk.chunkNumber,
        ]);
        tx.objectStore("chunks").put({
          ...details,
          byteLength: bytes.byteLength,
        });
      });
    },
    async listChunks(recordingId) {
      // The index orders equal keys by primary key: track number, then chunk number.
      return await run<StoredRecordingChunk[]>(["chunks"], "readonly", (tx) =>
        tx.objectStore("chunks").index("recordingId").getAll(recordingId),
      );
    },
    async readChunk(recordingId, trackNumber, chunkNumber) {
      const found = await run<Uint8Array | undefined>(["chunkBytes"], "readonly", (tx) =>
        tx.objectStore("chunkBytes").get([recordingId, trackNumber, chunkNumber]),
      );
      return found ?? null;
    },
    async deleteChunks(recordingId, trackNumber, chunkNumbers) {
      await run(["chunks", "chunkBytes"], "readwrite", (tx) => {
        const chunks = tx.objectStore("chunks");
        const bytes = tx.objectStore("chunkBytes");
        for (const chunk of chunkNumbers) {
          chunks.delete([recordingId, trackNumber, chunk]);
          bytes.delete([recordingId, trackNumber, chunk]);
        }
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

// --- Capture -------------------------------------------------------------------

export type RecorderState =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

export type RecorderSnapshot = {
  state: RecorderState;
  recordingId: string | null;
  /** The title given at start or by {@link Recorder.rename}; null or absent when none was. */
  title?: string | null;
  /** Recorded time, excluding pauses. */
  elapsedMilliseconds: number;
  /**
   * Why capture is paused: the person paused it, or the system took the
   * microphone (a phone call, another app), in which case capture resumes by
   * itself when it can. Null or absent while not paused.
   */
  pauseReason?: "person" | "interruption" | null;
  tracks: Array<{
    trackNumber: number;
    source: RecordingCaptureSource;
    label: string;
  }>;
  upload: RecordingUploadStatus | null;
  error: { code: RecorderErrorCode; message: string } | null;
  /**
   * The live transcript per track while `liveTranscript` is on, else null
   * or absent. A preview only; it never affects the recording.
   */
  live?: readonly LiveTranscriptTrackSnapshot[] | null;
};

export type RecorderErrorCode =
  | "microphone_denied"
  | "microphone_unavailable"
  | "system_audio_unavailable"
  | "system_audio_not_shared"
  | "unsupported"
  | "capture_failed"
  | "upload_failed";

export type RecorderOptions = {
  client: RecordingTransport;
  workspaceId: string;
  /**
   * meeting (the default), or dictation: speech recorded to type it, kept
   * private, transcribed with the workspace's voice input and never listed
   * in Meetings. A dictation records the microphone only.
   */
  purpose?: RecordingCapturePurpose;
  /** Defaults to IndexedDB, so nothing is lost on reload. */
  store?: RecordingChunkStore;
  /** Share one uploader between recorders; one is created otherwise. */
  uploader?: RecordingUploader;
  title?: string;
  visibility?: RecordingVisibility;
  externalRef?: string;
  metadata?: CreateRecordingRequest["metadata"];
  transcription?: RecordingTranscriptionRequest;
  /** Microphone constraints; false records no microphone. Default: on. */
  microphone?: boolean | MediaTrackConstraints;
  /**
   * Also record other apps' audio (in a desktop app) or a tab's or the
   * screen's audio (Chromium browsers) as its own track. Default: off.
   */
  systemAudio?: boolean;
  /**
   * Where that audio comes from. Default: the desktop app's capture inside an
   * Opengeni desktop app, otherwise the browser's share prompt.
   */
  systemAudioSource?: SystemAudioSource;
  /** How often a chunk is cut and saved. Default 5 seconds. */
  timesliceMilliseconds?: number;
  /** Keep the screen awake while recording on phones. Default: on. */
  keepAwake?: boolean;
  /**
   * Also stream each track to the workspace's live speech model and show
   * what is said in `snapshot.live` as it is said. The provider bills the
   * streamed audio. Needs the client's live calls. Default: off.
   */
  liveTranscript?: boolean;
  /** The WebSocket the live transcript connects with. Defaults to the global one. */
  liveWebSocket?: LiveWebSocketConstructor;
  onChange?: (snapshot: RecorderSnapshot) => void;
};

export type Recorder = {
  readonly snapshot: RecorderSnapshot;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Stop capture; resolves when the server has every chunk and transcription has started. */
  stop(options?: { signal?: AbortSignal }): Promise<RecordingUploadStatus | null>;
  /** Stop and throw everything away, local and on the server's side of the upload. */
  discard(): Promise<void>;
  /**
   * Rename the recording being made, also while offline: the title reaches
   * the server with the upload.
   */
  rename(title: string): Promise<void>;
  /** Current input level per track, 0 to 1, for a meter. */
  levels(): Record<number, number>;
  /**
   * The live audio of one track while recording, for a waveform; null when
   * not recording, or on platforms that don't expose their capture.
   */
  inputStream?(trackNumber: number): MediaStream | null;
};

/**
 * One platform's capture for the recorder hooks: the browser's by default
 * ({@link browserRecorderPlatform}); a native app passes its own.
 */
export type RecorderPlatform = {
  /** This device can record audio at all. */
  supported: boolean;
  /** This device can record a tab's or the system's audio as its own track. */
  systemAudioSupported: boolean;
  /**
   * How system audio is recorded here: `desktop` records other apps' audio
   * directly; `display` asks the browser to share a tab or screen with its
   * audio. Null when it can't be.
   */
  systemAudioKind?: SystemAudioKind | null;
  createRecorder(options: RecorderOptions): Recorder;
  /** Used for the presigned uploads. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** The local store chunks wait in until the server has them. */
  createStore(): RecordingChunkStore;
  /** Recordings a live recorder in this app still owns, which resuming leaves alone. */
  isCaptureActive?(recordingId: string): Promise<boolean>;
  /** Save what a capture cut short (a crash, a killed app) left half-written, before resuming. */
  recover?(store: RecordingChunkStore): Promise<void>;
};

/** @deprecated Use {@link RecorderState}. */
export type BrowserRecorderState = RecorderState;
/** @deprecated Use {@link RecorderSnapshot}. */
export type BrowserRecorderSnapshot = RecorderSnapshot;
/** @deprecated Use {@link RecorderErrorCode}. */
export type BrowserRecorderErrorCode = RecorderErrorCode;
/** @deprecated Use {@link RecorderOptions}. */
export type BrowserRecorderOptions = RecorderOptions;
/** @deprecated Use {@link Recorder}. */
export type BrowserRecorder = Recorder;

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
  return desktopSystemAudioSource() !== null || canShareDisplayAudio();
}

function canShareDisplayAudio(): boolean {
  const media = globalThis.navigator?.mediaDevices;
  if (!media || typeof media.getDisplayMedia !== "function") return false;
  const agent = globalThis.navigator.userAgent ?? "";
  const chromium = /\b(Chrome|Chromium|Edg)\//u.test(agent) && !/\bMobile\b/u.test(agent);
  // An Electron app shows no share picker unless it builds one; it records
  // other apps' audio itself (desktopSystemAudioSource) or not at all.
  return chromium && !/\bElectron\//u.test(agent);
}

export type SystemAudioKind = "desktop" | "display";

/** An open system audio capture: its stream, and how to end it. */
export type SystemAudioCapture = {
  stream: MediaStream;
  label: string;
  stop(): void;
};

/** Where a recorder's system audio track comes from. */
export type SystemAudioSource = {
  kind: SystemAudioKind;
  /** Open the capture; throws a {@link RecorderCaptureError} when it can't. */
  open(): Promise<SystemAudioCapture>;
};

/** The browser's share prompt: a tab or the screen, with its audio. */
export function displaySystemAudioSource(): SystemAudioSource {
  return {
    kind: "display",
    async open() {
      const media = globalThis.navigator?.mediaDevices;
      if (!media?.getDisplayMedia) {
        throw new RecorderCaptureError(
          "system_audio_unavailable",
          "This browser cannot share tab or system audio.",
        );
      }
      let display: MediaStream;
      try {
        display = await media.getDisplayMedia({ audio: true, video: true });
      } catch {
        throw new RecorderCaptureError("system_audio_not_shared", "Audio sharing was cancelled.");
      }
      for (const track of display.getVideoTracks()) {
        track.stop();
        display.removeTrack(track);
      }
      const audio = display.getAudioTracks();
      if (audio.length === 0) {
        throw new RecorderCaptureError(
          "system_audio_not_shared",
          "No audio was shared. Choose a tab or screen and turn on audio sharing.",
        );
      }
      return {
        stream: display,
        label: audio[0]?.label || "Shared audio",
        stop: () => {
          for (const track of display.getTracks()) track.stop();
        },
      };
    },
  };
}

type AudioTrackGenerator = MediaStreamTrack & {
  writable: WritableStream<unknown>;
};

/**
 * Other apps' audio from the desktop app this page runs in, or null outside
 * one (or in a version that can't): the Opengeni desktop app, or any app that
 * defines `window.opengeniSystemAudio` with `@opengeni/desktop`. The app
 * records everything the computer plays except its own sounds, without a
 * share prompt.
 */
export function desktopSystemAudioSource(
  bridge: DesktopBridge | null = getDesktopBridge(),
): SystemAudioSource | null {
  const capture = getDesktopSystemAudio(bridge);
  const scope = globalThis as {
    MediaStreamTrackGenerator?: new (init: { kind: "audio" }) => AudioTrackGenerator;
    AudioData?: new (init: {
      format: "f32-planar";
      sampleRate: number;
      numberOfFrames: number;
      numberOfChannels: number;
      timestamp: number;
      data: Float32Array;
    }) => unknown;
  };
  const Generator = scope.MediaStreamTrackGenerator;
  const AudioDataClass = scope.AudioData;
  if (!capture || !Generator || !AudioDataClass) return null;
  return {
    kind: "desktop",
    async open() {
      const generator = new Generator({ kind: "audio" });
      const writer = generator.writable.getWriter();
      let captureId: string | null = null;
      let sampleRate = 0;
      let timestamp = 0;
      // Samples can arrive before start() resolves; keep them until it does.
      const early: Array<[string, Float32Array]> = [];
      const write = (samples: Float32Array) => {
        if (samples.length === 0 || generator.readyState === "ended") return;
        const frame = new AudioDataClass({
          format: "f32-planar",
          sampleRate,
          numberOfFrames: samples.length,
          numberOfChannels: 1,
          timestamp,
          data: samples,
        });
        timestamp += (samples.length * 1_000_000) / sampleRate;
        void writer.write(frame).catch(() => undefined);
      };
      const stopSamples = capture.onSamples((id, samples) => {
        if (captureId === null) early.push([id, samples]);
        else if (id === captureId) write(samples);
      });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        stopSamples();
        stopEnded();
        void writer.close().catch(() => undefined);
        generator.stop();
      };
      const stopEnded = capture.onEnded((id) => {
        // The app stopped recording other apps' audio: end the track, which
        // ends this one track and keeps the microphone recording.
        if (id === captureId) {
          finish();
          generator.dispatchEvent(new Event("ended"));
        }
      });
      try {
        const started = await capture.start();
        captureId = started.captureId;
        sampleRate = started.sampleRate;
      } catch (error) {
        finish();
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : "This computer can't record its own audio.";
        throw new RecorderCaptureError("system_audio_unavailable", message);
      }
      for (const [id, samples] of early.splice(0)) if (id === captureId) write(samples);
      const id = captureId;
      return {
        stream: new MediaStream([generator]),
        label: "Computer audio",
        stop: () => {
          finish();
          void capture.stop(id).catch(() => undefined);
        },
      };
    },
  };
}

/** The system audio source a recorder uses when none is given. */
export function defaultSystemAudioSource(): SystemAudioSource | null {
  return desktopSystemAudioSource() ?? (canShareDisplayAudio() ? displaySystemAudioSource() : null);
}

/** SHA-256 of bytes as lowercase hex, with Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type TrackCapture = {
  trackNumber: number;
  source: RecordingCaptureSource;
  label: string;
  stream: MediaStream;
  /** Ends a capture that stopping its tracks alone doesn't (the desktop app's). */
  release?: () => void;
  recorder: MediaRecorder;
  analyser: AnalyserNode | null;
  nextChunk: number;
  chunkStartedAt: number;
  writes: Promise<void>;
  /** The live transcript of this track, while `liveTranscript` is on. */
  live?: LiveTranscriber;
  pcm?: AudioWorkletNode;
};

/**
 * An audio worklet that hands the main thread a tenth of a second of 16-bit
 * mono PCM at a time, for the live transcript.
 */
const LIVE_PCM_WORKLET = `
class OpenGeniLivePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buffer = new Int16Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0].length;
    for (let index = 0; index < length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.buffer[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("opengeni-live-pcm", OpenGeniLivePcm);
`;

function liveTransport(client: RecordingTransport): LiveTranscriptTransport | null {
  return client.createRecordingLiveSession && client.appendRecordingLiveSegments
    ? (client as LiveTranscriptTransport)
    : null;
}

/**
 * Record the microphone and, optionally, shared tab or system audio in the
 * browser, each as its own track, saving every few seconds locally and
 * uploading in the background.
 */
export function createBrowserRecorder(options: RecorderOptions): Recorder {
  let snapshot: RecorderSnapshot = {
    state: "idle",
    recordingId: null,
    elapsedMilliseconds: 0,
    tracks: [],
    upload: null,
    error: null,
  };
  const emit = (patch: Partial<RecorderSnapshot>) => {
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
          ? {
              error: {
                code: "upload_failed" as const,
                message: status.failed.message,
              },
            }
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

  const fail = (code: RecorderErrorCode, message: string) => {
    emit({ state: "failed", error: { code, message } });
  };

  const liveSnapshot = () =>
    captures.flatMap((capture) => (capture.live ? [capture.live.snapshot] : []));

  /** Tap each track's audio for the live transcript. Recording never waits on it. */
  const startLive = async (recordingId: string) => {
    const transport = liveTransport(options.client);
    if (!options.liveTranscript || !transport) return;
    for (const capture of captures) {
      capture.live = createLiveTranscriber({
        client: transport,
        workspaceId: options.workspaceId,
        recordingId,
        trackNumber: capture.trackNumber,
        ...(options.liveWebSocket ? { WebSocket: options.liveWebSocket } : {}),
        mediaTrack: capture.stream.getAudioTracks()[0] ?? null,
        onChange: () => emit({ live: liveSnapshot() }),
      });
    }
    emit({ live: liveSnapshot() });
    const context = audioContext;
    if (!context?.audioWorklet || typeof AudioWorkletNode === "undefined") {
      for (const capture of captures) capture.live?.abort();
      emit({ live: null });
      return;
    }
    const url = URL.createObjectURL(new Blob([LIVE_PCM_WORKLET], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } catch {
      for (const capture of captures) capture.live?.abort();
      emit({ live: null });
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    if (context !== audioContext) return;
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    for (const capture of captures) {
      const live = capture.live;
      if (!live) continue;
      const node = new AudioWorkletNode(context, "opengeni-live-pcm");
      // Where this track's live audio sits in the recording, counted in the
      // audio's own samples like the recording itself. The wall clock drifts
      // from the audio clock, and messages arrive late when the page is busy,
      // so it would make continuous audio look like a pause.
      let clock: number | null = null;
      node.port.onmessage = (event: MessageEvent<Int16Array>) => {
        // Paused audio is not recorded, so it is not transcribed either.
        if (snapshot.state !== "recording") return;
        const samples = event.data;
        const duration = (samples.length / context.sampleRate) * 1_000;
        clock ??= Math.max(0, elapsed() - duration);
        live.push(samples, context.sampleRate, clock);
        clock += duration;
      };
      context.createMediaStreamSource(capture.stream).connect(node);
      // A node nobody listens to may not run; its output is silence.
      node.connect(context.destination);
      capture.pcm = node;
    }
  };

  const stopLiveTaps = () => {
    for (const capture of captures) {
      if (!capture.pcm) continue;
      capture.pcm.port.onmessage = null;
      capture.pcm.disconnect();
      delete capture.pcm;
    }
  };

  const cleanupMedia = () => {
    stopLiveTaps();
    for (const capture of captures) {
      for (const track of capture.stream.getTracks()) track.stop();
      capture.release?.();
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
      throw new RecorderCaptureError("unsupported", "This browser cannot record audio.");
    const opened: Array<
      Omit<TrackCapture, "recorder" | "analyser" | "nextChunk" | "chunkStartedAt" | "writes">
    > = [];
    try {
      if (options.microphone !== false) {
        const constraints: MediaTrackConstraints =
          typeof options.microphone === "object"
            ? options.microphone
            : {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              };
        let stream: MediaStream;
        try {
          stream = await media.getUserMedia({ audio: constraints });
        } catch (error) {
          const name = (error as { name?: string }).name;
          throw new RecorderCaptureError(
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
      if (options.systemAudio && options.purpose !== "dictation") {
        const source =
          options.systemAudioSource ?? defaultSystemAudioSource() ?? displaySystemAudioSource();
        const shared = await source.open();
        opened.push({
          trackNumber: opened.length,
          source: "system",
          label: shared.label,
          stream: shared.stream,
          release: shared.stop,
        });
      }
    } catch (error) {
      for (const item of opened) {
        for (const track of item.stream.getTracks()) track.stop();
        item.release?.();
      }
      throw error;
    }
    if (opened.length === 0) {
      throw new RecorderCaptureError("unsupported", "Choose at least one audio source to record.");
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
      emit({
        state: "starting",
        error: null,
        upload: null,
        elapsedMilliseconds: 0,
        live: null,
      });
      let streams: Awaited<ReturnType<typeof openStreams>>;
      try {
        streams = await openStreams();
      } catch (error) {
        if (error instanceof RecorderCaptureError) fail(error.code, error.message);
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
      emit({ recordingId, title: options.title ?? null });
      await uploader.begin({
        workspaceId: options.workspaceId,
        recordingId,
        create: {
          recordingId,
          ...(options.purpose ? { purpose: options.purpose } : {}),
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
            wakeLock?: {
              request(type: "screen"): Promise<{ release(): Promise<void> }>;
            };
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
        tracks: captures.map(({ trackNumber, source, label }) => ({
          trackNumber,
          source,
          label,
        })),
      });
      void startLive(recordingId).catch(() => undefined);
    },

    pause() {
      if (snapshot.state !== "recording") return;
      for (const capture of captures)
        if (capture.recorder.state === "recording") capture.recorder.pause();
      for (const capture of captures) capture.live?.setPaused(true);
      pausedAt = performance.now();
      emit({
        state: "paused",
        pauseReason: "person",
        elapsedMilliseconds: elapsed(),
      });
    },

    resume() {
      if (snapshot.state !== "paused") return;
      if (pausedAt !== null) pausedTotal += performance.now() - pausedAt;
      pausedAt = null;
      for (const capture of captures)
        if (capture.recorder.state === "paused") capture.recorder.resume();
      for (const capture of captures) capture.live?.setPaused(false);
      emit({ state: "recording", pauseReason: null });
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
              capture.recorder.addEventListener("stop", () => done(), {
                once: true,
              });
              capture.recorder.stop();
            }),
        ),
      );
      await Promise.all(captures.map((capture) => capture.writes));
      // The live transcript finishes its last words while the upload completes.
      stopLiveTaps();
      const liveClosed = Promise.all(captures.map((capture) => capture.live?.close()));
      cleanupMedia();
      lock?.release();
      lock = null;
      const status = await uploader.finish(recordingId, {
        ...stopOptions,
        endedAt: new Date(),
      });
      await liveClosed.catch(() => undefined);
      emit({
        state: status.failed ? "failed" : "stopped",
        upload: status,
        ...(status.failed
          ? {
              error: {
                code: "upload_failed" as const,
                message: status.failed.message,
              },
            }
          : {}),
      });
      return status;
    },

    async discard() {
      const recordingId = snapshot.recordingId;
      for (const capture of captures) {
        capture.recorder.ondataavailable = null;
        if (capture.recorder.state !== "inactive") capture.recorder.stop();
        capture.live?.abort();
      }
      cleanupMedia();
      lock?.release();
      lock = null;
      if (recordingId) await uploader.discard(recordingId);
      emit({
        state: "idle",
        recordingId: null,
        elapsedMilliseconds: 0,
        tracks: [],
        upload: null,
        live: null,
      });
    },

    async rename(title: string) {
      const recordingId = snapshot.recordingId;
      if (!recordingId) throw new Error("Nothing is being recorded to rename.");
      await uploader.rename(options.workspaceId, recordingId, title);
      if (snapshot.recordingId === recordingId) emit({ title });
    },

    inputStream(trackNumber: number) {
      if (snapshot.state !== "recording" && snapshot.state !== "paused") return null;
      return captures.find((capture) => capture.trackNumber === trackNumber)?.stream ?? null;
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

/** Why a recorder couldn't open one of its audio sources. */
export class RecorderCaptureError extends Error {
  constructor(
    readonly code: RecorderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecorderCaptureError";
  }
}

/** The browser's capture: MediaRecorder, IndexedDB and cross-tab capture locks. */
export function browserRecorderPlatform(): RecorderPlatform {
  const browser = typeof window !== "undefined";
  const systemAudio = browser ? defaultSystemAudioSource() : null;
  return {
    supported: browser && preferredRecordingMimeType() !== null,
    systemAudioSupported: systemAudio !== null,
    systemAudioKind: systemAudio?.kind ?? null,
    createRecorder: createBrowserRecorder,
    createStore: () => createIndexedDbRecordingChunkStore(),
    isCaptureActive: recordingLockHeld,
  };
}
