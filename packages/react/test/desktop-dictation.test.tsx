import { afterEach, describe, expect, test } from "bun:test";
import type {
  DesktopDictation,
  DesktopDictationHistoryEntry,
  DesktopDictationReport,
  DesktopDictationRequest,
  DesktopDictationSettings,
  DesktopDictationStatus,
} from "@opengeni/sdk/desktop-bridge";
import { act } from "react";
import {
  DesktopDictationHost,
  DesktopDictationSettings as DictationSettingsView,
  acceleratorFromKey,
  desktopShortcutLabel,
} from "../src/desktop-dictation";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";
import {
  FakeServer,
  fakePlatform,
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
});

/** The props React holds for a rendered element, to drive a controlled field directly. */
function reactProps<T>(element: Element): T {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, T>)[key]!;
}

const SETTINGS: DesktopDictationSettings = {
  enabled: false,
  profiles: [
    {
      id: "default",
      name: "Any language",
      shortcut: { kind: "modifierChord", modifiers: ["control", "fn"] },
      language: null,
    },
  ],
  output: "paste",
  mode: "toggle",
};

/** The app's side of dictation: what it asks the page, and what the page reports. */
function fakeApp(
  options: {
    settings?: Partial<DesktopDictationSettings>;
    accessibility?: boolean;
    shortcutErrors?: DesktopDictationStatus["shortcutErrors"];
    paste?: DesktopDictationStatus["paste"];
    /** The app keeps dictation off when asked to turn it on, as a host's consent check may. */
    refuseEnable?: boolean;
  } = {},
) {
  const reports: DesktopDictationReport[] = [];
  const updates: Partial<DesktopDictationSettings>[] = [];
  const permissionRequests: string[] = [];
  const history: DesktopDictationHistoryEntry[] = [];
  const again: string[] = [];
  let settings: DesktopDictationSettings = { ...SETTINGS, ...options.settings };
  let listener: ((request: DesktopDictationRequest) => void) | null = null;
  const status = (): DesktopDictationStatus => ({
    settings,
    supported: true,
    platform: "macos",
    modifierPairs: ["command", "option", "control", "shift"],
    modifierChords: true,
    permissions: [{ id: "accessibility", granted: options.accessibility ?? false }],
    shortcutErrors: options.shortcutErrors ?? [],
    paste: options.paste ?? { available: true, blocker: null },
    ready: listener !== null,
  });
  const dictation: DesktopDictation = {
    status: async () => status(),
    update: async (change) => {
      updates.push(change);
      if (options.refuseEnable && change.enabled) return status();
      settings = { ...settings, ...change };
      return status();
    },
    requestPermission: async (id) => {
      permissionRequests.push(id);
    },
    history: async () => history,
    clearHistory: async () => {
      history.splice(0);
    },
    historyAudio: async () => null,
    transcribeAgain: async (id) => {
      again.push(id);
    },
    onRequest: (next) => {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    },
    report: (report) => {
      reports.push(report);
    },
    onChange: () => () => undefined,
  };
  return {
    dictation,
    reports,
    updates,
    permissionRequests,
    history,
    again,
    get listening() {
      return listener !== null;
    },
    send: async (request: DesktopDictationRequest) => {
      await act(async () => {
        listener?.(request);
        await settle();
      });
    },
    phases: (id: string) =>
      reports.filter((report) => report.dictationId === id).map((report) => report.phase),
    last: (id: string) => reports.filter((report) => report.dictationId === id).at(-1),
  };
}

const oneShotClient = { transcribeAudio: async () => ({ text: "one-shot", languages: [] }) };

async function mountHost(
  app: ReturnType<typeof fakeApp>,
  server: FakeServer,
  options: { enabled?: boolean; chunks?: Uint8Array[] } = {},
) {
  const { platform, recorders } = fakePlatform(
    server,
    options.chunks ? { chunks: options.chunks } : undefined,
  );
  mounted = await renderComponent(
    <DesktopDictationHost
      client={oneShotClient}
      workspaceId="ws-1"
      capability={resumableCapability}
      enabled={options.enabled ?? true}
      recordings={server.client}
      platform={platform}
      dictation={app.dictation}
    />,
  );
  await waitFor(() => app.listening);
  return { recorders };
}

describe("DesktopDictationHost", () => {
  test("records for the app's shortcut in its language and reports the text", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    const { recorders } = await mountHost(app, server);
    expect(app.listening).toBe(true);

    await app.send({ kind: "start", dictationId: "d1", profileId: "default", language: "nb" });
    await waitFor(() => app.phases("d1").includes("recording"));
    expect(recorders[0]?.options.purpose).toBe("dictation");
    expect(recorders[0]?.options.transcription).toEqual({ language: "nb" });
    const recording = app.last("d1");
    expect(recording).toMatchObject({ phase: "recording", level: 0 });

    await app.send({ kind: "stop", dictationId: "d1" });
    await waitFor(() => app.phases("d1").includes("done"));
    expect(app.last("d1")).toEqual({ dictationId: "d1", phase: "done", text: "hello voice" });
    // Taking the text deleted the dictation, as the composer does.
    expect(server.recordings.size).toBe(0);
  });

  test("a failed transcription keeps the speech; Retry hears it again", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    server.failNext = "voice_provider";
    await mountHost(app, server);
    await app.send({ kind: "start", dictationId: "d1", profileId: "default", language: null });
    await waitFor(() => app.phases("d1").includes("recording"));
    await app.send({ kind: "stop", dictationId: "d1" });
    await waitFor(() => app.phases("d1").includes("failed"));
    expect(app.last("d1")).toEqual({
      dictationId: "d1",
      phase: "failed",
      message: "Transcription failed. Your speech is saved.",
      retryable: true,
    });

    server.heard = "second try";
    await app.send({ kind: "retry", dictationId: "d1" });
    await waitFor(() => app.phases("d1").includes("done"));
    expect(app.last("d1")).toEqual({ dictationId: "d1", phase: "done", text: "second try" });
  });

  test("Dismiss keeps a failed dictation for the composer, and the next starts fresh", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    server.failNext = "voice_provider";
    await mountHost(app, server);
    await app.send({ kind: "start", dictationId: "d1", profileId: "default", language: null });
    await waitFor(() => app.phases("d1").includes("recording"));
    await app.send({ kind: "stop", dictationId: "d1" });
    await waitFor(() => app.phases("d1").includes("failed"));
    await app.send({ kind: "dismiss", dictationId: "d1" });
    expect(server.recordings.size).toBe(1);
    expect(server.deletes).toEqual([]);

    await app.send({ kind: "start", dictationId: "d2", profileId: "default", language: null });
    await waitFor(() => app.phases("d2").includes("recording"));
    await app.send({ kind: "stop", dictationId: "d2" });
    await waitFor(() => app.phases("d2").includes("done"));
    expect(app.last("d2")).toMatchObject({ phase: "done", text: "hello voice" });
    // The failed one is still there for the composer to offer.
    expect(server.recordings.size).toBe(1);
  });

  test("Cancel right after starting throws the accidental start away", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    await mountHost(app, server);
    await app.send({ kind: "start", dictationId: "d1", profileId: "default", language: null });
    await waitFor(() => app.phases("d1").includes("recording"));
    await app.send({ kind: "cancel", dictationId: "d1" });
    expect(app.last("d1")).toEqual({ dictationId: "d1", phase: "cancelled" });
    await waitFor(() => server.recordings.size === 0);
    expect(server.recordings.size).toBe(0);
    expect(app.phases("d1")).not.toContain("done");
  });

  test("voice input turned off for the workspace fails a start at once", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    await mountHost(app, server, { enabled: false });
    await app.send({ kind: "start", dictationId: "d1", profileId: "default", language: null });
    expect(app.reports).toEqual([
      {
        dictationId: "d1",
        phase: "failed",
        message: "Voice input is off for this workspace.",
        retryable: false,
      },
    ]);
    expect(server.created).toEqual([]);
  });

  test("listens only once the workspace's voice input is read, so a waiting press can start", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    const { platform } = fakePlatform(server);
    let release: () => void = () => undefined;
    const configRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      ...oneShotClient,
      getClientConfig: async () => {
        await configRead;
        return { voiceInput: resumableCapability } as never;
      },
      getWorkspace: async () => ({ settings: {} }) as never,
    };
    mounted = await renderComponent(
      <DesktopDictationHost
        client={client}
        workspaceId="ws-1"
        recordings={server.client}
        platform={platform}
        dictation={app.dictation}
      />,
    );
    await act(async () => {
      await settle();
    });
    expect(app.listening).toBe(false);
    await act(async () => {
      release();
      await settle();
    });
    await waitFor(() => app.listening);
    expect(app.listening).toBe(true);
  });

  test("unmounting while recording stops listening and tells the app", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    await mountHost(app, server);
    await app.send({ kind: "start", dictationId: "d1", profileId: "default", language: null });
    await waitFor(() => app.phases("d1").includes("recording"));
    const current = mounted!;
    mounted = null;
    await current.unmount();
    expect(app.listening).toBe(false);
    expect(app.last("d1")).toMatchObject({ phase: "failed", retryable: false });
  });

  test("hands the app each dictation's speech with its text, with the vocabulary it heard", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    const { recorders } = await mountHost(app, server, {
      chunks: [new Uint8Array([1, 2]), new Uint8Array([3])],
    });
    await app.send({
      kind: "start",
      dictationId: "d1",
      profileId: "default",
      language: "en",
      vocabulary: ["Kubernetes", "Ada Lovelace"],
    });
    await waitFor(() => app.phases("d1").includes("recording"));
    expect(recorders[0]?.options.transcription).toEqual({
      language: "en",
      keyterms: ["Kubernetes", "Ada Lovelace"],
    });
    await app.send({ kind: "stop", dictationId: "d1" });
    await waitFor(() => app.phases("d1").includes("done"));
    const done = app.last("d1");
    expect(done).toMatchObject({ phase: "done", text: "hello voice" });
    const audio = done?.phase === "done" ? done.audio : undefined;
    expect(audio?.mimeType).toBe("audio/webm");
    expect([...(audio?.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  test("transcribes speech the app kept as a new dictation, and reports it as one", async () => {
    const app = fakeApp();
    const server = new FakeServer();
    await mountHost(app, server);
    server.heard = "heard again";
    await app.send({
      kind: "transcribe",
      dictationId: "d2",
      profileId: "default",
      language: "nb",
      vocabulary: ["Vigeland"],
      audio: {
        mimeType: "audio/webm;codecs=opus",
        bytes: new Uint8Array([26, 69, 223, 163, 1]),
        durationMilliseconds: 2_000,
      },
    });
    await waitFor(() => app.phases("d2").includes("done"));
    expect(app.phases("d2")).toEqual(["transcribing", "done"]);
    expect(app.last("d2")).toEqual({ dictationId: "d2", phase: "done", text: "heard again" });
    expect(server.created[0]?.request).toMatchObject({
      purpose: "dictation",
      transcription: { language: "nb", keyterms: ["Vigeland"] },
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm;codecs=opus" }],
    });
    // Taken like any dictation: nothing is left on the server.
    expect(server.recordings.size).toBe(0);
  });
});

describe("DesktopDictationSettings", () => {
  test("turning it on asks for Accessibility, which typing into other apps needs", async () => {
    const app = fakeApp();
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("Dictate from anywhere") ?? false);
    const container = mounted.container;
    expect(container.textContent).toContain(
      "Off. Turn on to dictate into any app with a shortcut.",
    );
    const toggle = container.querySelector<HTMLButtonElement>("button[role=switch]")!;
    await act(async () => {
      toggle.click();
      await settle();
    });
    expect(app.updates).toEqual([{ enabled: true }]);
    expect(app.permissionRequests).toEqual(["accessibility"]);
    await waitFor(() => container.textContent?.includes("How the keys work") ?? false);
    expect(container.textContent).toContain(
      "⌃ Control + Fn starts and finishes dictation in any app.",
    );
    expect(container.textContent).toContain("Detect automatically");
    expect(container.textContent).toContain("Another language");
  });

  test("turned on but kept off by the app, it doesn't ask for Accessibility", async () => {
    const app = fakeApp({ refuseEnable: true });
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("Dictate from anywhere") ?? false);
    const toggle = mounted.container.querySelector<HTMLButtonElement>("button[role=switch]")!;
    await act(async () => {
      toggle.click();
      await settle();
    });
    expect(app.updates).toEqual([{ enabled: true }]);
    expect(app.permissionRequests).toEqual([]);
    expect(mounted.container.textContent).toContain(
      "Off. Turn on to dictate into any app with a shortcut.",
    );
  });

  test("adding a shortcut gives it its own keys and the next language", async () => {
    // The first shortcut has the app's own name until there are two.
    const app = fakeApp({
      settings: { enabled: true, profiles: [{ ...SETTINGS.profiles[0]!, name: "Dictate" }] },
      accessibility: true,
    });
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("Add shortcut") ?? false);
    const add = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add shortcut",
    )!;
    await act(async () => {
      add.click();
      await settle();
    });
    expect(app.updates.at(-1)?.profiles).toEqual([
      SETTINGS.profiles[0]!,
      {
        id: "shortcut-2",
        name: "English",
        shortcut: { kind: "modifierChord", modifiers: ["option", "fn"] },
        language: "en",
      },
    ]);
    expect(mounted.container.textContent).toContain("Allowed");
  });

  test("shows recent dictations to copy again", async () => {
    const app = fakeApp({ settings: { enabled: true } });
    app.history.push({
      id: "d1",
      text: "Remember the milk",
      at: new Date().toISOString(),
      profileName: "Any language",
      language: null,
    });
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("Recent dictations") ?? false);
    expect(mounted.container.textContent).toContain("Remember the milk");
  });

  test("kept speech can be played and transcribed again", async () => {
    const app = fakeApp({ settings: { enabled: true } });
    app.history.push({
      id: "d1",
      text: "Remember the milk",
      at: new Date().toISOString(),
      profileName: "Any language",
      language: null,
      audio: { mimeType: "audio/webm", durationMilliseconds: 1_000 },
    });
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("Recent dictations") ?? false);
    expect(mounted.container.querySelector("button[aria-label=Play]")).not.toBeNull();
    const again = mounted.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Transcribe again']",
    )!;
    await act(async () => {
      again.click();
      await settle();
    });
    expect(app.again).toEqual(["d1"]);
  });

  test("offers the retry and cancel shortcuts and saves the vocabulary", async () => {
    const app = fakeApp({
      settings: { enabled: true, vocabulary: [], retryShortcut: null, cancelShortcut: null },
      accessibility: true,
    });
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("Vocabulary") ?? false);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Retry shortcut");
    expect(text).toContain("Cancel shortcut");
    const field = mounted.container.querySelector<HTMLTextAreaElement>("textarea")!;
    const props = reactProps<{
      onFocus: () => void;
      onChange: (event: unknown) => void;
    }>(field);
    await act(async () => {
      props.onFocus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Kubernetes\nAda  Lovelace, kubernetes\n",
      );
      props.onChange({ target: field });
      await settle();
    });
    await act(async () => {
      // The blur handler of the latest render sees the typed text.
      reactProps<{ onBlur: () => void }>(field).onBlur();
      await settle();
    });
    expect(app.updates).toContainEqual({ vocabulary: ["Kubernetes", "Ada Lovelace"] });
  });

  test("an app without the vocabulary or retry shortcut doesn't offer them", async () => {
    const app = fakeApp({ settings: { enabled: true } });
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("How the keys work") ?? false);
    const text = mounted.container.textContent ?? "";
    expect(text).not.toContain("Vocabulary");
    expect(text).not.toContain("Retry shortcut");
  });

  test("says in the page's words why a shortcut or typing doesn't work", async () => {
    const app = fakeApp({
      settings: { enabled: true },
      shortcutErrors: [{ profileId: "default", problem: "taken" }],
      paste: { available: false, blocker: "xdotool" },
    });
    mounted = await renderComponent(<DictationSettingsView dictation={app.dictation} />);
    await waitFor(() => mounted!.container.textContent?.includes("Shortcut") ?? false);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("That key combination is taken or not allowed. Choose another.");
    expect(text).toContain("Install xdotool so");
  });

  test("renders nothing outside an app that offers dictation", async () => {
    mounted = await renderComponent(<DictationSettingsView dictation={null} />);
    await act(async () => {
      await settle();
    });
    expect(mounted.container.textContent).toBe("");
  });
});

describe("desktop shortcuts", () => {
  test("are named the way each system writes them", () => {
    expect(
      desktopShortcutLabel({ kind: "modifierChord", modifiers: ["control", "fn"] }, "macos"),
    ).toBe("⌃ Control + Fn");
    expect(desktopShortcutLabel({ kind: "modifierPair", modifier: "option" }, "windows")).toBe(
      "Both Alt keys",
    );
    expect(
      desktopShortcutLabel({ kind: "accelerator", accelerator: "Control+Shift+Space" }, "linux"),
    ).toBe("Ctrl+Shift+Space");
    expect(
      desktopShortcutLabel({ kind: "accelerator", accelerator: "Command+Shift+D" }, "macos"),
    ).toBe("⌘⇧D");
  });

  test("a recorded key combination needs a modifier other than Shift", () => {
    const key = (code: string, modifiers: Partial<KeyboardEvent> = {}) => ({
      code,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers,
    });
    expect(acceleratorFromKey(key("Space", { ctrlKey: true, shiftKey: true }), "windows")).toBe(
      "Control+Shift+Space",
    );
    expect(acceleratorFromKey(key("KeyD", { shiftKey: true }), "macos")).toBeNull();
  });
});
