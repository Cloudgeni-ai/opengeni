import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TranscribeAudioInput } from "@opengeni/sdk";
import { act, useState } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { appendFinalTranscript } from "../src/hooks/use-transcription";
import {
  VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS,
  VOICE_RECORDING_TIMESLICE_MILLISECONDS,
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
    { captureState: "stopped" },
    new Date(new Date(createdAt).getTime() + 1_000).toISOString(),
  );
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

  test("retains ordered chunks after a transcription error and retries the same recording", async () => {
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
              if (submitted.length === 1) throw { code: "network" };
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
      await settle(30);
    });

    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("network");
    expect(hook.result.current.recordingId).toBe("recording-retry");
    expect((await store.listChunks("recording-retry")).map((chunk) => chunk.chunkNumber)).toEqual([
      0, 1, 2,
    ]);
    expect(store.manifests.has("recording-retry")).toBe(true);

    await act(async () => {
      hook.result.current.retry();
      await settle(30);
    });

    expect(submitted).toHaveLength(2);
    const firstSubmission = submitted[0];
    const retrySubmission = submitted[1];
    if (!firstSubmission || !retrySubmission) throw new Error("missing retry submissions");
    expect(firstSubmission.audio).toBeInstanceOf(Blob);
    expect(retrySubmission.audio).toBeInstanceOf(Blob);
    expect((retrySubmission.audio as Blob).size).toBe((firstSubmission.audio as Blob).size);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(draft).toBe("recovered transcript");
    expect(hook.result.current.status).toBe("idle");
    expect(store.manifests.has("recording-retry")).toBe(false);
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
      { captureState: "stopped" },
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
    expect(recovered.result.current.status).toBe("recovered");
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
              throw { code: "timeout" };
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
    expect(first.result.current.status).toBe("error");
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
        }),
      undefined,
    );
    await act(async () => {
      await settle(20);
    });

    expect(recovered.result.current.status).toBe("recovered");
    expect(recovered.result.current.recordingId).toBe("recording-reload");
    await act(async () => {
      recovered.result.current.retry();
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
