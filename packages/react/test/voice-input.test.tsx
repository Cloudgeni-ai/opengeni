import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createMemoryRecordingChunkStore,
  type Recorder,
  type RecorderOptions,
  type RecorderPlatform,
  type RecorderSnapshot,
} from "@opengeni/sdk/recordings";
import { act, useState } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { appendFinalTranscript } from "../src/hooks/use-transcription";
import {
  VOICE_RECORDING_TIMESLICE_MILLISECONDS,
  useVoiceInput,
  type UseVoiceInputOptions,
  type VoiceInputRecordingsClient,
} from "../src/hooks/use-voice-input";
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
  globalThis.localStorage?.clear();
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

async function settle(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

/** Let real timers (the transcript poll) run, inside act. */
async function waitFor(check: () => boolean, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!check()) {
    if (Date.now() >= deadline) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await settle();
    });
  }
}

// ---------------------------------------------------------------------------
// One-shot dictation: a client with only transcribeAudio records in memory.

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  startTimeslice: number | undefined;
  bytes = 3;
  private listeners: Array<() => void> = [];
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
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
  addEventListener(_type: "stop", listener: () => void) {
    this.listeners.push(listener);
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(this.bytes)], { type: this.mimeType }),
    });
    for (const listener of this.listeners.splice(0)) listener();
  }
}

function installMediaMocks(options?: { deny?: boolean }) {
  FakeMediaRecorder.instances = [];
  const track = { stop: mock(() => undefined) };
  const getUserMedia = options?.deny
    ? mock(async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      })
    : mock(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  return { track, getUserMedia };
}

// ---------------------------------------------------------------------------
// Durable dictation: a fake recordings server and a fake recorder platform.

type FakeVersion = {
  id: string;
  state: "queued" | "running" | "complete" | "failed";
  errorCode: string | null;
  createdAt: string;
  text: string;
};
type FakeRecording = {
  id: string;
  workspaceId: string;
  purpose: string;
  state: "capturing" | "processing" | "ready" | "failed";
  versions: FakeVersion[];
};

class FakeServer {
  readonly recordings = new Map<string, FakeRecording>();
  readonly created: Array<{ workspaceId: string; request: Record<string, unknown> }> = [];
  readonly deletes: string[] = [];
  readonly transcriptRequests: string[] = [];
  /** What the next version hears; null leaves it running until `complete`. */
  heard: string | null = "hello voice";
  /** Fail the next version with this code instead. */
  failNext: string | null = null;
  /** Deletes fail like this until cleared. */
  deleteFails: "offline" | null = null;
  private versionCount = 0;
  private clock = Date.parse("2026-10-25T08:00:00.000Z");

  seed(input: {
    id: string;
    workspaceId?: string;
    state: FakeRecording["state"];
    text?: string;
    failed?: string;
  }) {
    const recording: FakeRecording = {
      id: input.id,
      workspaceId: input.workspaceId ?? "ws-1",
      purpose: "dictation",
      state: input.state,
      versions: [],
    };
    if (input.state !== "capturing") {
      recording.versions.push(
        this.version(input.failed ? null : (input.text ?? null), input.failed),
      );
    }
    this.recordings.set(input.id, recording);
    return recording;
  }

  version(text: string | null, failed?: string | null): FakeVersion {
    this.versionCount += 1;
    this.clock += 1_000;
    return {
      id: `version-${this.versionCount}`,
      state: failed ? "failed" : text === null ? "running" : "complete",
      errorCode: failed ?? null,
      createdAt: new Date(this.clock).toISOString(),
      text: text ?? "",
    };
  }

  /** Hear the newest running version of a recording now. */
  complete(recordingId: string, text: string) {
    const recording = this.recordings.get(recordingId)!;
    const version = recording.versions.at(-1)!;
    version.state = "complete";
    version.text = text;
    recording.state = "ready";
  }

  /** Called by the fake recorder when its capture is stopped. */
  finalize(recordingId: string) {
    const recording = this.recordings.get(recordingId)!;
    const failed = this.failNext;
    this.failNext = null;
    recording.versions.push(this.version(failed ? null : this.heard, failed));
    recording.state = failed ? "failed" : this.heard === null ? "processing" : "ready";
  }

  readonly client: VoiceInputRecordingsClient = {
    createRecording: async (workspaceId, request) => {
      this.created.push({ workspaceId, request: request as Record<string, unknown> });
      const id = request.recordingId ?? `recording-${this.created.length}`;
      this.seed({ id, workspaceId, state: "capturing" });
      return { id } as never;
    },
    createRecordingUploads: async () => ({ uploads: [] }) as never,
    completeRecordingChunks: async () => ({}) as never,
    finalizeRecording: async () => ({}) as never,
    deleteRecording: async (_workspaceId, recordingId) => {
      if (this.deleteFails === "offline") throw new TypeError("Failed to fetch");
      this.deletes.push(recordingId);
      if (!this.recordings.delete(recordingId))
        throw Object.assign(new Error("gone"), { status: 404 });
    },
    listRecordings: async (workspaceId, options) => {
      expect(options?.purpose).toBe("dictation");
      return {
        recordings: [...this.recordings.values()]
          .filter((recording) => recording.workspaceId === workspaceId)
          .map((recording) => ({
            id: recording.id,
            state: recording.state,
            purpose: recording.purpose,
            errorCode: null,
            transcript: recording.versions.at(-1) ?? null,
          })),
        nextBefore: null,
      } as never;
    },
    listRecordingTranscriptVersions: async (_workspaceId, recordingId) => {
      const recording = this.recordings.get(recordingId);
      if (!recording) throw Object.assign(new Error("gone"), { status: 404 });
      return recording.versions.map((version) => ({ ...version })) as never;
    },
    getRecordingTranscript: async (_workspaceId, recordingId, options) => {
      const version = this.recordings
        .get(recordingId)
        ?.versions.find((item) => item.id === options?.versionId);
      return {
        segments: version?.text ? [{ text: version.text }] : [],
        nextAfter: null,
      } as never;
    },
    createRecordingTranscript: async (_workspaceId, recordingId) => {
      this.transcriptRequests.push(recordingId);
      const recording = this.recordings.get(recordingId)!;
      const version = this.version(this.heard);
      recording.versions.push(version);
      recording.state = this.heard === null ? "processing" : "ready";
      return { ...version } as never;
    },
  };
}

function fakePlatform(server: FakeServer, options?: { deny?: boolean }) {
  const recorders: Array<{ options: RecorderOptions; stopped: boolean; discarded: boolean }> = [];
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const platform: RecorderPlatform = {
    supported: true,
    systemAudioSupported: false,
    createStore: () => createMemoryRecordingChunkStore(),
    createRecorder(recorderOptions): Recorder {
      const entry = { options: recorderOptions, stopped: false, discarded: false };
      recorders.push(entry);
      let snapshot: RecorderSnapshot = {
        state: "idle",
        recordingId: null,
        elapsedMilliseconds: 0,
        tracks: [],
        upload: null,
        error: null,
      };
      const status = (id: string) => ({
        recordingId: id,
        created: true,
        pendingChunks: 0,
        pendingBytes: 0,
        uploading: false,
        retryingAfterError: null,
        failed: null,
        finalized: true,
        discarded: false,
      });
      return {
        get snapshot() {
          return snapshot;
        },
        async start() {
          if (options?.deny) {
            snapshot = {
              ...snapshot,
              state: "failed",
              error: { code: "microphone_denied", message: "denied" },
            };
            return;
          }
          const created = await recorderOptions.client.createRecording(
            recorderOptions.workspaceId,
            {
              purpose: recorderOptions.purpose,
              tracks: [{ trackNumber: 0, source: "microphone", label: "Microphone" }],
            } as never,
          );
          snapshot = { ...snapshot, state: "recording", recordingId: created.id };
        },
        pause() {},
        resume() {},
        async stop() {
          entry.stopped = true;
          const id = snapshot.recordingId!;
          snapshot = { ...snapshot, state: "stopped" };
          server.finalize(id);
          return status(id);
        },
        async discard() {
          entry.discarded = true;
          const id = snapshot.recordingId;
          snapshot = { ...snapshot, state: "stopped" };
          if (id) server.recordings.delete(id);
        },
        async rename() {},
        levels: () => ({ 0: 0 }),
        inputStream: () => (snapshot.state === "recording" ? stream : null),
      };
    },
  };
  return { platform, recorders, stream };
}

type HookProps = { value: string; workspaceId: string };

async function renderDurable(
  server: FakeServer,
  platform: RecorderPlatform,
  options: Partial<UseVoiceInputOptions> & { initialValue?: string } = {},
) {
  const draft = { value: options.initialValue ?? "" };
  let clock = Date.parse("2026-10-25T09:00:00.000Z");
  const hook = await renderHook(
    (props: HookProps) =>
      useVoiceInput({
        client: { transcribeAudio: async () => ({ text: "one-shot", languages: [] }) },
        recordings: server.client,
        platform,
        workspaceId: props.workspaceId,
        capability: resumableCapability,
        enabled: true,
        value: props.value,
        setValue: (next) => {
          draft.value = next;
        },
        focusInput: () => undefined,
        pollIntervalMilliseconds: 5,
        now: () => new Date(clock),
        ...options,
      }),
    { value: draft.value, workspaceId: "ws-1" },
  );
  await act(async () => {
    await settle();
  });
  return {
    hook,
    draft,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
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

describe("useVoiceInput: dictations as recordings", () => {
  test("records a private dictation, then takes the server's text into the draft once", async () => {
    const server = new FakeServer();
    const { platform, recorders, stream } = fakePlatform(server);
    const { hook, draft } = await renderDurable(server, platform, { initialValue: "note:" });

    await act(async () => {
      expect(await hook.result.current.start()).toBe(true);
    });
    expect(hook.result.current.status).toBe("recording");
    expect(hook.result.current.stream).toBe(stream);
    expect(hook.result.current.locallySaved).toBe(true);
    expect(recorders[0]?.options.purpose).toBe("dictation");
    expect(recorders[0]?.options.timesliceMilliseconds).toBe(
      VOICE_RECORDING_TIMESLICE_MILLISECONDS,
    );
    expect(recorders[0]?.options.systemAudio).toBeFalsy();
    expect(server.created[0]?.request.purpose).toBe("dictation");
    const id = hook.result.current.recordingId!;

    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    await waitFor(() => hook.result.current.status === "idle");
    expect(draft.value).toBe("note: hello voice");
    // Taking the text deletes the dictation first, so no other tab inserts it again.
    expect(server.deletes).toEqual([id]);
    expect(server.recordings.size).toBe(0);
    await hook.unmount();
  });

  test("waits for a dictation the server is still hearing", async () => {
    const server = new FakeServer();
    server.heard = null;
    const { platform } = fakePlatform(server);
    const { hook, draft } = await renderDurable(server, platform);
    await act(async () => {
      await hook.result.current.start();
    });
    const id = hook.result.current.recordingId!;
    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    await waitFor(() => hook.result.current.status === "transcribing");
    expect(hook.result.current.status).toBe("transcribing");
    expect(draft.value).toBe("");
    server.complete(id, "slow words");
    await waitFor(() => hook.result.current.status === "idle");
    expect(draft.value).toBe("slow words");
    await hook.unmount();
  });

  test("never inserts a dictation another tab already took", async () => {
    const server = new FakeServer();
    server.heard = null;
    const { platform } = fakePlatform(server);
    const { hook, draft } = await renderDurable(server, platform);
    await act(async () => {
      await hook.result.current.start();
    });
    const id = hook.result.current.recordingId!;
    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    server.complete(id, "taken elsewhere");
    // Another tab deleted it between our transcript read and our delete.
    const originalDelete = server.client.deleteRecording;
    server.client.deleteRecording = async (workspaceId, recordingId) => {
      server.recordings.delete(recordingId);
      await originalDelete(workspaceId, recordingId);
    };
    await waitFor(() => hook.result.current.status === "idle");
    expect(draft.value).toBe("");
    await hook.unmount();
  });

  test("offers a dictation an earlier page left, and inserts it only when asked", async () => {
    const server = new FakeServer();
    server.seed({ id: "left-behind", state: "ready", text: "from yesterday" });
    server.seed({ id: "other-tab", state: "capturing" });
    server.seed({ id: "elsewhere", workspaceId: "ws-2", state: "ready", text: "other workspace" });
    const { platform } = fakePlatform(server);
    const { hook, draft } = await renderDurable(server, platform, { initialValue: "draft" });

    await waitFor(() => hook.result.current.status === "transcript-ready");
    expect(hook.result.current.recordingId).toBe("left-behind");
    expect(hook.result.current.savedTranscript).toBe("from yesterday");
    expect(hook.result.current.hasRecoverableRecording).toBe(true);
    expect(draft.value).toBe("draft");

    await act(async () => {
      await hook.result.current.insertSavedTranscript();
      await settle();
    });
    expect(draft.value).toBe("draft from yesterday");
    expect(server.recordings.has("left-behind")).toBe(false);
    // One still being spoken in another tab is that tab's to finish.
    expect(server.recordings.has("other-tab")).toBe(true);
    expect(hook.result.current.status).toBe("idle");
    await hook.unmount();
  });

  test("a failed transcription keeps the dictation, and retry hears it again", async () => {
    const server = new FakeServer();
    server.failNext = "voice_provider";
    const { platform } = fakePlatform(server);
    const { hook, draft } = await renderDurable(server, platform);
    await act(async () => {
      await hook.result.current.start();
    });
    const id = hook.result.current.recordingId!;
    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    await waitFor(() => hook.result.current.status === "error");
    expect(hook.result.current.error).toBe("provider");
    expect(hook.result.current.hasRecoverableRecording).toBe(true);
    expect(server.recordings.has(id)).toBe(true);

    server.heard = "second try";
    await act(async () => {
      hook.result.current.retry();
      await settle();
    });
    await waitFor(() => hook.result.current.status === "idle");
    expect(server.transcriptRequests).toEqual([id]);
    expect(draft.value).toBe("second try");
    await hook.unmount();
  });

  test("Cancel and Escape keep real speech; only an accidental start is thrown away", async () => {
    for (const via of ["cancel", "escape"] as const) {
      const server = new FakeServer();
      const { platform, recorders } = fakePlatform(server);
      const { hook, draft, advance } = await renderDurable(server, platform);
      await act(async () => {
        await hook.result.current.start();
      });
      const id = hook.result.current.recordingId!;
      advance(45_000);
      await act(async () => {
        if (via === "cancel") hook.result.current.cancel();
        else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await settle();
      });
      await waitFor(() => hook.result.current.status === "transcript-ready");
      expect(recorders[0]?.stopped).toBe(true);
      expect(hook.result.current.savedTranscript).toBe("hello voice");
      expect(draft.value).toBe("");
      expect(server.recordings.has(id)).toBe(true);
      await hook.unmount();
    }

    const server = new FakeServer();
    const { platform, recorders } = fakePlatform(server);
    const { hook, advance } = await renderDurable(server, platform);
    await act(async () => {
      await hook.result.current.start();
    });
    // An Escape a dialog already handled leaves dictation alone.
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      event.preventDefault();
      document.dispatchEvent(event);
      await settle();
    });
    expect(hook.result.current.status).toBe("recording");
    advance(1_000);
    await act(async () => {
      hook.result.current.cancel();
      await settle();
    });
    expect(hook.result.current.status).toBe("idle");
    expect(recorders[0]?.discarded).toBe(true);
    expect(server.recordings.size).toBe(0);
    await hook.unmount();
  });

  test("cancel while it is being heard keeps the text to insert later", async () => {
    const server = new FakeServer();
    server.heard = null;
    const { platform } = fakePlatform(server);
    const { hook, draft } = await renderDurable(server, platform);
    await act(async () => {
      await hook.result.current.start();
    });
    const id = hook.result.current.recordingId!;
    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    await act(async () => {
      hook.result.current.cancel();
      await settle();
    });
    expect(hook.result.current.status).toBe("recovered");
    server.complete(id, "kept for later");
    await waitFor(() => hook.result.current.status === "transcript-ready");
    expect(draft.value).toBe("");
    expect(hook.result.current.savedTranscript).toBe("kept for later");
    await act(async () => {
      await hook.result.current.discard();
      await settle();
    });
    expect(server.recordings.has(id)).toBe(false);
    expect(draft.value).toBe("");
    await hook.unmount();
  });

  test("inserts offline and deletes the dictation once the server is back", async () => {
    const server = new FakeServer();
    const { platform } = fakePlatform(server);
    const first = await renderDurable(server, platform);
    await act(async () => {
      await first.hook.result.current.start();
    });
    const id = first.hook.result.current.recordingId!;
    server.deleteFails = "offline";
    await act(async () => {
      first.hook.result.current.stop();
      await settle();
    });
    await waitFor(() => first.hook.result.current.status === "idle");
    expect(first.draft.value).toBe("hello voice");
    expect(server.recordings.has(id)).toBe(true);
    await first.hook.unmount();

    // The next composer finds it, sees its text is already in a draft, and deletes it.
    server.deleteFails = null;
    const second = await renderDurable(server, platform);
    await waitFor(() => !server.recordings.has(id));
    expect(server.recordings.has(id)).toBe(false);
    expect(second.hook.result.current.status).toBe("idle");
    expect(second.draft.value).toBe("");
    await second.hook.unmount();
  });

  test("a new workspace stops capture but keeps the dictation for its own workspace", async () => {
    const server = new FakeServer();
    const { platform, recorders } = fakePlatform(server);
    const { hook, draft } = await renderDurable(server, platform);
    await act(async () => {
      await hook.result.current.start();
    });
    const id = hook.result.current.recordingId!;
    await hook.rerender({ value: "", workspaceId: "ws-2" });
    await act(async () => {
      await settle();
    });
    expect(recorders[0]?.stopped).toBe(true);
    expect(recorders[0]?.discarded).toBe(false);
    expect(hook.result.current.status).toBe("idle");
    expect(server.recordings.has(id)).toBe(true);
    expect(draft.value).toBe("");
    await hook.unmount();
  });

  test("a denied microphone is a plain error with nothing saved", async () => {
    const server = new FakeServer();
    const { platform } = fakePlatform(server, { deny: true });
    const { hook } = await renderDurable(server, platform);
    await act(async () => {
      expect(await hook.result.current.start()).toBe(false);
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("permission_denied");
    expect(hook.result.current.hasRecoverableRecording).toBe(false);
    expect(server.recordings.size).toBe(0);
    await hook.unmount();
  });
});

describe("useVoiceInput: one request", () => {
  test("a client without the recordings API records in memory and sends one request", async () => {
    const { track } = installMediaMocks();
    const calls: unknown[] = [];
    let draft = "";
    const hook = await renderHook(
      (props: { value: string }) =>
        useVoiceInput({
          client: {
            transcribeAudio: async (_workspaceId: string, input: unknown) => {
              calls.push(input);
              return { text: "hello voice", languages: ["en"] };
            },
          },
          workspaceId: "ws-1",
          capability: resumableCapability,
          enabled: true,
          value: props.value,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
        }),
      { value: draft },
    );
    expect(hook.result.current.available).toBe(true);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("recording");
    expect(FakeMediaRecorder.instances[0]?.startTimeslice).toBe(
      VOICE_RECORDING_TIMESLICE_MILLISECONDS,
    );
    expect(hook.result.current.locallySaved).toBe(false);
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

  test("refuses audio above the one-request size without sending it", async () => {
    installMediaMocks();
    let calls = 0;
    const hook = await renderHook(
      () =>
        useVoiceInput({
          client: {
            transcribeAudio: async () => {
              calls += 1;
              return { text: "oversized", languages: [] };
            },
          },
          workspaceId: "ws-1",
          capability: { ...capability, maxSizeBytes: 2 },
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
        }),
      undefined,
    );
    await act(async () => {
      await hook.result.current.start();
    });
    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    expect(calls).toBe(0);
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("too_large");
    await hook.unmount();
  });

  test("permission denial is controlled and a cancelled start stays cancelled", async () => {
    installMediaMocks({ deny: true });
    let draft = "keep";
    const denied = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "nope", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: draft,
          setValue: (value) => {
            draft = value;
          },
          focusInput: () => undefined,
        }),
      undefined,
    );
    await act(async () => {
      expect(await denied.result.current.start()).toBe(false);
    });
    expect(denied.result.current.status).toBe("error");
    expect(denied.result.current.error).toBe("permission_denied");
    expect(draft).toBe("keep");
    await denied.unmount();

    installMediaMocks();
    let grant!: (stream: MediaStream) => void;
    const track = { stop: mock(() => undefined) };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            grant = resolve;
          }),
      },
    });
    const late = await renderHook(
      () =>
        useVoiceInput({
          client: { transcribeAudio: async () => ({ text: "late", languages: [] }) },
          workspaceId: "ws-1",
          capability,
          enabled: true,
          value: "",
          setValue: () => undefined,
          focusInput: () => undefined,
        }),
      undefined,
    );
    let started: Promise<boolean> | null = null;
    await act(async () => {
      started = late.result.current.start();
      await settle();
    });
    expect(late.result.current.status).toBe("requesting-permission");
    await act(async () => {
      late.result.current.cancel();
      grant({ getTracks: () => [track] } as unknown as MediaStream);
      expect(await started!).toBe(false);
    });
    expect(late.result.current.status).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
    await late.unmount();
  });
});

describe("composer dictation", () => {
  test("the mic stop transcribes into the draft and never sends", async () => {
    const server = new FakeServer();
    server.heard = "from mic";
    const { platform } = fakePlatform(server);
    const sends: string[] = [];
    let draft = "";

    function Harness() {
      const [value, setValue] = useState("");
      draft = value;
      return (
        <ChatComposer
          composer={composerState(value, setValue, sends)}
          transcription={{
            client: { transcribeAudio: async () => ({ text: "", languages: [] }) },
            recordings: server.client,
            platform,
            workspaceId: "ws-1",
            capability: resumableCapability,
            workspaceEnabled: true,
          }}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Start voice input']")
        ?.click();
      await settle();
    });
    expect(mounted.container.querySelector("[data-voice-waveform]")).toBeTruthy();
    expect(
      mounted.container.querySelector("[aria-label='Stop without transcribing']"),
    ).toBeTruthy();
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Stop and transcribe']")
        ?.click();
      await settle();
    });
    await waitFor(() => draft === "from mic");
    expect(draft).toBe("from mic");
    expect(sends).toHaveLength(0);
  });

  test("text heard during a send waits until the composer is free", async () => {
    const server = new FakeServer();
    server.heard = null;
    const { platform } = fakePlatform(server);
    let finishSend!: () => void;
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    let draft = "send this";
    const sends: string[] = [];

    function Harness() {
      const [value, setValue] = useState("send this");
      const [sending, setSending] = useState(false);
      draft = value;
      return (
        <ChatComposer
          composer={{
            ...composerState(value, setValue, sends),
            sending,
            send: async () => {
              sends.push(value);
              setSending(true);
              await sendPending;
              setSending(false);
              return true;
            },
          }}
          disabled={sending}
          transcription={{
            client: { transcribeAudio: async () => ({ text: "", languages: [] }) },
            recordings: server.client,
            platform,
            workspaceId: "ws-1",
            capability: resumableCapability,
            workspaceEnabled: true,
          }}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Start voice input']")
        ?.click();
      await settle();
    });
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Stop and transcribe']")
        ?.click();
      await settle();
    });
    await act(async () => {
      mounted?.container.querySelector<HTMLButtonElement>("[aria-label='Send message']")?.click();
      await settle();
    });
    expect(sends).toEqual(["send this"]);
    const id = [...server.recordings.keys()][0]!;
    server.complete(id, "later words");
    await waitFor(() => server.deletes.length > 0, 300);
    expect(draft).toBe("send this");
    expect(server.recordings.has(id)).toBe(true);
    await act(async () => {
      finishSend();
      await sendPending;
      await settle();
    });
    await waitFor(() => draft !== "send this");
    expect(draft).toBe("send this later words");
    expect(server.recordings.has(id)).toBe(false);
  });

  test("an accidental start cancelled at once leaves the draft and sends nothing", async () => {
    const server = new FakeServer();
    const { platform } = fakePlatform(server);
    const sends: string[] = [];
    let draft = "keep me";

    function Harness() {
      const [value, setValue] = useState("keep me");
      draft = value;
      return (
        <ChatComposer
          composer={composerState(value, setValue, sends)}
          transcription={{
            client: { transcribeAudio: async () => ({ text: "", languages: [] }) },
            recordings: server.client,
            platform,
            workspaceId: "ws-1",
            capability: resumableCapability,
            workspaceEnabled: true,
          }}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Start voice input']")
        ?.click();
      await settle();
    });
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>("[aria-label='Stop without transcribing']")
        ?.click();
      await settle();
    });
    expect(draft).toBe("keep me");
    expect(sends).toHaveLength(0);
    expect(server.recordings.size).toBe(0);
    expect(mounted.container.querySelector("[aria-label='Start voice input']")).toBeTruthy();
  });

  test("a start error is dismissible and cleared when live voice takes the mic", async () => {
    installMediaMocks({ deny: true });
    let suppress: (value: boolean) => void = () => undefined;

    function Harness() {
      const [value, setValue] = useState("");
      const [suppressed, setSuppressed] = useState(false);
      suppress = setSuppressed;
      return (
        <ChatComposer
          composer={composerState(value, setValue, [])}
          transcriptionSuppressed={suppressed}
          transcription={{
            client: { transcribeAudio: async () => ({ text: "", languages: [] }) },
            workspaceId: "ws-1",
            capability,
            workspaceEnabled: true,
          }}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    const blocked =
      "[aria-label='Dismiss: Microphone access is blocked. Allow it in site settings, then try again.']";
    const startOnce = async () =>
      await act(async () => {
        mounted?.container.querySelector<HTMLButtonElement>("[data-og-composer-dictate]")?.click();
        await settle();
      });

    await startOnce();
    expect(mounted.container.querySelector(blocked)).toBeTruthy();
    await act(async () => {
      mounted?.container.querySelector<HTMLButtonElement>(blocked)?.click();
      await settle();
    });
    expect(mounted.container.querySelector(blocked)).toBeNull();

    await startOnce();
    expect(mounted.container.querySelector(blocked)).toBeTruthy();
    await act(async () => {
      suppress(true);
      await settle();
    });
    await act(async () => {
      suppress(false);
      await settle();
    });
    expect(mounted.container.querySelector(blocked)).toBeNull();
    expect(mounted.container.querySelector("[aria-label='Start voice input']")).toBeTruthy();
  });
});

test("appendFinalTranscript inserts once with spacing", () => {
  expect(appendFinalTranscript("", "hello")).toBe("hello");
  expect(appendFinalTranscript("hi", "there")).toBe("hi there");
  expect(appendFinalTranscript("hi ", "there")).toBe("hi there");
  expect(appendFinalTranscript("hi", "   ")).toBe("hi");
});
