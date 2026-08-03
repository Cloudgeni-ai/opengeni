import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TranscribeAudioInput } from "@opengeni/sdk";
import { act, useState } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { appendFinalTranscript } from "../src/hooks/use-transcription";
import {
  VOICE_RECORDING_TIMESLICE_MILLISECONDS,
  useVoiceInput,
} from "../src/hooks/use-voice-input";
import {
  createVoiceRecordingManifest,
  planVoiceRecordingChunkCommit,
  prepareVoiceRecordingChunk,
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
  maxDurationSeconds: 1_800,
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

  async createManifest(manifest: VoiceRecordingManifest): Promise<void> {
    if (this.manifests.has(manifest.recordingId)) throw new Error("duplicate manifest");
    this.manifests.set(manifest.recordingId, manifest);
  }

  async getManifest(recordingId: string): Promise<VoiceRecordingManifest | null> {
    return this.manifests.get(recordingId) ?? null;
  }

  async listRecoverableManifests(workspaceId: string): Promise<VoiceRecordingManifest[]> {
    return [...this.manifests.values()].filter(
      (manifest) =>
        manifest.workspaceId === workspaceId &&
        manifest.captureState !== "discarded" &&
        manifest.finalizationState !== "handed-off",
    );
  }

  async listChunks(recordingId: string): Promise<VoiceRecordingChunk[]> {
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
        "captureState" | "uploadState" | "transcriptionState" | "finalizationState"
      >
    >,
    updatedAt: string,
  ): Promise<VoiceRecordingManifest> {
    const manifest = this.manifests.get(recordingId);
    if (!manifest) throw new Error("missing manifest");
    const updated = { ...manifest, ...update, updatedAt };
    this.manifests.set(recordingId, updated);
    return updated;
  }

  async discard(recordingId: string): Promise<void> {
    if (this.failNextDiscard) {
      const error = this.failNextDiscard;
      this.failNextDiscard = null;
      throw error;
    }
    this.manifests.delete(recordingId);
    for (const [key, chunk] of this.chunks) {
      if (chunk.recordingId === recordingId) this.chunks.delete(key);
    }
  }

  async close(): Promise<void> {}
}

async function settle(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
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

  test("uses short timeslices and preserves a simulated 31-minute recording duration", async () => {
    installMediaMocks();
    const store = new MemoryVoiceRecordingStore();
    let submitted: TranscribeAudioInput | undefined;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async (_workspaceId, input) => {
              submitted = input;
              return { text: "long recording", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability: { ...capability, maxDurationSeconds: 3_600 },
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
          createRecordingStore: () => store,
          createRecordingId: () => "recording-long",
          now: () => new Date("2026-08-03T21:00:00.000Z"),
        }),
      undefined,
    );

    await act(async () => {
      await hook.result.current.start();
    });
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder?.startTimeslice).toBe(VOICE_RECORDING_TIMESLICE_MILLISECONDS);
    await act(async () => {
      recorder?.emit(new Blob([new Uint8Array([4, 5])], { type: recorder.mimeType }), 31 * 60_000);
      await settle();
    });
    expect(hook.result.current.locallySaved).toBe(true);
    expect(hook.result.current.durationSeconds).toBe(31 * 60);
    await act(async () => {
      hook.result.current.stop();
      await settle(24);
    });

    if (!submitted) throw new Error("missing long recording submission");
    expect(submitted.durationSeconds).toBe(31 * 60 + 1);
    expect(submitted.audio).toBeInstanceOf(Blob);
    expect((submitted.audio as Blob).size).toBe(5);
    expect(hook.result.current.status).toBe("idle");
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

  test("does not expose retry after transcript handoff when local discard fails", async () => {
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
    expect(store.manifests.get("recording-cleanup-failure")?.finalizationState).toBe("handed-off");
    await act(async () => {
      hook.result.current.retry();
      await settle();
    });
    expect(calls).toBe(1);
    await hook.unmount();
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
