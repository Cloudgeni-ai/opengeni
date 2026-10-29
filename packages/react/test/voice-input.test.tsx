import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createMemoryRecordingChunkStore,
  RecordingUploader,
  type RecorderPlatform,
} from "@opengeni/sdk/recordings";
import { act, useState } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { appendFinalTranscript } from "../src/hooks/use-transcription";
import {
  VOICE_RECORDING_TIMESLICE_MILLISECONDS,
  useVoiceInput,
  type UseVoiceInputOptions,
} from "../src/hooks/use-voice-input";
import type { ComposerState } from "../src/hooks/use-composer";
import { registerDom, renderComponent, renderHook, type RenderedComponent } from "./render-hook";
import {
  FakeMediaRecorder,
  FakeServer,
  capability,
  fakePlatform,
  installMediaMocks,
  resumableCapability,
  settle,
  waitFor,
} from "./voice-input-fakes";

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
    // No language named: the provider detects it.
    expect(recorders[0]?.options.transcription).toBeUndefined();
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

  test("a dictation is heard in the language it was started in", async () => {
    const server = new FakeServer();
    const { platform, recorders } = fakePlatform(server);
    const { hook } = await renderDurable(server, platform, { language: "nb" });
    await act(async () => {
      expect(await hook.result.current.start()).toBe(true);
    });
    expect(recorders[0]?.options.transcription).toEqual({ language: "nb" });
    await act(async () => {
      hook.result.current.cancel();
      await settle();
    });
    await hook.unmount();
  });

  test("a host check before the microphone can keep it off", async () => {
    const server = new FakeServer();
    const { platform, recorders } = fakePlatform(server);
    const answers = [false, true];
    const asked: number[] = [];
    const { hook } = await renderDurable(server, platform, {
      beforeStart: async () => {
        asked.push(asked.length);
        return answers.shift() ?? false;
      },
    });
    await act(async () => {
      expect(await hook.result.current.start()).toBe(false);
    });
    expect(recorders).toHaveLength(0);
    expect(hook.result.current.status).toBe("idle");
    await act(async () => {
      expect(await hook.result.current.start()).toBe(true);
    });
    expect(asked).toEqual([0, 1]);
    expect(recorders).toHaveLength(1);
    expect(hook.result.current.status).toBe("recording");
    await act(async () => {
      hook.result.current.cancel();
      await settle();
    });
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

  test("a host that dictates elsewhere leaves saved dictations for the composer", async () => {
    const server = new FakeServer();
    server.seed({ id: "left-behind", state: "ready", text: "from yesterday" });
    const { platform } = fakePlatform(server);
    const { hook } = await renderDurable(server, platform, { recover: false });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await settle();
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.savedTranscript).toBeNull();
    expect(server.recordings.has("left-behind")).toBe(true);
    await hook.unmount();
  });

  test("release lets go of a held dictation without deleting it", async () => {
    const server = new FakeServer();
    server.failNext = "voice_provider";
    const { platform } = fakePlatform(server);
    const { hook } = await renderDurable(server, platform, { recover: false });
    await act(async () => {
      await hook.result.current.start();
    });
    const id = hook.result.current.recordingId!;
    await act(async () => {
      hook.result.current.stop();
      await settle();
    });
    await waitFor(() => hook.result.current.status === "error");
    expect(hook.result.current.hasRecoverableRecording).toBe(true);

    await act(async () => {
      hook.result.current.release();
      await settle();
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.hasRecoverableRecording).toBe(false);
    // Still saved: the composer offers it.
    expect(server.recordings.has(id)).toBe(true);
    expect(server.deletes).toEqual([]);
    // A new dictation can start straight away.
    await act(async () => {
      expect(await hook.result.current.start()).toBe(true);
    });
    await hook.unmount();
  });

  test("finishes uploading a dictation a closed page left on this device, then offers it", async () => {
    const server = new FakeServer();
    server.heard = "left mid-sentence";
    const store = createMemoryRecordingChunkStore();
    // A page started a dictation, saved a chunk, and was closed before it stopped.
    const crashed = new RecordingUploader({ client: server.client, store });
    await crashed.begin({
      workspaceId: "ws-1",
      recordingId: "crashed",
      create: {
        recordingId: "crashed",
        purpose: "dictation",
        tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
      },
    } as never);
    await crashed.addChunk({
      recordingId: "crashed",
      trackNumber: 0,
      chunkNumber: 0,
      bytes: new Uint8Array([1, 2, 3]),
      sha256: "00",
      startMilliseconds: 0,
      durationMilliseconds: 1_000,
    });
    crashed.dispose();
    await waitFor(() => server.recordings.has("crashed"));
    expect(server.recordings.get("crashed")?.state).toBe("capturing");

    const { platform } = fakePlatform(server, { store });
    const { hook, draft } = await renderDurable(server, platform);
    await waitFor(() => hook.result.current.status === "transcript-ready");
    expect(hook.result.current.recordingId).toBe("crashed");
    expect(hook.result.current.savedTranscript).toBe("left mid-sentence");
    expect(draft.value).toBe("");
    await act(async () => {
      await hook.result.current.insertSavedTranscript();
      await settle();
    });
    expect(draft.value).toBe("left mid-sentence");
    expect(server.recordings.has("crashed")).toBe(false);
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

  test("Cancel and Escape delete the dictation, so nothing offers it again", async () => {
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
      expect(hook.result.current.status).toBe("idle");
      expect(hook.result.current.hasRecoverableRecording).toBe(false);
      expect(recorders[0]?.discarded).toBe(true);
      expect(server.recordings.has(id)).toBe(false);
      expect(draft.value).toBe("");
      await hook.unmount();
    }

    const server = new FakeServer();
    const { platform, recorders } = fakePlatform(server);
    const { hook } = await renderDurable(server, platform);
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
    expect(recorders[0]?.discarded).toBe(false);
    await hook.unmount();
  });

  test("setting a dictation aside keeps real speech; only an accidental start is thrown away", async () => {
    const server = new FakeServer();
    const { platform, recorders } = fakePlatform(server);
    const { hook, draft, advance } = await renderDurable(server, platform);
    await act(async () => {
      await hook.result.current.start();
    });
    const id = hook.result.current.recordingId!;
    advance(45_000);
    await act(async () => {
      hook.result.current.setAside();
      await settle();
    });
    await waitFor(() => hook.result.current.status === "transcript-ready");
    expect(recorders[0]?.stopped).toBe(true);
    expect(hook.result.current.savedTranscript).toBe("hello voice");
    expect(draft.value).toBe("");
    expect(server.recordings.has(id)).toBe(true);
    await hook.unmount();

    const quick = new FakeServer();
    const second = fakePlatform(quick);
    const accidental = await renderDurable(quick, second.platform);
    await act(async () => {
      await accidental.hook.result.current.start();
    });
    accidental.advance(1_000);
    await act(async () => {
      accidental.hook.result.current.setAside();
      await settle();
    });
    expect(accidental.hook.result.current.status).toBe("idle");
    expect(second.recorders[0]?.discarded).toBe(true);
    expect(quick.recordings.size).toBe(0);
    await accidental.hook.unmount();
  });

  test("cancel while it is being heard deletes it; an offered one only stops retrying", async () => {
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
    await act(async () => {
      hook.result.current.cancel();
      await settle();
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.hasRecoverableRecording).toBe(false);
    expect(server.recordings.has(id)).toBe(false);
    expect(draft.value).toBe("");
    await hook.unmount();

    // A dictation an earlier page left, offered here and still being heard.
    const left = new FakeServer();
    left.heard = null;
    const leftId = left.seed({ id: "left-behind", state: "processing" }).id;
    const offered = await renderDurable(left, fakePlatform(left).platform);
    await waitFor(() => offered.hook.result.current.status === "retrying");
    await act(async () => {
      offered.hook.result.current.cancel();
      await settle();
    });
    expect(offered.hook.result.current.status).toBe("recovered");
    expect(offered.hook.result.current.hasRecoverableRecording).toBe(true);
    expect(left.recordings.has(leftId)).toBe(true);
    await offered.hook.unmount();
  });

  test("a host that keeps speech gets a cancelled dictation's copy before it is deleted", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    for (const when of ["recording", "transcribing"] as const) {
      const server = new FakeServer();
      server.heard = null;
      const { platform } = fakePlatform(server, { chunks, elapsedMilliseconds: 6_000 });
      const copies: Array<{ bytes: number[]; cancelled: boolean; durationMilliseconds: number }> =
        [];
      const { hook } = await renderDurable(server, platform, {
        onAudio: (copy) => {
          void copy.audio.arrayBuffer().then((buffer) =>
            copies.push({
              bytes: [...new Uint8Array(buffer)],
              cancelled: copy.cancelled === true,
              durationMilliseconds: copy.durationMilliseconds,
            }),
          );
        },
      });
      await act(async () => {
        await hook.result.current.start();
      });
      const id = hook.result.current.recordingId!;
      if (when === "transcribing") {
        await act(async () => {
          hook.result.current.stop();
          await settle();
        });
        await waitFor(() => hook.result.current.status === "transcribing");
      }
      await act(async () => {
        hook.result.current.cancel();
        await settle();
      });
      await waitFor(() => copies.some((copy) => copy.cancelled));
      expect(copies.at(-1)).toEqual({
        bytes: [1, 2, 3],
        cancelled: true,
        durationMilliseconds: 6_000,
      });
      expect(hook.result.current.status).toBe("idle");
      expect(server.recordings.has(id)).toBe(false);
      await hook.unmount();
    }

    // An accidental start leaves nothing to keep.
    const server = new FakeServer();
    const { platform } = fakePlatform(server, { chunks });
    let given = 0;
    const { hook } = await renderDurable(server, platform, { onAudio: () => (given += 1) });
    await act(async () => {
      await hook.result.current.start();
    });
    await act(async () => {
      hook.result.current.cancel();
      await settle();
    });
    expect(given).toBe(0);
    expect(server.recordings.size).toBe(0);
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
          language: "en",
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
    expect(calls[0]).toMatchObject({ language: "en" });
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
    expect(mounted.container.querySelector("[aria-label='Discard dictation']")).toBeTruthy();
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
        .querySelector<HTMLButtonElement>("[aria-label='Discard dictation']")
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
