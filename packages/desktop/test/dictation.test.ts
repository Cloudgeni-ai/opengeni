import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

import {
  DESKTOP_IPC,
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
  const store = {
    read: () => settings,
    write: (next: DesktopDictationSettings) => {
      settings = next;
    },
    history: () => history,
    remember: (entry: DesktopDictationHistoryEntry) => {
      history.unshift(entry);
    },
    clearHistory: () => {
      history.splice(0);
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
      { kind: "start", dictationId: "d1", profileId: "default", language: null },
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
      { kind: "start", dictationId: "d1", profileId: "default", language: null },
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
      { kind: "start", dictationId: "d1", profileId: "default", language: null },
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
    expect(h.sent).toEqual([{ kind: "start", dictationId: "d1", profileId: "nb", language: "nb" }]);
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
      expect(statSync(join(dir, "dictation.json")).mode & 0o777).toBe(0o600);
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
    expect(parseDictationReport({ dictationId: "d1", phase: "elsewhere" })).toBeNull();
  });

  test("the window's buttons name an action", () => {
    expect(hudAction("data:text/html,x#retry/123")).toBe("retry");
    expect(hudAction("data:text/html,x#nothing/1")).toBeNull();
    expect(hudAction("data:text/html,x")).toBeNull();
  });
});
