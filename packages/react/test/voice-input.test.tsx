import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { appendFinalTranscript } from "../src/hooks/use-transcription";
import { useVoiceInput } from "../src/hooks/use-voice-input";
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
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

function installMediaMocks(options?: { deny?: boolean }) {
  FakeMediaRecorder.instances = [];
  const track = { stop: mock(() => undefined) };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: options?.deny
        ? async () => {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
        : async () =>
            ({
              getTracks: () => [track],
            }) as unknown as MediaStream,
    },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  return track;
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
    const track = installMediaMocks();
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
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);
    expect(draft).toBe("hello voice");
    expect(track.stop).toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
    await hook.unmount();
  });

  test("permission denial stays controlled and late responses after cancel are fenced", async () => {
    installMediaMocks({ deny: true });
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
        }),
      undefined,
    );
    await act(async () => {
      await recording.result.current.start();
    });
    await act(async () => {
      recording.result.current.stop();
    });
    await act(async () => {
      recording.result.current.cancel();
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
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(draft).toBe("from mic");
    expect(sends).toHaveLength(0);
  });

  test("composer cancel discards recording without transcription or send", async () => {
    installMediaMocks();
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
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(draft).toBe("keep me");
    expect(calls).toBe(0);
    expect(sends).toHaveLength(0);
    expect(mounted.container.querySelector("[aria-label='Start voice input']")).toBeTruthy();
  });

  test("appendFinalTranscript inserts once with spacing", () => {
    expect(appendFinalTranscript("", "hello")).toBe("hello");
    expect(appendFinalTranscript("hi", "there")).toBe("hi there");
    expect(appendFinalTranscript("hi ", "there")).toBe("hi there");
    expect(appendFinalTranscript("hi", "   ")).toBe("hi");
  });
});
