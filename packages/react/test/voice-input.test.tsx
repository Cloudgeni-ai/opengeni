import { afterEach, describe, expect, mock, test } from "bun:test";
import { OpenGeniApiError, type TranscribeAudioInput } from "@opengeni/sdk";
import { act, useState } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { appendFinalTranscript } from "../src/hooks/use-transcription";
import {
  VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS,
  VOICE_RECORDING_RECOVERY_MAX_MUTATION_DELAY_MILLISECONDS,
  VOICE_RECORDING_RESUMABLE_CLIENT_MAX_DURATION_SECONDS,
  VOICE_RECORDING_TIMESLICE_MILLISECONDS,
  transcriptionRecoveryMutationDelayMilliseconds,
  useVoiceInput,
} from "../src/hooks/use-voice-input";
import {
  createVoiceRecordingManifest,
  planVoiceRecordingChunkCommit,
  prepareVoiceRecordingChunk,
  VoiceRecordingOwnedError,
  type PersistVoiceRecordingChunkInput,
  type PersistVoiceRecordingChunkResult,
  type VoiceRecordingChunk,
  type VoiceRecordingManifest,
  type VoiceRecordingStore,
} from "../src/voice-recording-store";
import type { ComposerState } from "../src/hooks/use-composer";
import { registerDom, renderComponent, renderHook, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  mock.restore();
});

const capability = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
};

const resumableCapability = {
  ...capability,
  resumable: {
    maxDurationSeconds: 2 * 60 * 60,
    maxSizeBytes: 512 * 1024 * 1024,
    maxChunkSizeBytes: 8 * 1024 * 1024,
    providerSegmentSeconds: 50,
  },
};

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  startTimeslice: number | undefined;
  lastTimecode = 0;
  deferStopEvents = false;
  stopEventsPending = false;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.startTimeslice = timeslice;
  }
  emit(data: Blob, timecode: number) {
    this.lastTimecode = timecode;
    this.ondataavailable?.({ data, timecode } as BlobEvent);
  }
  stop() {
    this.state = "inactive";
    if (this.deferStopEvents) {
      this.stopEventsPending = true;
      return;
    }
    this.finishStop();
  }
  finishStop() {
    this.stopEventsPending = false;
    this.emit(
      new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
      Math.max(1_000, this.lastTimecode + 1_000),
    );
    this.onstop?.();
  }
}

function installMediaMocks(options?: { deny?: boolean }) {
  FakeMediaRecorder.instances = [];
  const track = { stop: mock(() => undefined) };
  const getUserMedia = options?.deny
    ? mock(async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      })
    : mock(
        async () =>
          ({
            getTracks: () => [track],
          }) as unknown as MediaStream,
      );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
    },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  return { track, getUserMedia };
}

class MemoryVoiceRecordingStore implements VoiceRecordingStore {
  readonly manifests = new Map<string, VoiceRecordingManifest>();
  readonly chunks = new Map<string, VoiceRecordingChunk>();
  failNextPersist: Error | null = null;
  failNextDiscard: Error | null = null;
  failNextCleanup: Error | null = null;
  failNextCreate: Error | null = null;
  failHandedOffUpdate: Error | null = null;
  listChunksStarted: (() => void) | null = null;
  listChunksGate: Promise<void> | null = null;
  stopUpdateStarted: (() => void) | null = null;
  stopUpdateGate: Promise<void> | null = null;

  async createManifest(manifest: VoiceRecordingManifest): Promise<void> {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    if (this.manifests.has(manifest.recordingId)) throw new Error("duplicate manifest");
    this.manifests.set(manifest.recordingId, manifest);
  }

  async getManifest(recordingId: string): Promise<VoiceRecordingManifest | null> {
    return this.manifests.get(recordingId) ?? null;
  }

  async listRecoverableManifests(
    workspaceId: string,
    ownership?: { ownerId: string; staleBefore: string },
  ): Promise<VoiceRecordingManifest[]> {
    return [...this.manifests.values()]
      .filter(
        (manifest) =>
          manifest.workspaceId === workspaceId &&
          manifest.captureState !== "discarded" &&
          manifest.finalizationState !== "handed-off" &&
          (!manifest.ownerId ||
            manifest.ownerId === ownership?.ownerId ||
            Boolean(
              ownership &&
              (!manifest.ownerHeartbeatAt || manifest.ownerHeartbeatAt <= ownership.staleBefore),
            )),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async claimManifest(
    recordingId: string,
    ownerId: string,
    claimedAt: string,
    staleBefore: string,
  ): Promise<VoiceRecordingManifest> {
    const manifest = this.manifests.get(recordingId);
    if (!manifest) throw new Error("missing manifest");
    if (
      manifest.finalizationState === "handed-off" ||
      (manifest.ownerId &&
        manifest.ownerId !== ownerId &&
        manifest.ownerHeartbeatAt &&
        manifest.ownerHeartbeatAt > staleBefore)
    ) {
      throw new VoiceRecordingOwnedError(recordingId);
    }
    const updated = {
      ...manifest,
      captureState:
        manifest.captureState === "capturing" ? ("stopped" as const) : manifest.captureState,
      ownerId,
      ownerHeartbeatAt: claimedAt,
      updatedAt: claimedAt,
    };
    this.manifests.set(recordingId, updated);
    return updated;
  }

  async listChunks(recordingId: string): Promise<VoiceRecordingChunk[]> {
    this.listChunksStarted?.();
    await this.listChunksGate;
    return [...this.chunks.values()]
      .filter((chunk) => chunk.recordingId === recordingId)
      .sort((left, right) => left.chunkNumber - right.chunkNumber);
  }

  async persistChunk(
    input: PersistVoiceRecordingChunkInput,
  ): Promise<PersistVoiceRecordingChunkResult> {
    if (this.failNextPersist) {
      const error = this.failNextPersist;
      this.failNextPersist = null;
      throw error;
    }
    const manifest = this.manifests.get(input.recordingId);
    if (!manifest) throw new Error("missing manifest");
    assertMemoryOwner(manifest, input.ownerId);
    const chunk = await prepareVoiceRecordingChunk(input);
    const key = `${input.recordingId}:${input.chunkNumber}`;
    const result = planVoiceRecordingChunkCommit({
      manifest,
      chunk,
      existingChunk: this.chunks.get(key) ?? null,
    });
    if (!result.deduplicated) {
      this.chunks.set(key, result.chunk);
      this.manifests.set(input.recordingId, result.manifest);
    }
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
        | "recoveryMode"
        | "handoffMode"
      >
    >,
    updatedAt: string,
    ownerId?: string | undefined,
  ): Promise<VoiceRecordingManifest> {
    const manifest = this.manifests.get(recordingId);
    if (!manifest) throw new Error("missing manifest");
    assertMemoryOwner(manifest, ownerId);
    if (update.finalizationState === "handed-off" && this.failHandedOffUpdate) {
      const error = this.failHandedOffUpdate;
      this.failHandedOffUpdate = null;
      throw error;
    }
    if (
      update.captureState === "stopped" &&
      Object.keys(update).length === 1 &&
      this.stopUpdateGate
    ) {
      this.stopUpdateStarted?.();
      await this.stopUpdateGate;
    }
    const updated = { ...manifest, ...update, updatedAt };
    this.manifests.set(recordingId, updated);
    return updated;
  }

  async discard(recordingId: string, ownerId?: string | undefined): Promise<void> {
    if (this.failNextDiscard) {
      const error = this.failNextDiscard;
      this.failNextDiscard = null;
      throw error;
    }
    const manifest = this.manifests.get(recordingId);
    if (!manifest) throw new Error("missing manifest");
    assertMemoryOwner(manifest, ownerId);
    this.manifests.delete(recordingId);
    for (const [key, chunk] of this.chunks) {
      if (chunk.recordingId === recordingId) this.chunks.delete(key);
    }
  }

  async cleanupHandedOffManifests(ownership: {
    ownerId: string;
    staleBefore: string;
  }): Promise<number> {
    if (this.failNextCleanup) {
      const error = this.failNextCleanup;
      this.failNextCleanup = null;
      throw error;
    }
    const handedOff = [...this.manifests.values()].filter(
      (manifest) =>
        manifest.finalizationState === "handed-off" &&
        (!manifest.ownerId ||
          manifest.ownerId === ownership.ownerId ||
          !manifest.ownerHeartbeatAt ||
          manifest.ownerHeartbeatAt <= ownership.staleBefore),
    );
    for (const manifest of handedOff) {
      this.manifests.delete(manifest.recordingId);
      for (const [key, chunk] of this.chunks) {
        if (chunk.recordingId === manifest.recordingId) this.chunks.delete(key);
      }
    }
    return handedOff.length;
  }

  async close(): Promise<void> {}
}

function assertMemoryOwner(manifest: VoiceRecordingManifest, ownerId: string | undefined): void {
  if (manifest.ownerId !== (ownerId ?? null)) {
    throw new VoiceRecordingOwnedError(manifest.recordingId);
  }
}

async function settle(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function seedStoppedRecording(
  store: MemoryVoiceRecordingStore,
  recordingId: string,
  createdAt: string,
): Promise<void> {
  const manifest = createVoiceRecordingManifest({
    recordingId,
    workspaceId: "ws-1",
    mimeType: "audio/webm",
    createdAt,
  });
  await store.createManifest(manifest);
  await store.persistChunk({
    recordingId,
    chunkNumber: 0,
    capturedAt: new Date(new Date(createdAt).getTime() + 1_000).toISOString(),
    startMilliseconds: 0,
    durationMilliseconds: 1_000,
    mimeType: manifest.mimeType,
    audio: new Blob([recordingId], { type: manifest.mimeType }),
  });
  await store.updateManifest(
    recordingId,
    { captureState: "stopped", recoveryMode: "manual", handoffMode: "explicit" },
    new Date(new Date(createdAt).getTime() + 1_000).toISOString(),
  );
}

function resumableRecordingResponse(
  manifest: VoiceRecordingManifest,
  input: {
    state: "segmenting" | "ready" | "transcribing" | "failed" | "complete" | "discarded";
    segmentCount?: number;
    completedSegmentCount?: number;
    retryAfterMilliseconds?: number;
    retryable?: boolean;
    errorCode?: "provider" | null;
    transcriptText?: string | null;
  },
) {
  const complete = input.state === "complete";
  return {
    recording: {
      id: manifest.recordingId,
      workspaceId: manifest.workspaceId,
      mimeType: manifest.mimeType,
      state: input.state,
      nextChunkNumber: manifest.chunkCount,
      chunkCount: manifest.chunkCount,
      totalBytes: manifest.totalBytes,
      totalDurationMilliseconds: manifest.totalDurationMilliseconds,
      segmentCount: input.segmentCount ?? 1,
      completedSegmentCount: input.completedSegmentCount ?? (complete ? 1 : 0),
      transcriptText: complete ? (input.transcriptText ?? "reclaimed transcript") : null,
      languages: complete ? ["en"] : [],
      errorCode: input.errorCode ?? null,
      retryable: input.retryable ?? false,
      objectsCleaned: input.state === "discarded",
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      expiresAt: "2026-08-05T07:00:00.000Z",
    },
    segments: [],
    ...(input.retryAfterMilliseconds === undefined
      ? {}
      : { retryAfterMilliseconds: input.retryAfterMilliseconds }),
  };
}

async function renderRecoveredResumableRecording(input: {
  client: NonNullable<Parameters<typeof useVoiceInput>[0]["client"]>;
  store: MemoryVoiceRecordingStore;
  value: string;
  setValue: (value: string) => void;
  ownerId: string;
}) {
  const hook = await renderHook(
    () =>
      useVoiceInput({
        client: input.client,
        workspaceId: "ws-1",
        capability: resumableCapability,
        enabled: true,
        value: input.value,
        setValue: input.setValue,
        focusInput: () => undefined,
        createRecordingStore: () => input.store,
        createOwnerId: () => input.ownerId,
      }),
    undefined,
  );
  await act(async () => {
    await settle(20);
  });
  expect(hook.result.current.status).toBe("recovered");
  return hook;
}

function composerState(
  value: string,
  setValue: (value: string) => void,
  sends: string[],
): ComposerState {
  return {
    value,
    setValue,
    hasDraftContent: () => value.length > 0,
    send: async () => {
      sends.push(value);
      return true;
    },
    steer: async () => true,
    sending: false,
    canSend: value.trim().length > 0,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
  };
}

describe("useVoiceInput", () => {
  test("stop immediately transcribes and appends editable draft text without submitting", async () => {
    const { track } = installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const calls: unknown[] = [];
    let draft = "";
    const client = {
      transcribeAudio: async (_workspaceId: string, input: unknown) => {
        calls.push(input);
        return { text: "hello voice", languages: ["en"] };
      },
    };
    const hook = await renderHook(
      (props: { value: string; setValue: (value: string) => void }) =>
        useVoiceInput({
          client,
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: props.value,
          setValue: props.setValue,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-success",
        }),
      {
        value: draft,
        setValue: (value: string) => {
          draft = value;
        },
      },
    );

    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("recording");
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    expect(calls).toHaveLength(1);
    expect(draft).toBe("hello voice");
    expect(track.stop).toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
    await hook.unmount();
  });

  test("stops every acquired microphone track when recorder or manifest setup fails", async () => {
    const recorderFailure = installMediaMocks();
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: class {
        static isTypeSupported() {
          return true;
        }
        constructor() {
          throw new DOMException("Recorder unavailable", "NotSupportedError");
        }
      },
    });
    const recorderHook = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "unused", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => new MemoryVoiceRecordingStore(),
        }),
      undefined,
    );
    await act(async () => {
      await recorderHook.result.current.start();
    });
    expect(recorderFailure.track.stop).toHaveBeenCalledTimes(1);
    expect(recorderHook.result.current.status).toBe("error");
    await recorderHook.unmount();

    const manifestFailure = installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    store.failNextCreate = new Error("manifest unavailable");
    const manifestHook = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "unused", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
        }),
      undefined,
    );
    await act(async () => {
      await manifestHook.result.current.start();
    });
    expect(manifestFailure.track.stop).toHaveBeenCalledTimes(1);
    expect(manifestHook.result.current.status).toBe("error");
    await manifestHook.unmount();
  });

  test("permission denial stays controlled and late responses after cancel are fenced", async () => {
    installMediaMocks({ deny: true });
    const deniedStore = new MemoryVoiceRecordingStore();
    let draft = "keep";
    const denied = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => ({ text: "nope", languages: [] }),
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => deniedStore,
        }),
      undefined,
    );
    await act(async () => {
      await denied.result.current.start();
    });
    expect(denied.result.current.status).toBe("error");
    expect(denied.result.current.error).toBe("permission_denied");
    expect(draft).toBe("keep");
    await denied.unmount();

    installMediaMocks();
    const recordingStore = new MemoryVoiceRecordingStore();
    let resolveTranscribe: ((value: { text: string; languages: string[] }) => void) | null = null;
    const recording = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: () =>
              new Promise((resolve) => {
                resolveTranscribe = resolve;
              }),
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => recordingStore,
          createRecordingId: () => "recording-late",
        }),
      undefined,
    );
    await act(async () => {
      await recording.result.current.start();
    });
    await act(async () => {
      recording.result.current.stop();
      await settle();
    });
    await act(async () => {
      recording.result.current.cancel();
      await settle();
    });
    await act(async () => {
      resolveTranscribe?.({ text: "late", languages: [] });
      await Promise.resolve();
    });
    expect(draft).toBe("keep");
    await recording.unmount();
  });

  test("workspace replacement fences a pending permission response before manifest creation", async () => {
    const { track } = installMediaMocks();
    const mediaStream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    let resolvePermission: ((stream: MediaStream) => void) | null = null;
    const getUserMedia = mock(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const store = new MemoryVoiceRecordingStore();
    const hook = await renderHook(
      (props: { workspaceId: string }) =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "unused", languages: [] }) },
          workspaceId: props.workspaceId,
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-stale-permission",
          createOwnerId: () => "workspace-permission-owner",
        }),
      { workspaceId: "ws-1" },
    );

    let startPromise!: Promise<boolean>;
    await act(async () => {
      startPromise = hook.result.current.start();
      await settle(4);
    });
    expect(hook.result.current.status).toBe("requesting-permission");
    await hook.rerender({ workspaceId: "ws-2" });

    let started = true;
    await act(async () => {
      resolvePermission?.(mediaStream);
      started = await startPromise;
      await settle(8);
    });
    expect(started).toBe(false);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(store.manifests.size).toBe(0);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.recordingId).toBeNull();
    await hook.unmount();
  });

  test("a delayed stale stop cannot clear or corrupt a successor workspace capture", async () => {
    FakeMediaRecorder.instances = [];
    const oldTrack = { stop: mock(() => undefined) };
    const successorTrack = { stop: mock(() => undefined) };
    const streams = [
      { getTracks: () => [oldTrack] } as unknown as MediaStream,
      { getTracks: () => [successorTrack] } as unknown as MediaStream,
    ];
    const getUserMedia = mock(async () => {
      const stream = streams.shift();
      if (!stream) throw new Error("unexpected media request");
      return stream;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    const store = new MemoryVoiceRecordingStore();
    let recordingNumber = 0;
    const hook = await renderHook(
      (props: { workspaceId: string }) =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              throw new Error("offline");
            },
          },
          workspaceId: props.workspaceId,
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => `recording-${++recordingNumber}`,
          createOwnerId: () => "workspace-stop-owner",
        }),
      { workspaceId: "ws-old" },
    );

    await act(async () => {
      await hook.result.current.start();
    });
    const oldRecorder = FakeMediaRecorder.instances[0];
    if (!oldRecorder) throw new Error("missing old recorder");
    oldRecorder.deferStopEvents = true;
    await hook.rerender({ workspaceId: "ws-new" });
    await act(async () => {
      await settle(8);
      await hook.result.current.start();
    });
    const successorRecorder = FakeMediaRecorder.instances[1];
    if (!successorRecorder) throw new Error("missing successor recorder");
    const successorStream = hook.result.current.stream;
    expect(successorStream).not.toBeNull();
    expect(hook.result.current.status).toBe("recording");

    await act(async () => {
      oldRecorder.finishStop();
      await settle(12);
    });
    expect(successorTrack.stop).toHaveBeenCalledTimes(0);
    expect(hook.result.current.stream).toBe(successorStream);
    expect(hook.result.current.status).toBe("recording");
    expect(successorRecorder.state).toBe("recording");

    await act(async () => {
      successorRecorder.emit(
        new Blob([new Uint8Array([9, 8])], { type: successorRecorder.mimeType }),
        5_000,
      );
      await settle();
      hook.result.current.stop();
      await settle(24);
    });
    expect(successorTrack.stop).toHaveBeenCalledTimes(1);
    expect(successorRecorder.state).toBe("inactive");
    expect((await store.listChunks("recording-2")).map((chunk) => chunk.chunkNumber)).toEqual([
      0, 1,
    ]);
    await hook.unmount();
  });

  test("a stale permission rejection cannot clear a successor workspace capture", async () => {
    FakeMediaRecorder.instances = [];
    const successorTrack = { stop: mock(() => undefined) };
    const successorStream = {
      getTracks: () => [successorTrack],
    } as unknown as MediaStream;
    let rejectOldPermission: ((reason: unknown) => void) | null = null;
    let requestNumber = 0;
    const getUserMedia = mock(() => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return new Promise<MediaStream>((_resolve, reject) => {
          rejectOldPermission = reject;
        });
      }
      return Promise.resolve(successorStream);
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    const store = new MemoryVoiceRecordingStore();
    const hook = await renderHook(
      (props: { workspaceId: string }) =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "complete", languages: [] }) },
          workspaceId: props.workspaceId,
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-successor-permission",
          createOwnerId: () => "workspace-rejection-owner",
        }),
      { workspaceId: "ws-old" },
    );

    let oldStart!: Promise<boolean>;
    await act(async () => {
      oldStart = hook.result.current.start();
      await settle(4);
    });
    await hook.rerender({ workspaceId: "ws-new" });
    await act(async () => {
      await settle(8);
      await hook.result.current.start();
    });
    const successorRecorder = FakeMediaRecorder.instances[0];
    if (!successorRecorder) throw new Error("missing successor recorder");
    expect(hook.result.current.status).toBe("recording");

    let oldStarted = true;
    await act(async () => {
      rejectOldPermission?.(new DOMException("Permission denied", "NotAllowedError"));
      oldStarted = await oldStart;
      await settle(8);
    });
    expect(oldStarted).toBe(false);
    expect(successorTrack.stop).toHaveBeenCalledTimes(0);
    expect(hook.result.current.stream).toBe(successorStream);
    expect(hook.result.current.status).toBe("recording");
    expect(successorRecorder.state).toBe("recording");

    await act(async () => {
      hook.result.current.stop();
      await settle(24);
    });
    expect(successorTrack.stop).toHaveBeenCalledTimes(1);
    expect(successorRecorder.state).toBe("inactive");
    await hook.unmount();
  });

  test("cancel during delayed chunk enumeration never starts a stale upload", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let releaseChunks: (() => void) | null = null;
    store.listChunksGate = new Promise<void>((resolve) => {
      releaseChunks = resolve;
    });
    let listStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    store.listChunksStarted = () => listStarted?.();
    let calls = 0;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              calls += 1;
              return { text: "stale", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-delayed-list",
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
      hook.result.current.stop();
      await started;
    });
    await act(async () => {
      hook.result.current.cancel();
      releaseChunks?.();
      await settle(30);
    });

    expect(calls).toBe(0);
    expect(hook.result.current.status).toBe("recovered");
    expect(store.manifests.get("recording-delayed-list")?.uploadState).toBe("retrying");
    await hook.unmount();
  });

  test("composer mic stop auto-transcribes and never auto-sends", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const sends: string[] = [];
    let draft = "";
    const client = {
      transcribeAudio: async () => ({ text: "from mic", languages: [] }),
    };

    function Harness() {
      const [value, setValue] = useState("");
      draft = value;
      return (
        <ChatComposer
          composer={composerState(value, setValue, sends)}
          transcription={{
            client: client as never,
            workspaceId: "ws-1",
            capability,
            workspaceEnabled: true,
            createRecordingStore: () => store,
            createOwnerId: () => "composer-auto-owner",
          }}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    const button = mounted.container.querySelector<HTMLButtonElement>(
      "[aria-label='Start voice input']",
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(mounted.container.querySelector("[data-voice-waveform]")).toBeTruthy();
    expect(
      mounted.container.querySelector<HTMLButtonElement>("[aria-label='Cancel recording']"),
    ).toBeTruthy();
    const stop = mounted.container.querySelector<HTMLButtonElement>(
      "[aria-label='Stop and transcribe']",
    );
    expect(stop).toBeTruthy();
    await act(async () => {
      stop?.click();
      await settle();
    });
    expect(draft).toBe("from mic");
    expect(sends).toHaveLength(0);
  });

  test("composer cancel discards recording without transcription or send", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const sends: string[] = [];
    let draft = "keep me";
    let calls = 0;
    const client = {
      transcribeAudio: async () => {
        calls += 1;
        return { text: "should not land", languages: [] };
      },
    };

    function Harness() {
      const [value, setValue] = useState("keep me");
      draft = value;
      return (
        <ChatComposer
          composer={composerState(value, setValue, sends)}
          transcription={{
            client: client as never,
            workspaceId: "ws-1",
            capability,
            workspaceEnabled: true,
            createRecordingStore: () => store,
            createOwnerId: () => "composer-cancel-owner",
          }}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Start voice input']")
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Cancel recording']")
        ?.click();
      await settle();
    });
    expect(draft).toBe("keep me");
    expect(calls).toBe(0);
    expect(sends).toHaveLength(0);
    expect(mounted.container.querySelector("[aria-label='Start voice input']")).toBeTruthy();
  });

  test("uses short timeslices and stops before uploading audio above the one-shot byte ceiling", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let transcriptionCalls = 0;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              transcriptionCalls += 1;
              return { text: "oversized", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability: { ...capability, maxDurationSeconds: 3_600, maxSizeBytes: 2 },
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "size-limit-owner",
          createRecordingId: () => "recording-size-limit",
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
    });
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder?.startTimeslice).toBe(VOICE_RECORDING_TIMESLICE_MILLISECONDS);
    expect(VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS).toBe(600);
    await act(async () => {
      hook.result.current.stop();
      await settle(24);
    });

    expect(transcriptionCalls).toBe(0);
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("too_large");
    expect(hook.result.current.hasRecoverableRecording).toBe(true);
    expect(store.manifests.get("recording-size-limit")?.totalBytes).toBe(3);
    await hook.unmount();
  });

  test("uses resumable limits and server methods for a 30+ minute recording", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let draft = "";
    let oneShotCalls = 0;
    let nextChunkNumber = 0;
    let finalizeInput:
      | { chunkCount: number; totalBytes: number; totalDurationMilliseconds: number }
      | undefined;
    const uploaded: Array<{
      chunkNumber: number;
      startMilliseconds: number;
      durationMilliseconds: number;
    }> = [];
    const recording = (state: "uploading" | "ready" | "complete" | "discarded") => ({
      recording: {
        id: "recording-long-resumable",
        workspaceId: "ws-1",
        mimeType: "audio/webm",
        state,
        nextChunkNumber,
        chunkCount: nextChunkNumber,
        totalBytes: nextChunkNumber,
        totalDurationMilliseconds: finalizeInput?.totalDurationMilliseconds ?? 0,
        segmentCount: state === "uploading" ? 0 : 37,
        completedSegmentCount: state === "complete" ? 37 : 0,
        transcriptText: state === "complete" ? "long transcript" : null,
        languages: state === "complete" ? ["en"] : [],
        errorCode: null,
        retryable: false,
        objectsCleaned: state === "discarded",
        createdAt: "2026-08-04T07:00:00.000Z",
        updatedAt: "2026-08-04T07:00:00.000Z",
        expiresAt: "2026-08-05T07:00:00.000Z",
      },
      segments: [],
    });
    const client = {
      transcribeAudio: async () => {
        oneShotCalls += 1;
        return { text: "wrong path", languages: [] };
      },
      createTranscriptionRecording: async () => recording("uploading"),
      getTranscriptionRecording: async () => recording("ready"),
      uploadTranscriptionRecordingChunk: async (
        _workspaceId: string,
        _recordingId: string,
        chunkNumber: number,
        input: { startMilliseconds: number; durationMilliseconds: number },
      ) => {
        uploaded.push({
          chunkNumber,
          startMilliseconds: input.startMilliseconds,
          durationMilliseconds: input.durationMilliseconds,
        });
        nextChunkNumber = chunkNumber + 1;
        return {
          recording: recording("uploading").recording,
          chunk: {
            chunkNumber,
            byteLength: 1,
            sha256: "a".repeat(64),
            startMilliseconds: input.startMilliseconds,
            durationMilliseconds: input.durationMilliseconds,
            deduplicated: false,
          },
        };
      },
      finalizeTranscriptionRecording: async (
        _workspaceId: string,
        _recordingId: string,
        input: { chunkCount: number; totalBytes: number; totalDurationMilliseconds: number },
      ) => {
        finalizeInput = input;
        return recording("ready");
      },
      processNextTranscriptionRecordingSegment: async () => recording("complete"),
      discardTranscriptionRecording: async () => recording("discarded"),
    };
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client,
          workspaceId: "ws-1",
          capability: {
            ...capability,
            maxDurationSeconds: 60,
            maxSizeBytes: 2,
            resumable: {
              maxDurationSeconds: 2 * 60 * 60,
              maxSizeBytes: 512 * 1024 * 1024,
              maxChunkSizeBytes: 8 * 1024 * 1024,
              providerSegmentSeconds: 50,
            },
          },
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "long-resumable-owner",
          createRecordingId: () => "recording-long-resumable",
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
      FakeMediaRecorder.instances[0]?.emit(
        new Blob([new Uint8Array([9])], { type: "audio/webm" }),
        1_805_000,
      );
      hook.result.current.stop();
      await settle(64);
    });

    expect(VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS).toBe(600);
    expect(VOICE_RECORDING_RESUMABLE_CLIENT_MAX_DURATION_SECONDS).toBe(8 * 60 * 60);
    expect(oneShotCalls).toBe(0);
    expect(uploaded.map((chunk) => chunk.chunkNumber)).toEqual([0, 1]);
    expect(uploaded[0]).toMatchObject({ startMilliseconds: 0, durationMilliseconds: 1_805_000 });
    expect(finalizeInput).toMatchObject({
      chunkCount: 2,
      totalDurationMilliseconds: 1_806_000,
    });
    expect(draft).toBe("long transcript");
    expect(hook.result.current.status).toBe("idle");
    await hook.unmount();
  });

  test("reclaims a retryable retained segment once without re-uploading or duplicate handoff", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const recordingId = "recording-retryable-segment";
    await seedStoppedRecording(store, recordingId, "2026-08-04T07:00:00.000Z");
    const manifest = store.manifests.get(recordingId);
    if (!manifest) throw new Error("missing retryable recording manifest");
    const failed = resumableRecordingResponse(manifest, {
      state: "failed",
      retryable: true,
      errorCode: "provider",
    });
    const complete = resumableRecordingResponse(manifest, {
      state: "complete",
      transcriptText: "reclaimed transcript",
    });
    let draft = "existing";
    let uploadCalls = 0;
    let finalizeCalls = 0;
    let processNextCalls = 0;
    let discardCalls = 0;
    const hook = await renderRecoveredResumableRecording({
      client: {
        transcribeAudio: async () => ({ text: "wrong path", languages: [] }),
        createTranscriptionRecording: async () => failed,
        getTranscriptionRecording: async () => failed,
        uploadTranscriptionRecordingChunk: async () => {
          uploadCalls += 1;
          throw new Error("retained chunks must not be uploaded again");
        },
        finalizeTranscriptionRecording: async () => {
          finalizeCalls += 1;
          return failed;
        },
        processNextTranscriptionRecordingSegment: async () => {
          processNextCalls += 1;
          return complete;
        },
        discardTranscriptionRecording: async () => {
          discardCalls += 1;
          return resumableRecordingResponse(manifest, { state: "discarded" });
        },
      },
      store,
      value: draft,
      setValue: (value) => {
        draft = value;
      },
      ownerId: "retryable-segment-owner",
    });

    await act(async () => {
      hook.result.current.retry();
      await settle(30);
    });

    expect(uploadCalls).toBe(0);
    expect(finalizeCalls).toBe(1);
    expect(processNextCalls).toBe(1);
    expect(discardCalls).toBe(1);
    expect(draft).toBe("existing reclaimed transcript");
    expect(hook.result.current.status).toBe("idle");
    expect(store.manifests.has(recordingId)).toBe(false);

    await act(async () => {
      hook.result.current.retry();
      await settle();
    });
    expect(processNextCalls).toBe(1);
    expect(discardCalls).toBe(1);
    expect(draft).toBe("existing reclaimed transcript");
    await hook.unmount();
  });

  test("bounds recovery mutation requests over a 15-minute active lease", () => {
    let elapsed = 0;
    let attempts = 0;
    let maximumDelay = 0;
    while (elapsed < 15 * 60 * 1_000) {
      const delay = transcriptionRecoveryMutationDelayMilliseconds(5_000, attempts, () => 0);
      elapsed += delay;
      maximumDelay = Math.max(maximumDelay, delay);
      attempts += 1;
    }

    expect(attempts).toBeLessThan(40);
    expect(maximumDelay).toBeLessThanOrEqual(
      VOICE_RECORDING_RECOVERY_MAX_MUTATION_DELAY_MILLISECONDS,
    );
    expect(transcriptionRecoveryMutationDelayMilliseconds(5_000, 0, () => 0)).toBe(5_000);
    expect(transcriptionRecoveryMutationDelayMilliseconds(5_000, 1, () => 0)).toBe(10_000);
    expect(transcriptionRecoveryMutationDelayMilliseconds(5_000, 99, () => 0)).toBe(30_000);
    expect(transcriptionRecoveryMutationDelayMilliseconds(5_000, 0, () => 0.5)).toBe(5_500);
    expect(transcriptionRecoveryMutationDelayMilliseconds(60_001, 0, () => 0)).toBe(30_000);
  });

  test("re-enters process-next after a claimed-segment crash and repeated stale polling", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const recordingId = "recording-crashed-segment";
    await seedStoppedRecording(store, recordingId, "2026-08-04T07:00:00.000Z");
    const manifest = store.manifests.get(recordingId);
    if (!manifest) throw new Error("missing crashed recording manifest");
    const transcribing = resumableRecordingResponse(manifest, {
      state: "transcribing",
      segmentCount: 1,
      retryAfterMilliseconds: 500,
    });
    const complete = resumableRecordingResponse(manifest, {
      state: "complete",
      transcriptText: "recovered after crash",
    });
    let draft = "existing";
    let getCalls = 0;
    let uploadCalls = 0;
    let finalizeCalls = 0;
    let processNextCalls = 0;
    let discardCalls = 0;
    let crashed = false;
    const hook = await renderRecoveredResumableRecording({
      client: {
        transcribeAudio: async () => ({ text: "wrong path", languages: [] }),
        createTranscriptionRecording: async () => transcribing,
        getTranscriptionRecording: async () => {
          getCalls += 1;
          return transcribing;
        },
        uploadTranscriptionRecordingChunk: async () => {
          uploadCalls += 1;
          throw new Error("claimed recordings must not re-upload chunks");
        },
        finalizeTranscriptionRecording: async () => {
          finalizeCalls += 1;
          return transcribing;
        },
        processNextTranscriptionRecordingSegment: async () => {
          processNextCalls += 1;
          if (!crashed) {
            crashed = true;
            throw new Error("handler exited after claiming the segment");
          }
          return processNextCalls === 2 ? transcribing : complete;
        },
        discardTranscriptionRecording: async () => {
          discardCalls += 1;
          return resumableRecordingResponse(manifest, { state: "discarded" });
        },
      },
      store,
      value: draft,
      setValue: (value) => {
        draft = value;
      },
      ownerId: "crashed-segment-owner",
    });

    await act(async () => {
      hook.result.current.retry();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await settle(30);
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("unknown");

    await act(async () => {
      hook.result.current.retry();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await settle(30);
    });

    expect(getCalls).toBeGreaterThan(0);
    expect(uploadCalls).toBe(0);
    expect(finalizeCalls).toBe(2);
    expect(processNextCalls).toBe(3);
    expect(discardCalls).toBe(1);
    expect(draft).toBe("existing recovered after crash");
    expect(hook.result.current.status).toBe("idle");
    expect(store.manifests.has(recordingId)).toBe(false);
    await hook.unmount();
  });

  test("uses cheap status reads before a hinted recovery mutation is due", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const recordingId = "recording-cheap-recovery-poll";
    await seedStoppedRecording(store, recordingId, "2026-08-04T07:00:00.000Z");
    const manifest = store.manifests.get(recordingId);
    if (!manifest) throw new Error("missing cheap recovery polling manifest");
    const transcribing = resumableRecordingResponse(manifest, {
      state: "transcribing",
      segmentCount: 1,
      retryAfterMilliseconds: 3_000,
    });
    const ready = resumableRecordingResponse(manifest, { state: "ready" });
    const complete = resumableRecordingResponse(manifest, {
      state: "complete",
      transcriptText: "recovered after status polling",
    });
    let draft = "";
    let getCalls = 0;
    let processNextCalls = 0;
    const hook = await renderRecoveredResumableRecording({
      client: {
        transcribeAudio: async () => ({ text: "wrong path", languages: [] }),
        createTranscriptionRecording: async () => transcribing,
        getTranscriptionRecording: async () => {
          getCalls += 1;
          return getCalls === 1 ? transcribing : ready;
        },
        uploadTranscriptionRecordingChunk: async () => {
          throw new Error("claimed recordings must not re-upload chunks");
        },
        finalizeTranscriptionRecording: async () => transcribing,
        processNextTranscriptionRecordingSegment: async () => {
          processNextCalls += 1;
          return complete;
        },
        discardTranscriptionRecording: async () =>
          resumableRecordingResponse(manifest, { state: "discarded" }),
      },
      store,
      value: draft,
      setValue: (value) => {
        draft = value;
      },
      ownerId: "cheap-recovery-poll-owner",
    });

    await act(async () => {
      hook.result.current.retry();
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await settle(10);
    });
    expect(getCalls).toBe(1);
    expect(processNextCalls).toBe(0);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      await settle(20);
    });
    expect(getCalls).toBe(2);
    expect(processNextCalls).toBe(1);
    expect(draft).toBe("recovered after status polling");
    expect(hook.result.current.status).toBe("idle");
    expect(store.manifests.has(recordingId)).toBe(false);
    await hook.unmount();
  });

  test("re-enters finalize while polling a segmenting assembly until it becomes ready", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const recordingId = "recording-stale-assembly";
    await seedStoppedRecording(store, recordingId, "2026-08-04T07:00:00.000Z");
    const manifest = store.manifests.get(recordingId);
    if (!manifest) throw new Error("missing stale assembly manifest");
    const segmenting = resumableRecordingResponse(manifest, {
      state: "segmenting",
      segmentCount: 0,
      retryAfterMilliseconds: 500,
    });
    const ready = resumableRecordingResponse(manifest, { state: "ready" });
    const complete = resumableRecordingResponse(manifest, {
      state: "complete",
      transcriptText: "assembled after stale lease",
    });
    let draft = "";
    let getCalls = 0;
    let finalizeCalls = 0;
    let processNextCalls = 0;
    const hook = await renderRecoveredResumableRecording({
      client: {
        transcribeAudio: async () => ({ text: "wrong path", languages: [] }),
        createTranscriptionRecording: async () => segmenting,
        getTranscriptionRecording: async () => {
          getCalls += 1;
          return segmenting;
        },
        uploadTranscriptionRecordingChunk: async () => {
          throw new Error("segmenting recordings must not re-upload chunks");
        },
        finalizeTranscriptionRecording: async () => {
          finalizeCalls += 1;
          return finalizeCalls === 1 ? segmenting : ready;
        },
        processNextTranscriptionRecordingSegment: async () => {
          processNextCalls += 1;
          return complete;
        },
        discardTranscriptionRecording: async () =>
          resumableRecordingResponse(manifest, { state: "discarded" }),
      },
      store,
      value: draft,
      setValue: (value) => {
        draft = value;
      },
      ownerId: "stale-assembly-owner",
    });

    await act(async () => {
      hook.result.current.retry();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await settle(20);
    });

    expect(getCalls).toBeGreaterThan(0);
    expect(finalizeCalls).toBe(2);
    expect(processNextCalls).toBe(1);
    expect(draft).toBe("assembled after stale lease");
    expect(hook.result.current.status).toBe("idle");
    expect(store.manifests.has(recordingId)).toBe(false);
    await hook.unmount();
  });

  test("retries failed segment assembly through finalize before processing any segment", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const recordingId = "recording-retryable-assembly";
    await seedStoppedRecording(store, recordingId, "2026-08-04T07:00:00.000Z");
    const manifest = store.manifests.get(recordingId);
    if (!manifest) throw new Error("missing retryable assembly manifest");
    const failedAssembly = resumableRecordingResponse(manifest, {
      state: "failed",
      segmentCount: 0,
      retryable: true,
      errorCode: "provider",
    });
    const ready = resumableRecordingResponse(manifest, { state: "ready" });
    const complete = resumableRecordingResponse(manifest, {
      state: "complete",
      transcriptText: "assembled transcript",
    });
    const calls: string[] = [];
    let finalizeCalls = 0;
    let draft = "";
    const hook = await renderRecoveredResumableRecording({
      client: {
        transcribeAudio: async () => ({ text: "wrong path", languages: [] }),
        createTranscriptionRecording: async () => failedAssembly,
        getTranscriptionRecording: async () => failedAssembly,
        uploadTranscriptionRecordingChunk: async () => {
          throw new Error("retained chunks must not be uploaded again");
        },
        finalizeTranscriptionRecording: async () => {
          calls.push("finalize");
          finalizeCalls += 1;
          return finalizeCalls === 1 ? failedAssembly : ready;
        },
        processNextTranscriptionRecordingSegment: async () => {
          calls.push("process-next");
          return complete;
        },
        discardTranscriptionRecording: async () =>
          resumableRecordingResponse(manifest, { state: "discarded" }),
      },
      store,
      value: draft,
      setValue: (value) => {
        draft = value;
      },
      ownerId: "retryable-assembly-owner",
    });
    await act(async () => {
      hook.result.current.retry();
      await settle(30);
    });

    expect(calls).toEqual(["finalize", "finalize", "process-next"]);
    expect(draft).toBe("assembled transcript");
    expect(hook.result.current.status).toBe("idle");
    expect(store.manifests.has(recordingId)).toBe(false);
    await hook.unmount();
  });

  test.each([
    ["repeated retryable", true, 1],
    ["terminal", false, 0],
  ] as const)(
    "surfaces a %s retained-segment failure without duplicate processing",
    async (_label, retryable, expectedProcessNextCalls) => {
      installMediaMocks();
      const store = new MemoryVoiceRecordingStore();
      const recordingId = `recording-${retryable ? "retryable-again" : "terminal"}`;
      await seedStoppedRecording(store, recordingId, "2026-08-04T07:00:00.000Z");
      const manifest = store.manifests.get(recordingId);
      if (!manifest) throw new Error("missing failed recording manifest");
      const failed = resumableRecordingResponse(manifest, {
        state: "failed",
        retryable,
        errorCode: "provider",
      });
      let draft = "unchanged";
      let uploadCalls = 0;
      let processNextCalls = 0;
      const hook = await renderRecoveredResumableRecording({
        client: {
          transcribeAudio: async () => ({ text: "wrong path", languages: [] }),
          createTranscriptionRecording: async () => failed,
          getTranscriptionRecording: async () => failed,
          uploadTranscriptionRecordingChunk: async () => {
            uploadCalls += 1;
            throw new Error("retained chunks must not be uploaded again");
          },
          finalizeTranscriptionRecording: async () => failed,
          processNextTranscriptionRecordingSegment: async () => {
            processNextCalls += 1;
            return failed;
          },
          discardTranscriptionRecording: async () =>
            resumableRecordingResponse(manifest, { state: "discarded" }),
        },
        store,
        value: draft,
        setValue: (value) => {
          draft = value;
        },
        ownerId: `${recordingId}-owner`,
      });
      await act(async () => {
        hook.result.current.retry();
        await settle(30);
      });

      expect(uploadCalls).toBe(0);
      expect(processNextCalls).toBe(expectedProcessNextCalls);
      expect(draft).toBe("unchanged");
      expect(hook.result.current.status).toBe(retryable ? "retrying" : "error");
      expect(hook.result.current.error).toBe("provider");
      expect(store.manifests.has(recordingId)).toBe(true);
      await hook.unmount();
    },
  );

  test("fails closed when a recorder chunk cannot be durably persisted", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    store.failNextPersist = new Error("quota exceeded");
    let transcriptionCalls = 0;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              transcriptionCalls += 1;
              return { text: "unsafe", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-storage-failure",
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
      hook.result.current.stop();
      await settle(24);
    });

    expect(transcriptionCalls).toBe(0);
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("storage_unavailable");
    expect(hook.result.current.hasRecoverableRecording).toBe(true);
    expect(store.manifests.has("recording-storage-failure")).toBe(true);
    await hook.unmount();
  });

  test("automatically retries the same durable recording and holds delayed text for insertion", async () => {
    const { getUserMedia } = installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const submitted: TranscribeAudioInput[] = [];
    let draft = "";
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async (_workspaceId, input) => {
              submitted.push(input);
              if (submitted.length === 1) throw new TypeError("network unavailable");
              return { text: "recovered transcript", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-retry",
          automaticRetryDelayMilliseconds: 0,
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
    });
    const recorder = FakeMediaRecorder.instances[0];
    await act(async () => {
      recorder?.emit(new Blob(["first"], { type: recorder.mimeType }), 5_000);
      recorder?.emit(new Blob(["second"], { type: recorder.mimeType }), 10_000);
      hook.result.current.stop();
      await settle(40);
    });
    expect(hook.result.current.status).toBe("retrying");

    await act(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await settle(20);
      }
    });

    expect(hook.result.current.status).toBe("transcript-ready");
    expect(hook.result.current.error).toBe("handoff_uncertain");
    expect(hook.result.current.recordingId).toBe("recording-retry");
    expect((await store.listChunks("recording-retry")).map((chunk) => chunk.chunkNumber)).toEqual([
      0, 1, 2,
    ]);
    expect(store.manifests.has("recording-retry")).toBe(true);

    expect(submitted).toHaveLength(2);
    const firstSubmission = submitted[0];
    const retrySubmission = submitted[1];
    if (!firstSubmission || !retrySubmission) throw new Error("missing retry submissions");
    expect(firstSubmission.audio).toBeInstanceOf(Blob);
    expect(retrySubmission.audio).toBeInstanceOf(Blob);
    expect((retrySubmission.audio as Blob).size).toBe((firstSubmission.audio as Blob).size);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(draft).toBe("");
    expect(store.manifests.get("recording-retry")).toMatchObject({
      recoveryMode: "automatic",
      handoffMode: "explicit",
      finalizationState: "transcript-ready",
    });

    await act(async () => {
      await hook.result.current.insertSavedTranscript();
      await settle(20);
    });
    expect(draft).toBe("recovered transcript");
    expect(hook.result.current.status).toBe("idle");
    expect(store.manifests.has("recording-retry")).toBe(false);
    await hook.unmount();
  });

  test("does not postpone automatic recovery when parent renders replace callbacks", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let transcriptionCalls = 0;
    const client = {
      transcribeAudio: async () => {
        transcriptionCalls += 1;
        if (transcriptionCalls === 1) throw new TypeError("network unavailable");
        return { text: "recovered after live renders", languages: [] };
      },
    };
    const hook = await renderHook(
      (props: { render: number }) =>
        useVoiceInput({
          client,
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          // The real composer replaced this callback on every live session render.
          focusInput: () => void props.render,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-live-renders",
          automaticRetryDelayMilliseconds: 30,
        }),
      { render: 0 },
    );

    await act(async () => {
      await hook.result.current.start();
      hook.result.current.stop();
      await settle(30);
    });
    expect(hook.result.current.status).toBe("retrying");
    expect(transcriptionCalls).toBe(1);

    for (let render = 1; render <= 8; render += 1) {
      await hook.rerender({ render });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await settle(10);
      });
    }

    expect(transcriptionCalls).toBe(2);
    expect(hook.result.current.status).toBe("transcript-ready");
    expect(store.manifests.get("recording-live-renders")?.transcriptText).toBe(
      "recovered after live renders",
    );
    await hook.unmount();
  });

  test("pauses automatic recovery without deleting the saved recording", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let transcriptionCalls = 0;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              transcriptionCalls += 1;
              throw new TypeError("network unavailable");
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-paused-recovery",
          automaticRetryDelayMilliseconds: 60_000,
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
      hook.result.current.stop();
      await settle(30);
    });
    expect(hook.result.current.status).toBe("retrying");

    await act(async () => {
      hook.result.current.cancel();
      await settle(30);
    });

    expect(transcriptionCalls).toBe(1);
    expect(hook.result.current.status).toBe("recovered");
    expect(store.manifests.get("recording-paused-recovery")).toMatchObject({
      recoveryMode: "manual",
      handoffMode: "explicit",
    });
    expect(store.manifests.has("recording-paused-recovery")).toBe(true);
    await hook.unmount();
  });

  test("does not loop on a deterministic API conflict even when generic HTTP policy marks 409 retryable", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let transcriptionCalls = 0;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              transcriptionCalls += 1;
              throw new OpenGeniApiError(
                409,
                JSON.stringify({
                  error: {
                    status: 409,
                    code: "conflict",
                    message: "Recording metadata conflicts.",
                    retryable: true,
                  },
                }),
              );
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-conflict",
          automaticRetryDelayMilliseconds: 0,
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
      hook.result.current.stop();
      await settle(30);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle(20);
    });

    expect(transcriptionCalls).toBe(1);
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("conflict");
    expect(store.manifests.has("recording-conflict")).toBe(true);
    await hook.unmount();
  });

  test("waits for a deferred final chunk before exposing same-recording retry", async () => {
    const { getUserMedia } = installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const submitted: TranscribeAudioInput[] = [];
    let draft = "";
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async (_workspaceId, input) => {
              submitted.push(input);
              return { text: "complete recording", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-deferred-stop",
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
    });
    const recorder = FakeMediaRecorder.instances[0];
    if (!recorder) throw new Error("missing fake recorder");
    recorder.deferStopEvents = true;
    await act(async () => {
      recorder.emit(new Blob([new Uint8Array([7, 8])], { type: recorder.mimeType }), 5_000);
      await settle();
    });
    await act(async () => {
      hook.result.current.stop();
    });
    expect(hook.result.current.status).toBe("saving");
    await act(async () => {
      hook.result.current.cancel();
      await settle();
    });
    expect(hook.result.current.status).toBe("saving");
    expect(submitted).toHaveLength(0);

    await act(async () => {
      recorder.finishStop();
      await settle(24);
    });
    expect(hook.result.current.status).toBe("recovered");
    expect(
      (await store.listChunks("recording-deferred-stop")).map((chunk) => chunk.chunkNumber),
    ).toEqual([0, 1]);

    await act(async () => {
      hook.result.current.retry();
      await settle(24);
    });
    expect(submitted).toHaveLength(1);
    const retrySubmission = submitted[0];
    if (!retrySubmission) throw new Error("missing deferred-stop retry submission");
    expect((retrySubmission.audio as Blob).size).toBe(5);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(draft).toBe("complete recording");
    await hook.unmount();
  });

  test("never retries a recovered recording against a different workspace", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const manifest = createVoiceRecordingManifest({
      recordingId: "recording-workspace-boundary",
      workspaceId: "ws-1",
      mimeType: "audio/webm",
      createdAt: "2026-08-03T21:00:00.000Z",
    });
    await store.createManifest(manifest);
    await store.persistChunk({
      recordingId: manifest.recordingId,
      chunkNumber: 0,
      capturedAt: "2026-08-03T21:00:05.000Z",
      startMilliseconds: 0,
      durationMilliseconds: 5_000,
      mimeType: manifest.mimeType,
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: manifest.mimeType }),
    });
    await store.updateManifest(
      manifest.recordingId,
      { captureState: "stopped", recoveryMode: "manual", handoffMode: "explicit" },
      "2026-08-03T21:00:05.000Z",
    );
    const calls: string[] = [];
    const hook = await renderHook(
      (props: { workspaceId: string }) =>
        useVoiceInput({
          client: {
            transcribeAudio: async (workspaceId) => {
              calls.push(workspaceId);
              return { text: "workspace safe", languages: [] };
            },
          },
          workspaceId: props.workspaceId,
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "workspace-boundary-owner",
        }),
      { workspaceId: "ws-1" },
    );
    await act(async () => {
      await settle(16);
    });
    expect(hook.result.current.status).toBe("recovered");

    await hook.rerender({ workspaceId: "ws-2" });
    await act(async () => {
      await settle(16);
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.recordingId).toBeNull();
    await act(async () => {
      hook.result.current.retry();
      await settle();
    });
    expect(calls).toEqual([]);
    expect(store.manifests.has(manifest.recordingId)).toBe(true);

    await hook.rerender({ workspaceId: "ws-1" });
    await act(async () => {
      await settle(16);
    });
    expect(hook.result.current.status).toBe("recovered");
    await act(async () => {
      hook.result.current.retry();
      await settle(24);
    });
    expect(calls).toEqual(["ws-1"]);
    await hook.unmount();
  });

  test("does not restore a stopped manifest after its workspace generation is replaced", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let releaseStopUpdate!: () => void;
    store.stopUpdateGate = new Promise<void>((resolve) => {
      releaseStopUpdate = resolve;
    });
    let markStopUpdateStarted: (() => void) | null = null;
    const stopUpdateStarted = new Promise<void>((resolve) => {
      markStopUpdateStarted = resolve;
    });
    store.stopUpdateStarted = () => markStopUpdateStarted?.();
    let recordingSequence = 0;
    const hook = await renderHook(
      (props: { workspaceId: string }) =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "unused", languages: [] }) },
          workspaceId: props.workspaceId,
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => `recording-workspace-stop-${recordingSequence++}`,
          createOwnerId: () => "workspace-stop-owner",
        }),
      { workspaceId: "ws-1" },
    );

    await act(async () => {
      await hook.result.current.start();
      hook.result.current.stop();
      await stopUpdateStarted;
    });
    await hook.rerender({ workspaceId: "ws-2" });
    await act(async () => {
      await settle(16);
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.recordingId).toBeNull();

    store.stopUpdateGate = null;
    releaseStopUpdate();
    await act(async () => {
      await settle(24);
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.recordingId).toBeNull();

    let startedInNewWorkspace = false;
    await act(async () => {
      startedInNewWorkspace = await hook.result.current.start();
    });
    expect(startedInNewWorkspace).toBe(true);
    expect(hook.result.current.status).toBe("recording");
    expect(hook.result.current.recordingId).toBe("recording-workspace-stop-1");
    await hook.unmount();
  });

  test("keeps a live capturing manifest private to its owning tab until ownership is released", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const first = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "first", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-live-tab",
          createOwnerId: () => "tab-a",
        }),
      undefined,
    );
    await act(async () => {
      await first.result.current.start();
    });

    const second = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "second", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "tab-b",
        }),
      undefined,
    );
    await act(async () => {
      await settle(20);
    });
    expect(second.result.current.status).toBe("idle");
    expect(second.result.current.hasRecoverableRecording).toBe(false);
    await act(async () => {
      await second.result.current.discard();
    });
    expect(store.manifests.has("recording-live-tab")).toBe(true);
    await second.unmount();

    await first.unmount();
    await act(async () => {
      await settle(30);
    });
    expect(store.manifests.get("recording-live-tab")?.ownerId).toBeNull();
    expect(store.manifests.get("recording-live-tab")?.captureState).toBe("stopped");

    const recovered = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "recovered", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "tab-c",
        }),
      undefined,
    );
    await act(async () => {
      await settle(20);
    });
    expect(recovered.result.current.status).toBe("retrying");
    expect(recovered.result.current.recordingId).toBe("recording-live-tab");
    await recovered.unmount();
  });

  test("advances through every retained recording after the current one is discarded", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    await seedStoppedRecording(store, "recording-oldest", "2026-08-03T20:00:00.000Z");
    await seedStoppedRecording(store, "recording-newer", "2026-08-03T20:01:00.000Z");
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "unused", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "queue-tab",
        }),
      undefined,
    );
    await act(async () => {
      await settle(20);
    });
    expect(hook.result.current.recordingId).toBe("recording-oldest");

    await act(async () => {
      await hook.result.current.discard();
      await settle(20);
    });
    expect(hook.result.current.status).toBe("recovered");
    expect(hook.result.current.recordingId).toBe("recording-newer");
    expect(store.manifests.has("recording-oldest")).toBe(false);
    expect(store.manifests.has("recording-newer")).toBe(true);
    await hook.unmount();
  });

  test("persists transcript before handoff and never auto-retranscribes or re-appends after uncertainty", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    store.failHandedOffUpdate = new Error("handoff state unavailable");
    store.failNextDiscard = new Error("discard must not run before durable handoff");
    let calls = 0;
    let firstDraft = "";
    const first = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              calls += 1;
              return { text: "saved transcript", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: firstDraft,
          setValue: (value) => {
            firstDraft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-handoff-uncertain",
          createOwnerId: () => "handoff-tab-a",
        }),
      undefined,
    );
    await act(async () => {
      await first.result.current.start();
      first.result.current.stop();
      await settle(30);
    });
    expect(firstDraft).toBe("saved transcript");
    expect(calls).toBe(1);
    expect(first.result.current.status).toBe("transcript-ready");
    expect(first.result.current.error).toBe("handoff_uncertain");
    expect(store.manifests.get("recording-handoff-uncertain")).toMatchObject({
      finalizationState: "transcript-ready",
      transcriptText: "saved transcript",
    });
    expect(store.failNextDiscard).not.toBeNull();
    await first.unmount();
    await act(async () => {
      await settle(20);
    });

    let recoveredDraft = "existing draft";
    const recovered = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              calls += 1;
              return { text: "duplicate", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: recoveredDraft,
          setValue: (value) => {
            recoveredDraft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "handoff-tab-b",
        }),
      undefined,
    );
    await act(async () => {
      await settle(20);
    });
    expect(recovered.result.current.status).toBe("transcript-ready");
    expect(recovered.result.current.savedTranscript).toBe("saved transcript");
    expect(recoveredDraft).toBe("existing draft");
    expect(calls).toBe(1);

    await act(async () => {
      await recovered.result.current.insertSavedTranscript();
      await settle(20);
    });
    expect(recoveredDraft).toBe("existing draft saved transcript");
    expect(calls).toBe(1);
    expect(recovered.result.current.status).toBe("idle");
    expect(store.manifests.has("recording-handoff-uncertain")).toBe(false);
    await recovered.unmount();
  });

  test("retries handed-off cleanup after the first local discard fails", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    store.failNextDiscard = new Error("temporary IndexedDB cleanup failure");
    let draft = "";
    let calls = 0;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              calls += 1;
              return { text: "delivered once", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-cleanup-failure",
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
      hook.result.current.stop();
      await settle(30);
    });
    expect(draft).toBe("delivered once");
    expect(calls).toBe(1);
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.hasRecoverableRecording).toBe(false);
    expect(store.manifests.has("recording-cleanup-failure")).toBe(false);
    await act(async () => {
      hook.result.current.retry();
      await settle();
    });
    expect(calls).toBe(1);
    await hook.unmount();
  });

  test("garbage-collects a retained handed-off record on the next same-tab mount", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    store.failNextDiscard = new Error("temporary IndexedDB discard failure");
    let calls = 0;
    const first = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              calls += 1;
              return { text: "delivered before cleanup", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-cleanup-remount",
          createOwnerId: () => "cleanup-same-tab",
        }),
      undefined,
    );

    await act(async () => {
      await first.result.current.start();
      store.failNextCleanup = new Error("temporary IndexedDB cleanup failure");
      first.result.current.stop();
      await settle(30);
    });
    expect(calls).toBe(1);
    expect(first.result.current.status).toBe("idle");
    expect(store.manifests.get("recording-cleanup-remount")?.finalizationState).toBe("handed-off");
    await first.unmount();

    const recovered = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              calls += 1;
              return { text: "must not retranscribe", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "cleanup-same-tab",
        }),
      undefined,
    );
    await act(async () => {
      await settle(20);
    });
    expect(recovered.result.current.status).toBe("idle");
    expect(recovered.result.current.hasRecoverableRecording).toBe(false);
    expect(store.manifests.has("recording-cleanup-remount")).toBe(false);
    expect(calls).toBe(1);
    await recovered.unmount();
  });

  test("surfaces a stopped recording after reload and retries without reopening the microphone", async () => {
    const { getUserMedia } = installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    const first = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              throw new TypeError("network timeout");
            },
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-reload",
          createOwnerId: () => "reload-owner",
        }),
      undefined,
    );

    await act(async () => {
      await first.result.current.start();
      first.result.current.stop();
      await settle(24);
    });
    expect(first.result.current.status).toBe("retrying");
    await first.unmount();

    let draft = "";
    const recovered = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => ({ text: "after reload", languages: [] }),
          },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createOwnerId: () => "reload-owner",
          automaticRetryDelayMilliseconds: 0,
        }),
      undefined,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle(30);
    });

    expect(recovered.result.current.status).toBe("transcript-ready");
    expect(recovered.result.current.recordingId).toBe("recording-reload");
    expect(draft).toBe("");
    await act(async () => {
      await recovered.result.current.insertSavedTranscript();
      await settle(24);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(draft).toBe("after reload");
    expect(recovered.result.current.status).toBe("idle");
    await recovered.unmount();
  });

  test("appendFinalTranscript inserts once with spacing", () => {
    expect(appendFinalTranscript("", "hello")).toBe("hello");
    expect(appendFinalTranscript("hi", "there")).toBe("hi there");
    expect(appendFinalTranscript("hi ", "there")).toBe("hi there");
    expect(appendFinalTranscript("hi", "   ")).toBe("hi");
  });
});
