import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

import {
  DESKTOP_IPC,
  type DesktopDictationAudio,
  type DesktopDictationHistoryEntry,
  type DesktopDictationRequest,
  type DesktopDictationSettings,
} from "../src/contract";
import {
  DICTATION_HISTORY_MAX,
  Dictation,
  DictationPasteError,
  DictationSettingsStore,
  defaultDictationSettings,
  mergeDictationSettings,
  parseDictationShortcut,
  type DictationHudAction,
  type DictationHudState,
  type DictationModifierEvents,
  type DictationPlatform,
  type DictationTarget,
} from "../src/main/dictation";
import { parseDictationReport } from "../src/main/dictation/ipc";
import { linuxPasteArguments, linuxPasteTool } from "../src/main/dictation/linux";
import { macKeyWatchArgument, parseKeyLine } from "../src/main/dictation/mac";
import { ENGLISH_DICTATION_WORDS, type DictationWords } from "../src/main/dictation/words";

// Imports are hoisted: the window module loads Electron, so it waits for the mock.
const { hudAction } = await import("../src/main/dictation/hud");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Only the owner may read the file. Windows has no such file mode: there the
 * app's data folder in the person's own profile is what keeps it private.
 */
function expectOnlyThePersonCanRead(path: string) {
  if (process.platform === "win32") return;
  expect(statSync(path).mode & 0o777).toBe(0o600);
}

function harness(
  options: {
    settings?: Partial<DesktopDictationSettings>;
    wake?: boolean;
    platform?: Partial<DictationPlatform>;
    words?: DictationWords;
  } = {},
) {
  let settings: DesktopDictationSettings = {
    ...defaultDictationSettings("darwin"),
    enabled: true,
    ...options.settings,
  };
  const history: DesktopDictationHistoryEntry[] = [];
  const audio = new Map<string, DesktopDictationAudio>();
  const store = {
    read: () => settings,
    write: (next: DesktopDictationSettings) => {
      settings = next;
    },
    history: () => history,
    remember: (entry: DesktopDictationHistoryEntry, speech?: DesktopDictationAudio | null) => {
      if (speech) audio.set(entry.id, speech);
      history.unshift({
        ...entry,
        audio: speech
          ? { mimeType: speech.mimeType, durationMilliseconds: speech.durationMilliseconds }
          : null,
      });
    },
    replaceText: (id: string, text: string) => {
      const entry = history.find((item) => item.id === id);
      if (entry) {
        entry.text = text;
        delete entry.cancelled;
      }
    },
    audio: (id: string) => audio.get(id) ?? null,
    clearHistory: () => {
      history.splice(0);
      audio.clear();
    },
  };
  const shortcuts = new Map<string, () => void>();
  const globalShortcut = {
    register: (accelerator: string, callback: () => void) => {
      if (accelerator === "Control+Alt+T" || shortcuts.has(accelerator)) return false;
      shortcuts.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => {
      shortcuts.delete(accelerator);
    },
  };
  const board = { text: "before", restored: [] as unknown[] };
  const clipboard = {
    readText: async () => board.text,
    writeText: async (text: string) => {
      board.text = text;
    },
    snapshot: async () => ({ text: board.text }),
    restore: async (snapshot: unknown) => {
      board.restored.push(snapshot);
      board.text = (snapshot as { text: string }).text;
    },
  };
  const shown: DictationHudState[] = [];
  let hudListener: (action: DictationHudAction) => void = () => undefined;
  const hud = {
    show: (state: DictationHudState) => {
      shown.push(state);
    },
    onAction: (listener: (action: DictationHudAction) => void) => {
      hudListener = listener;
    },
  };
  const paste = { prepared: 0, pasted: 0, cancelled: 0, fail: null as Error | null };
  let keys: DictationModifierEvents | null = null;
  const platform: DictationPlatform = {
    platform: "macos",
    modifierPairs: ["command", "option", "control", "shift"],
    modifierChords: true,
    permissions: async () => [{ id: "accessibility", granted: true }],
    requestPermission: async () => undefined,
    pasteSupport: async () => ({ available: true, blocker: null }),
    preparePaste: () => {
      paste.prepared += 1;
      return {
        paste: async () => {
          if (paste.fail) throw paste.fail;
          paste.pasted += 1;
        },
        cancel: () => {
          paste.cancelled += 1;
        },
      };
    },
    watchModifiers: async (_watches, events) => {
      keys = events;
      return () => {
        keys = null;
      };
    },
    ...options.platform,
  };
  const sent: DesktopDictationRequest[] = [];
  let destroyed = false;
  const target: DictationTarget = {
    id: 1,
    isDestroyed: () => destroyed,
    send: (channel, request) => {
      expect(channel).toBe(DESKTOP_IPC.dictationRequest);
      sent.push(request as DesktopDictationRequest);
    },
  };
  let woken = 0;
  let revealed = 0;
  let ids = 0;
  const dictation = new Dictation({
    platform,
    store,
    globalShortcut,
    clipboard,
    hud,
    productName: "Opengeni",
    reveal: () => {
      revealed += 1;
    },
    ...(options.wake ? { wake: () => void (woken += 1) } : {}),
    ...(options.words ? { words: () => options.words! } : {}),
    createId: () => `d${++ids}`,
  });
  return {
    dictation,
    target,
    sent,
    shown,
    history,
    board,
    paste,
    shortcuts,
    get keys() {
      if (!keys) throw new Error("not watching");
      return keys;
    },
    get watching() {
      return keys !== null;
    },
    get woken() {
      return woken;
    },
    get revealed() {
      return revealed;
    },
    hudAction: (action: DictationHudAction) => hudListener(action),
    last: () => shown.at(-1),
    destroy: () => {
      destroyed = true;
    },
  };
}

/** A clean press and release of the profile's modifier keys. */
function tap(keys: DictationModifierEvents, id = "default") {
  keys.onDown(id);
  keys.onUp(id, true);
}

describe("dictation", () => {
  test("a clean tap starts, the next finishes, and the text is typed with the clipboard put back", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    expect(h.sent).toEqual([
      { kind: "start", dictationId: "d1", profileId: "default", language: null, vocabulary: [] },
    ]);
    expect(h.last()).toEqual({ kind: "starting", label: null });
    expect(h.shortcuts.has("Escape")).toBe(true);

    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1_000,
      level: 0.4,
    });
    expect(h.last()).toEqual({
      kind: "recording",
      startedAt: 1_000,
      level: 0.4,
      label: null,
      hold: false,
    });

    tap(h.keys);
    expect(h.sent.at(-1)).toEqual({ kind: "stop", dictationId: "d1" });
    expect(h.last()).toEqual({ kind: "transcribing", label: null });
    expect(h.paste.prepared).toBe(1);

    h.dictation.report(h.target, { dictationId: "d1", phase: "done", text: " Hello there " });
    await wait(10);
    expect(h.paste.pasted).toBe(1);
    expect(h.board.text).toBe("Hello there");
    expect(h.history[0]).toMatchObject({ id: "d1", text: "Hello there", profileName: "Dictate" });
    expect(h.last()).toEqual({ kind: "hidden" });
    expect(h.shortcuts.has("Escape")).toBe(false);
    await wait(1_100);
    expect(h.board.restored).toEqual([{ text: "before" }]);
    expect(h.board.text).toBe("before");
    h.dictation.stop();
  });

  test("a release after another key is a key combination, not the shortcut", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    h.keys.onDown("default");
    h.keys.onUp("default", false);
    expect(h.sent).toEqual([]);
    h.dictation.stop();
  });

  test("held: a hold that lasts starts, letting go finishes, another key cancels", async () => {
    const h = harness({ settings: { mode: "hold" } });
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);

    // A quick tap is not a dictation.
    h.keys.onDown("default");
    h.keys.onUp("default", true);
    await wait(200);
    expect(h.sent).toEqual([]);

    h.keys.onDown("default");
    await wait(200);
    expect(h.sent).toEqual([
      { kind: "start", dictationId: "d1", profileId: "default", language: null, vocabulary: [] },
    ]);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1,
      level: null,
    });
    expect(h.last()).toMatchObject({ kind: "recording", hold: true });
    h.keys.onUp("default", true);
    expect(h.sent.at(-1)).toEqual({ kind: "stop", dictationId: "d1" });
    h.dictation.report(h.target, { dictationId: "d1", phase: "cancelled" });

    h.keys.onDown("default");
    await wait(200);
    h.keys.onUp("default", false);
    expect(h.sent.at(-1)).toEqual({ kind: "cancel", dictationId: "d2" });
    expect(h.last()).toEqual({ kind: "hidden" });
    h.dictation.stop();
  });

  test("letting go while the page starts finishes as soon as it records", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    tap(h.keys);
    expect(h.sent).toHaveLength(1);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1,
      level: null,
    });
    expect(h.sent.at(-1)).toEqual({ kind: "stop", dictationId: "d1" });
    h.dictation.stop();
  });

  test("with no page open, the app opens one and starts once it listens", async () => {
    const h = harness({ wake: true });
    h.dictation.start();
    await tick();
    tap(h.keys);
    expect(h.woken).toBe(1);
    expect(h.last()).toEqual({ kind: "starting", label: null });
    expect(h.sent).toEqual([]);
    h.dictation.listen(h.target, true);
    expect(h.sent).toEqual([
      { kind: "start", dictationId: "d1", profileId: "default", language: null, vocabulary: [] },
    ]);
    h.dictation.stop();
  });

  test("without a way to open a page, it says to open the app", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    tap(h.keys);
    expect(h.last()).toEqual({
      kind: "notice",
      tone: "info",
      message: "Open Opengeni and sign in to dictate.",
      actions: ["open", "dismiss"],
    });
    h.hudAction("open");
    expect(h.revealed).toBe(1);
    h.dictation.stop();
  });

  test("an app in another language gives its own words", async () => {
    const words: DictationWords = {
      ...ENGLISH_DICTATION_WORDS,
      signIn: "Åpne {product} og logg inn for å diktere.",
      copied: "Kopiert. {reason}",
      pasteBlocked: {
        ...ENGLISH_DICTATION_WORDS.pasteBlocked,
        accessibility: "Slå på Tilgjengelighet.",
      },
    };
    const h = harness({ words });
    h.dictation.start();
    await tick();
    tap(h.keys);
    expect(h.last()).toMatchObject({ message: "Åpne Opengeni og logg inn for å diktere." });
    h.hudAction("dismiss");
    h.paste.fail = new DictationPasteError("accessibility");
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1,
      level: 0.5,
    });
    tap(h.keys);
    h.dictation.report(h.target, { dictationId: "d1", phase: "done", text: "Hei" });
    await wait(10);
    expect(h.last()).toMatchObject({
      tone: "error",
      message: "Kopiert. Slå på Tilgjengelighet.",
      actions: ["allow", "dismiss"],
    });
    h.dictation.stop();
  });

  test("a failure that kept the speech offers Retry; Dismiss keeps it for the composer", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1,
      level: null,
    });
    tap(h.keys);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "failed",
      message: "Transcription failed. Your speech is saved.",
      retryable: true,
    });
    expect(h.last()).toEqual({
      kind: "notice",
      tone: "error",
      message: "Transcription failed. Your speech is saved.",
      actions: ["retry", "dismiss"],
    });
    expect(h.paste.cancelled).toBe(1);
    h.hudAction("retry");
    expect(h.sent.at(-1)).toEqual({ kind: "retry", dictationId: "d1" });
    expect(h.last()).toEqual({ kind: "transcribing", label: null });
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "failed",
      message: "Again.",
      retryable: true,
    });
    h.hudAction("dismiss");
    expect(h.sent.at(-1)).toEqual({ kind: "dismiss", dictationId: "d1" });
    expect(h.last()).toEqual({ kind: "hidden" });
    h.dictation.stop();
  });

  test("Escape cancels a dictation, and is only taken while one runs", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    expect(h.shortcuts.has("Escape")).toBe(false);
    tap(h.keys);
    h.shortcuts.get("Escape")!();
    expect(h.sent.at(-1)).toEqual({ kind: "cancel", dictationId: "d1" });
    expect(h.shortcuts.has("Escape")).toBe(false);
    h.dictation.stop();
  });

  test("a cancelled dictation's speech is kept in recent dictations, and the retry shortcut types it", async () => {
    const h = harness({
      settings: { retryShortcut: { kind: "accelerator", accelerator: "Control+Shift+2" } },
    });
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.report(h.target, { dictationId: "d1", phase: "recording", startedAt: 1, level: 0 });
    h.shortcuts.get("Escape")!();
    expect(h.sent.at(-1)).toEqual({ kind: "cancel", dictationId: "d1" });
    expect(h.last()).toEqual({ kind: "hidden" });
    const speech = {
      mimeType: "audio/webm",
      bytes: new Uint8Array([1, 2, 3]),
      durationMilliseconds: 6_000,
    };
    // Only the page that recorded it can send its speech back, once.
    const stranger: DictationTarget = { ...h.target, id: 2 };
    h.dictation.report(stranger, { dictationId: "d1", phase: "cancelled", audio: speech });
    expect(h.history).toHaveLength(0);
    h.dictation.report(h.target, { dictationId: "d1", phase: "cancelled", audio: speech });
    h.dictation.report(h.target, { dictationId: "d1", phase: "cancelled", audio: speech });
    expect(h.history).toHaveLength(1);
    expect(h.history[0]).toMatchObject({
      id: "d1",
      text: "",
      cancelled: true,
      audio: { mimeType: "audio/webm", durationMilliseconds: 6_000 },
    });
    expect(h.dictation.historyAudio("d1")).toEqual(speech);
    expect(h.paste.pasted).toBe(0);

    h.shortcuts.get("Control+Shift+2")!();
    expect(h.sent.at(-1)).toMatchObject({ kind: "transcribe", dictationId: "d2", audio: speech });
    h.dictation.report(h.target, { dictationId: "d2", phase: "done", text: "said after all" });
    await wait(10);
    expect(h.history).toHaveLength(1);
    expect(h.history[0]).toMatchObject({ id: "d1", text: "said after all" });
    expect(h.history[0]?.cancelled).toBeUndefined();
    expect(h.board.text).toBe("said after all");
    h.dictation.stop();
  });

  test("a paste the system refused leaves the text copied and offers to allow it", async () => {
    const h = harness();
    h.paste.fail = new DictationPasteError("accessibility");
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1,
      level: null,
    });
    tap(h.keys);
    h.dictation.report(h.target, { dictationId: "d1", phase: "done", text: "Hei" });
    await wait(10);
    expect(h.board.text).toBe("Hei");
    expect(h.last()).toEqual({
      kind: "notice",
      tone: "error",
      message: "Copied. Allow Accessibility so dictation can type into other apps.",
      actions: ["allow", "dismiss"],
    });
    h.dictation.stop();
  });

  test("copy only: the text stays on the clipboard", async () => {
    const h = harness({ settings: { output: "copy" } });
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1,
      level: null,
    });
    tap(h.keys);
    expect(h.paste.prepared).toBe(0);
    h.dictation.report(h.target, { dictationId: "d1", phase: "done", text: "Kept" });
    await wait(10);
    expect(h.board.text).toBe("Kept");
    expect(h.last()).toMatchObject({ kind: "notice", tone: "success", message: "Copied." });
    h.dictation.stop();
  });

  test("nothing heard says so, and types nothing", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "recording",
      startedAt: 1,
      level: null,
    });
    tap(h.keys);
    h.dictation.report(h.target, { dictationId: "d1", phase: "done", text: "  " });
    await wait(10);
    expect(h.paste.pasted).toBe(0);
    expect(h.board.text).toBe("before");
    expect(h.history).toEqual([]);
    expect(h.last()).toMatchObject({ kind: "notice", message: "Didn't catch any speech." });
    h.dictation.stop();
  });

  test("the page closing while recording fails the dictation", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.listen(h.target, false);
    expect(h.last()).toMatchObject({
      kind: "notice",
      tone: "error",
      message: "Dictation stopped because the page closed. Try again.",
    });
    h.dictation.stop();
  });

  test("reports for another dictation or page are ignored", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    const before = h.shown.length;
    h.dictation.report(h.target, { dictationId: "other", phase: "cancelled" });
    const stranger: DictationTarget = { id: 2, isDestroyed: () => false, send: () => undefined };
    h.dictation.report(stranger, { dictationId: "d1", phase: "cancelled" });
    expect(h.shown.length).toBe(before);
    h.dictation.stop();
  });

  test("each profile records in its language, named in the window when there are several", async () => {
    const h = harness({
      settings: {
        profiles: [
          {
            id: "en",
            name: "English",
            shortcut: { kind: "modifierChord", modifiers: ["control", "fn"] },
            language: "en",
          },
          {
            id: "nb",
            name: "Norwegian",
            shortcut: { kind: "accelerator", accelerator: "Control+Shift+Space" },
            language: "nb",
          },
        ],
      },
    });
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    h.shortcuts.get("Control+Shift+Space")!();
    expect(h.sent).toEqual([
      { kind: "start", dictationId: "d1", profileId: "nb", language: "nb", vocabulary: [] },
    ]);
    expect(h.last()).toEqual({ kind: "starting", label: "Norwegian" });
    h.dictation.stop();
  });

  test("a key combination another app holds is reported for its profile", async () => {
    const h = harness({
      settings: {
        profiles: [
          {
            id: "default",
            name: "Dictate",
            shortcut: { kind: "accelerator", accelerator: "Control+Alt+T" },
            language: null,
          },
        ],
      },
    });
    h.dictation.start();
    await tick();
    const status = await h.dictation.status();
    expect(status.shortcutErrors).toEqual([{ profileId: "default", problem: "taken" }]);
    h.dictation.stop();
  });

  test("turning it off releases the shortcuts and ends a dictation", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    await h.dictation.update({ enabled: false });
    expect(h.sent.at(-1)).toEqual({ kind: "cancel", dictationId: "d1" });
    expect(h.watching).toBe(false);
    const status = await h.dictation.status();
    expect(status.settings.enabled).toBe(false);
    expect(status.ready).toBe(true);
  });

  test("a finished dictation keeps its speech, and the retry shortcut transcribes it again and types it", async () => {
    const h = harness({
      settings: {
        vocabulary: ["Kubernetes"],
        retryShortcut: { kind: "accelerator", accelerator: "Control+Shift+2" },
      },
    });
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    expect(h.sent[0]).toMatchObject({ kind: "start", vocabulary: ["Kubernetes"] });
    h.dictation.report(h.target, { dictationId: "d1", phase: "recording", startedAt: 1, level: 0 });
    tap(h.keys);
    const speech = {
      mimeType: "audio/webm",
      bytes: new Uint8Array([1, 2, 3]),
      durationMilliseconds: 900,
    };
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "done",
      text: "Cubernetis",
      audio: speech,
    });
    await wait(10);
    expect(h.history[0]).toMatchObject({ id: "d1", audio: { mimeType: "audio/webm" } });
    expect(h.dictation.historyAudio("d1")).toEqual(speech);

    h.shortcuts.get("Control+Shift+2")!();
    expect(h.sent.at(-1)).toEqual({
      kind: "transcribe",
      dictationId: "d2",
      profileId: "default",
      language: null,
      vocabulary: ["Kubernetes"],
      audio: speech,
    });
    expect(h.last()).toEqual({ kind: "transcribing", label: null });
    expect(h.paste.prepared).toBe(2);
    h.dictation.report(h.target, { dictationId: "d2", phase: "transcribing" });
    h.dictation.report(h.target, { dictationId: "d2", phase: "done", text: "Kubernetes" });
    await wait(10);
    // The kept dictation's text is replaced, not added again, and typed.
    expect(h.history).toHaveLength(1);
    expect(h.history[0]).toMatchObject({ id: "d1", text: "Kubernetes" });
    expect(h.paste.pasted).toBe(2);
    expect(h.board.text).toBe("Kubernetes");
  });

  test("transcribing again from the settings replaces the kept text without typing it", async () => {
    const h = harness();
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    tap(h.keys);
    h.dictation.report(h.target, { dictationId: "d1", phase: "recording", startedAt: 1, level: 0 });
    tap(h.keys);
    const speech = { mimeType: "audio/webm", bytes: new Uint8Array([1]), durationMilliseconds: 1 };
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "done",
      text: "first",
      audio: speech,
    });
    await wait(10);
    const pasted = h.paste.pasted;

    h.dictation.transcribeAgain("d1");
    expect(h.sent.at(-1)).toMatchObject({ kind: "transcribe", dictationId: "d2" });
    h.dictation.report(h.target, { dictationId: "d2", phase: "done", text: "second" });
    await wait(10);
    expect(h.history[0]).toMatchObject({ id: "d1", text: "second" });
    expect(h.paste.pasted).toBe(pasted);
    expect(h.last()).toEqual({ kind: "hidden" });
  });

  test("the retry shortcut retries a failed dictation, says when there's nothing, and cancel throws one away", async () => {
    const h = harness({
      settings: {
        retryShortcut: { kind: "accelerator", accelerator: "Control+Shift+2" },
        cancelShortcut: { kind: "accelerator", accelerator: "Control+Shift+3" },
      },
    });
    h.dictation.start();
    await tick();
    h.dictation.listen(h.target, true);
    h.shortcuts.get("Control+Shift+2")!();
    expect(h.last()).toMatchObject({
      kind: "notice",
      message: ENGLISH_DICTATION_WORDS.nothingToRetry,
    });

    tap(h.keys);
    h.dictation.report(h.target, { dictationId: "d1", phase: "recording", startedAt: 1, level: 0 });
    tap(h.keys);
    h.dictation.report(h.target, {
      dictationId: "d1",
      phase: "failed",
      message: "Transcription failed.",
      retryable: true,
    });
    h.shortcuts.get("Control+Shift+2")!();
    expect(h.sent.at(-1)).toEqual({ kind: "retry", dictationId: "d1" });
    expect(h.last()).toEqual({ kind: "transcribing", label: null });

    h.shortcuts.get("Control+Shift+3")!();
    expect(h.sent.at(-1)).toEqual({ kind: "cancel", dictationId: "d1" });
    expect(h.last()).toEqual({ kind: "hidden" });
  });

  test("a retry or cancel shortcut another app holds is reported", async () => {
    const h = harness({
      settings: { cancelShortcut: { kind: "accelerator", accelerator: "Control+Alt+T" } },
    });
    h.dictation.start();
    await tick();
    const status = await h.dictation.status();
    expect(status.actionShortcutErrors).toEqual([{ action: "cancel", problem: "taken" }]);
    await h.dictation.update({ enabled: false });
    expect(h.shortcuts.size).toBe(0);
  });
});

describe("dictation settings", () => {
  test("are off by default: Control and Fn on a Mac, a key combination elsewhere", () => {
    expect(defaultDictationSettings("darwin")).toEqual({
      enabled: false,
      profiles: [
        {
          id: "default",
          name: "Dictate",
          shortcut: { kind: "modifierChord", modifiers: ["control", "fn"] },
          language: null,
        },
      ],
      output: "paste",
      mode: "toggle",
      vocabulary: [],
      retryShortcut: null,
      cancelShortcut: null,
    });
    expect(defaultDictationSettings("win32").profiles[0]!.shortcut.kind).toBe("accelerator");
  });

  test("an app may give the first shortcut its language; anything else detects", () => {
    expect(defaultDictationSettings("darwin", "nb").profiles[0]!.language).toBe("nb");
    expect(defaultDictationSettings("linux", "not a code").profiles[0]!.language).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "dictation-test-"));
    try {
      const store = new DictationSettingsStore(dir, "darwin", "nb");
      expect(store.read().profiles[0]!.language).toBe("nb");
      // The person's choice wins once saved.
      const chosen = store.read();
      store.write({ ...chosen, profiles: [{ ...chosen.profiles[0]!, language: null }] });
      expect(new DictationSettingsStore(dir, "darwin", "nb").read().profiles[0]!.language).toBe(
        null,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an app that learns its language later gives the first shortcut that language", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-test-"));
    try {
      let appLanguage: string | null = null;
      const store = new DictationSettingsStore(dir, "darwin", () => appLanguage);
      expect(store.read().profiles[0]!.language).toBeNull();
      // Signing in tells the app its language; nothing was saved yet, so the default follows.
      appLanguage = "nb";
      expect(store.read().profiles[0]!.language).toBe("nb");
      // Once saved, the language stays, whatever the app says next.
      store.write({ ...store.read(), enabled: true });
      appLanguage = "en";
      expect(store.read().profiles[0]!.language).toBe("nb");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shortcuts: chords need two known keys", () => {
    expect(parseDictationShortcut({ kind: "modifierChord", modifiers: ["fn", "control"] })).toEqual(
      {
        kind: "modifierChord",
        modifiers: ["control", "fn"],
      },
    );
    expect(parseDictationShortcut({ kind: "modifierChord", modifiers: ["fn"] })).toBeNull();
    expect(
      parseDictationShortcut({ kind: "modifierChord", modifiers: ["fn", "hyper"] }),
    ).toBeNull();
    expect(parseDictationShortcut({ kind: "modifierPair", modifier: "option" })).toEqual({
      kind: "modifierPair",
      modifier: "option",
    });
  });

  test("a change with two profiles on the same keys, or none, keeps the profiles", () => {
    const current = defaultDictationSettings("darwin");
    const profile = current.profiles[0]!;
    expect(
      mergeDictationSettings(current, { profiles: [profile, { ...profile, id: "second" }] }),
    ).toEqual(current);
    expect(mergeDictationSettings(current, { profiles: [] })).toEqual(current);
    expect(mergeDictationSettings(current, { output: "fax", mode: "hold" })).toEqual({
      ...current,
      mode: "hold",
    });
    const english = {
      id: "en",
      name: "English",
      shortcut: { kind: "accelerator", accelerator: "Control+Alt+Space" },
      language: "en",
    };
    expect(mergeDictationSettings(current, { profiles: [profile, english] }).profiles).toHaveLength(
      2,
    );
    expect(
      mergeDictationSettings(current, { profiles: [{ ...english, language: "not a code" }] }),
    ).toEqual(current);
  });

  test("vocabulary is trimmed, without repeats, and within the limits", () => {
    const current = defaultDictationSettings("darwin");
    const merged = mergeDictationSettings(current, {
      vocabulary: [" Ada  Lovelace ", "ada lovelace", "", 7, "x".repeat(51), "Kubernetes"],
    });
    expect(merged.vocabulary).toEqual(["Ada Lovelace", "Kubernetes"]);
    const many = Array.from({ length: 150 }, (_, index) => `term ${index}`);
    expect(mergeDictationSettings(current, { vocabulary: many }).vocabulary).toHaveLength(100);
    expect(mergeDictationSettings(merged, { vocabulary: "nope" }).vocabulary).toEqual(
      merged.vocabulary,
    );
  });

  test("retry and cancel take key combinations no other shortcut uses", () => {
    const current = {
      ...defaultDictationSettings("win32"),
      retryShortcut: { kind: "accelerator" as const, accelerator: "Control+Shift+2" },
    };
    // Not the dictation shortcut's keys, nor each other's, nor modifier keys alone.
    expect(
      mergeDictationSettings(current, {
        cancelShortcut: { kind: "accelerator", accelerator: "Control+Shift+Space" },
      }).cancelShortcut,
    ).toBeNull();
    expect(
      mergeDictationSettings(current, {
        cancelShortcut: { kind: "accelerator", accelerator: "Control+Shift+2" },
      }).cancelShortcut,
    ).toBeNull();
    expect(
      mergeDictationSettings(current, {
        cancelShortcut: { kind: "modifierPair", modifier: "option" },
      }).cancelShortcut,
    ).toBeNull();
    const both = mergeDictationSettings(current, {
      cancelShortcut: { kind: "accelerator", accelerator: "Control+Shift+3" },
    });
    expect(both.cancelShortcut).toEqual({ kind: "accelerator", accelerator: "Control+Shift+3" });
    expect(mergeDictationSettings(both, { retryShortcut: null }).retryShortcut).toBeNull();
    // A dictation shortcut moved onto retry's keys wins.
    const moved = mergeDictationSettings(both, {
      profiles: [
        {
          ...both.profiles[0]!,
          shortcut: { kind: "accelerator", accelerator: "Control+Shift+2" },
        },
      ],
    });
    expect(moved.retryShortcut).toBeNull();
    expect(moved.cancelShortcut).toEqual(both.cancelShortcut);
  });

  test("keeps each recent dictation's speech beside it, and deletes it with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-test-"));
    try {
      const store = new DictationSettingsStore(dir, "darwin");
      const speech = (byte: number) => ({
        mimeType: "audio/webm;codecs=opus",
        bytes: new Uint8Array([byte, byte]),
        durationMilliseconds: 1_200,
      });
      for (let index = 0; index < DICTATION_HISTORY_MAX + 2; index += 1) {
        store.remember(
          {
            id: `d${index}`,
            text: `text ${index}`,
            at: new Date(index).toISOString(),
            profileName: "Dictate",
            language: null,
          },
          speech(index),
        );
      }
      const newest = `d${DICTATION_HISTORY_MAX + 1}`;
      expect(store.history()[0]).toMatchObject({
        id: newest,
        audio: { mimeType: "audio/webm;codecs=opus", durationMilliseconds: 1_200 },
      });
      expect(store.audio(newest)).toEqual({
        ...speech(DICTATION_HISTORY_MAX + 1),
        bytes: new Uint8Array([DICTATION_HISTORY_MAX + 1, DICTATION_HISTORY_MAX + 1]),
      });
      // Speech goes when its dictation is no longer kept.
      expect(store.audio("d0")).toBeNull();
      expect(readdirSync(join(dir, "dictation-audio"))).toHaveLength(DICTATION_HISTORY_MAX);
      expectOnlyThePersonCanRead(join(dir, "dictation-audio", `${newest}.audio`));

      store.replaceText(newest, "better text");
      expect(store.history()[0]).toMatchObject({ id: newest, text: "better text" });

      // A cancelled dictation is kept for its speech only, until it is transcribed again.
      const cancelled = {
        id: "c1",
        text: "",
        at: new Date().toISOString(),
        profileName: "Dictate",
        language: null,
        cancelled: true,
      };
      store.remember({ ...cancelled, id: "c0" });
      expect(store.history()[0]?.id).toBe(newest);
      store.remember(cancelled, speech(7));
      expect(store.history()[0]).toMatchObject({ id: "c1", text: "", cancelled: true });
      store.replaceText("c1", "said after all");
      expect(store.history()[0]).toMatchObject({ id: "c1", text: "said after all" });
      expect(store.history()[0]?.cancelled).toBeUndefined();
      store.clearHistory();
      expect(readdirSync(join(dir, "dictation-audio"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("are kept in the app's data folder, readable only by the person, with recent dictations", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-test-"));
    try {
      const store = new DictationSettingsStore(dir, "darwin");
      expect(store.read()).toEqual(defaultDictationSettings("darwin"));
      store.write({ ...defaultDictationSettings("darwin"), enabled: true });
      for (let index = 0; index < DICTATION_HISTORY_MAX + 5; index += 1) {
        store.remember({
          id: `d${index}`,
          text: `text ${index}`,
          at: new Date(index).toISOString(),
          profileName: "Dictate",
          language: null,
        });
      }
      const again = new DictationSettingsStore(dir, "darwin");
      expect(again.read().enabled).toBe(true);
      expect(again.history()).toHaveLength(DICTATION_HISTORY_MAX);
      expect(again.history()[0]!.id).toBe(`d${DICTATION_HISTORY_MAX + 4}`);
      expectOnlyThePersonCanRead(join(dir, "dictation.json"));
      again.clearHistory();
      expect(again.history()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dictation platforms", () => {
  test("the Mac key watcher gets each shortcut's flag masks and reports clean and dirty releases", () => {
    expect(
      JSON.parse(
        macKeyWatchArgument([
          { id: "a", shortcut: { kind: "modifierChord", modifiers: ["control", "fn"] } },
          { id: "b", shortcut: { kind: "modifierPair", modifier: "option" } },
        ]),
      ),
    ).toEqual([
      { id: "a", chord: 0x40000 | 0x800000 },
      { id: "b", pair: [0x20, 0x40] },
    ]);
    expect(parseKeyLine("ready")).toEqual({ kind: "ready" });
    expect(parseKeyLine("down a\n")).toEqual({ kind: "down", id: "a" });
    expect(parseKeyLine("up a clean")).toEqual({ kind: "up", id: "a", clean: true });
    expect(parseKeyLine("up a dirty")).toEqual({ kind: "up", id: "a", clean: false });
    expect(parseKeyLine("noise")).toBeNull();
  });

  test("Linux types with xdotool on X11 and wtype or ydotool on Wayland, or only copies", () => {
    const found = (names: string[]) => (name: string) =>
      names.includes(name) ? `/usr/bin/${name}` : null;
    expect(linuxPasteTool({ XDG_SESSION_TYPE: "x11" }, found(["xdotool"]))).toEqual({
      tool: "xdotool",
      path: "/usr/bin/xdotool",
    });
    expect(linuxPasteTool({ WAYLAND_DISPLAY: "wayland-0" }, found(["ydotool"]))).toEqual({
      tool: "ydotool",
      path: "/usr/bin/ydotool",
    });
    expect(linuxPasteTool({ XDG_SESSION_TYPE: "x11" }, found([]))).toEqual({
      tool: null,
      blocker: "xdotool",
    });
    expect(linuxPasteTool({ WAYLAND_DISPLAY: "wayland-0" }, found([]))).toEqual({
      tool: null,
      blocker: "wtype",
    });
    expect(linuxPasteArguments("xdotool")).toEqual(["key", "--clearmodifiers", "ctrl+v"]);
  });

  test("a page's report is checked before the app acts on it", () => {
    expect(
      parseDictationReport({ dictationId: "d1", phase: "recording", startedAt: 5, level: 3 }),
    ).toEqual({ dictationId: "d1", phase: "recording", startedAt: 5, level: 1 });
    expect(parseDictationReport({ dictationId: "d1", phase: "done", text: 4 })).toBeNull();
    expect(parseDictationReport({ dictationId: "d1", phase: "failed", message: " " })).toEqual({
      dictationId: "d1",
      phase: "failed",
      message: "Dictation failed.",
      retryable: false,
    });
    expect(parseDictationReport({ phase: "cancelled" })).toBeNull();
    expect(
      parseDictationReport({
        dictationId: "d1",
        phase: "cancelled",
        audio: { mimeType: "audio/webm", bytes: new Uint8Array([4]), durationMilliseconds: 3_000 },
      }),
    ).toEqual({
      dictationId: "d1",
      phase: "cancelled",
      audio: { mimeType: "audio/webm", bytes: new Uint8Array([4]), durationMilliseconds: 3_000 },
    });
    expect(parseDictationReport({ dictationId: "d1", phase: "cancelled", audio: "x" })).toEqual({
      dictationId: "d1",
      phase: "cancelled",
    });
    expect(parseDictationReport({ dictationId: "d1", phase: "elsewhere" })).toBeNull();
    // Speech comes with the text when it is audio; anything else is dropped, not the text.
    const bytes = new Uint8Array([1, 2]);
    expect(
      parseDictationReport({
        dictationId: "d1",
        phase: "done",
        text: "hi",
        audio: { mimeType: "audio/webm;codecs=opus", bytes, durationMilliseconds: 12.4 },
      }),
    ).toEqual({
      dictationId: "d1",
      phase: "done",
      text: "hi",
      audio: { mimeType: "audio/webm;codecs=opus", bytes, durationMilliseconds: 12 },
    });
    expect(
      parseDictationReport({
        dictationId: "d1",
        phase: "done",
        text: "hi",
        audio: { mimeType: "text/html", bytes, durationMilliseconds: 1 },
      }),
    ).toEqual({ dictationId: "d1", phase: "done", text: "hi" });
  });

  test("the window's buttons name an action", () => {
    expect(hudAction("data:text/html,x#retry/123")).toBe("retry");
    expect(hudAction("data:text/html,x#nothing/1")).toBeNull();
    expect(hudAction("data:text/html,x")).toBeNull();
  });
});
