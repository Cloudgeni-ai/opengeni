import { describe, expect, mock, test } from "bun:test";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

const { dictationShortcutWords, recordedWords, trayGlyphStyle, trayMenu } =
  await import("../src/main/tray");
const { trayGlyphBitmap, TRANSCRIBING_FRAMES } = await import("../src/main/tray-icons");
type DictationMenu = NonNullable<Parameters<typeof trayMenu>[3]>;
type Summary = Parameters<typeof trayMenu>[0];
type Meeting = NonNullable<Parameters<typeof trayMenu>[5]>;

function menu(summary: Partial<Summary>) {
  const opened: string[] = [];
  const actions = {
    open: () => opened.push("open"),
    pause: () => opened.push("pause"),
    resume: () => opened.push("resume"),
    allow: (permission: string) => opened.push(permission),
    quit: () => opened.push("quit"),
  };
  const result = trayMenu(
    { installed: true, connected: true, running: true, ...summary },
    "Product",
    actions,
  );
  const labels = result.template.map((item) => item.label).filter(Boolean);
  const click = (label: string) => {
    const item = result.template.find((entry) => entry.label === label);
    (item?.click as (() => void) | undefined)?.();
    return opened;
  };
  return { ...result, labels, click };
}

describe("menu bar status of this computer", () => {
  test("a refused sign-in says it needs reconnecting, with one way to do it", () => {
    const refused = menu({ reconnecting: true, needsReconnect: true });
    expect(refused.labels[0]).toBe("This computer: needs reconnecting");
    expect(refused.toolTip).toBe("Product: this computer needs reconnecting");
    expect(refused.labels).not.toContain("This computer: connecting…");
    expect(refused.labels).toContain("Reconnect This Computer…");
    expect(refused.click("Reconnect This Computer…")).toEqual(["open"]);
  });

  test("still starting up is connecting, with nothing to do", () => {
    const starting = menu({ reconnecting: true });
    expect(starting.labels[0]).toBe("This computer: connecting…");
    expect(starting.toolTip).toBe("Product: connecting this computer…");
    expect(starting.labels).not.toContain("Reconnect This Computer…");
  });

  test("available, paused and missing permissions read as before", () => {
    expect(menu({}).labels[0]).toBe("This computer: available to agents");
    const paused = menu({ running: false, needsReconnect: false });
    expect(paused.labels[0]).toBe("This computer: paused");
    expect(paused.labels).toContain("Resume This Computer");
    const missing = menu({ missingPermissions: ["accessibility"] });
    expect(missing.labels[0]).toBe("This computer: screen control needs permission");
    expect(missing.labels).toContain("Allow Accessibility…");
  });

  test("a computer that isn't connected only offers the window and quitting", () => {
    const none = menu({ connected: false, running: false });
    expect(none.labels).toEqual(["Open Product", "Quit Product"]);
    expect(none.toolTip).toBe("Product");
  });
});

describe("dictation in the menu bar", () => {
  const profile = (
    id: string,
    name: string,
    shortcut: DictationMenu["profiles"][number]["shortcut"],
  ) => ({
    id,
    name,
    shortcut,
    language: null,
  });
  const chord = profile("default", "Dictate", {
    kind: "modifierChord",
    modifiers: ["control", "fn"],
  });

  function dictationMenu(change: Partial<DictationMenu>, platform: NodeJS.Platform = "darwin") {
    const done: unknown[] = [];
    const actions = {
      open: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      allow: () => undefined,
      quit: () => undefined,
      dictation: (action: unknown) => done.push(action),
    };
    const result = trayMenu(
      { installed: true, connected: true, running: true },
      "Product",
      actions,
      {
        activity: { phase: "idle" },
        profiles: [chord],
        mode: "toggle",
        canCopyLast: true,
        cancelKeys: null,
        ...change,
      },
      platform,
    );
    const item = (label: string) => result.template.find((entry) => entry.label === label);
    const labels = result.template.map((entry) => entry.label).filter(Boolean);
    const click = (label: string) => {
      (item(label)?.click as (() => void) | undefined)?.();
      return done;
    };
    return { ...result, labels, item, click };
  }

  test("idle: start each shortcut, showing its keys, and copy the last dictation", () => {
    const one = dictationMenu({});
    expect(one.labels.slice(0, 3)).toEqual([
      "Start Dictation (⌃ Control + Fn)",
      "Copy Last Dictation",
      "This computer: available to agents",
    ]);
    expect(one.click("Start Dictation (⌃ Control + Fn)")).toEqual([
      { kind: "start", profileId: "default" },
    ]);
    expect(one.toolTip).toBe("Product: this computer is available to agents");

    const two = dictationMenu({
      profiles: [
        chord,
        profile("no", "Norwegian", { kind: "accelerator", accelerator: "Control+Shift+2" }),
      ],
      mode: "hold",
      canCopyLast: false,
    });
    expect(two.labels.slice(0, 3)).toEqual([
      "Start Dictation: Dictate (hold ⌃ Control + Fn)",
      "Start Dictation: Norwegian",
      "Copy Last Dictation",
    ]);
    // A key combination is shown the menu's own way, and not taken from other apps.
    expect(two.item("Start Dictation: Norwegian")).toMatchObject({
      accelerator: "Control+Shift+2",
      registerAccelerator: false,
    });
    expect(two.item("Copy Last Dictation")?.enabled).toBe(false);
  });

  test("under way: says how it is going, and offers only what fits", () => {
    const listening = dictationMenu({ activity: { phase: "recording" } });
    expect(listening.labels.slice(0, 3)).toEqual([
      "Dictation: listening",
      "Finish Dictation",
      "Cancel Dictation",
    ]);
    expect(listening.item("Dictation: listening")?.enabled).toBe(false);
    expect(listening.toolTip).toBe("Product: dictation is listening");
    expect(listening.item("Cancel Dictation")?.accelerator).toBeUndefined();
    expect(listening.click("Finish Dictation")).toEqual([{ kind: "finish" }]);
    expect(listening.click("Cancel Dictation")).toEqual([{ kind: "finish" }, { kind: "cancel" }]);

    // The cancel shortcut, when the person set one, shows beside Cancel.
    expect(
      dictationMenu({ activity: { phase: "recording" }, cancelKeys: "Control+Alt+X" }).item(
        "Cancel Dictation",
      ),
    ).toMatchObject({ accelerator: "Control+Alt+X", registerAccelerator: false });
    const starting = dictationMenu({ activity: { phase: "starting" } });
    expect(starting.labels.slice(0, 2)).toEqual(["Dictation: starting…", "Cancel Dictation"]);
    const writing = dictationMenu({ activity: { phase: "transcribing" } });
    expect(writing.labels.slice(0, 3)).toEqual([
      "Dictation: transcribing…",
      "Cancel Dictation",
      "This computer: available to agents",
    ]);
    expect(writing.toolTip).toBe("Product: transcribing your dictation…");
  });

  test("failed: says why, retries when it can, and lets it go", () => {
    const message = "The transcription service didn't answer. Check your connection and try again.";
    const failed = dictationMenu({ activity: { phase: "failed", message, retryable: true } });
    expect(failed.labels.slice(0, 4)).toEqual([
      "Dictation: failed",
      "The transcription service didn't answer. Check your connect…",
      "Retry Dictation",
      "Dismiss",
    ]);
    expect(failed.toolTip).toBe(`Product: dictation failed: ${message}`);
    expect(failed.click("Retry Dictation")).toEqual([{ kind: "retry" }]);
    const final = dictationMenu({ activity: { phase: "failed", message: "No", retryable: false } });
    expect(final.labels).not.toContain("Retry Dictation");
    expect(final.click("Dismiss")).toEqual([{ kind: "dismiss" }]);
  });

  test("shortcuts read as the settings name them", () => {
    expect(dictationShortcutWords({ kind: "modifierPair", modifier: "option" }, "darwin")).toBe(
      "both ⌥ Option keys",
    );
    expect(dictationShortcutWords({ kind: "modifierPair", modifier: "option" }, "win32")).toBe(
      "both Alt keys",
    );
    expect(dictationShortcutWords({ kind: "accelerator", accelerator: "F5" }, "darwin")).toBeNull();
  });

  test("icons: macOS template images, colored elsewhere, and a moving transcribing icon", () => {
    const alpha = (bitmap: { buffer: Buffer }, x: number, y: number, width: number) =>
      bitmap.buffer[(y * width + x) * 4 + 3]!;
    const mac = trayGlyphStyle("darwin");
    const recording = trayGlyphBitmap("recording", mac);
    expect(recording).toMatchObject({ width: 36, height: 36, scaleFactor: 2 });
    // Opaque black in the middle, clear in the corner.
    expect(alpha(recording, 18, 18, 36)).toBe(255);
    expect([...recording.buffer.subarray((18 * 36 + 18) * 4, (18 * 36 + 18) * 4 + 3)]).toEqual([
      0, 0, 0,
    ]);
    expect(alpha(recording, 0, 0, 36)).toBe(0);

    const windows = trayGlyphBitmap("recording", {
      ...trayGlyphStyle("win32"),
      color: [255, 255, 255],
    });
    const middle = (windows.width / 2) * (windows.width + 1) * 4;
    // BGRA: the dot is red.
    expect([...windows.buffer.subarray(middle, middle + 3)]).toEqual([77, 72, 229]);

    const frames = Array.from({ length: TRANSCRIBING_FRAMES }, (_, frame) =>
      trayGlyphBitmap("transcribing", mac, frame).buffer.toString("base64"),
    );
    expect(new Set(frames).size).toBe(TRANSCRIBING_FRAMES);
    for (const glyph of ["starting", "done", "failed", "meeting"] as const) {
      const bitmap = trayGlyphBitmap(glyph, mac);
      expect(bitmap.buffer.some((value, index) => index % 4 === 3 && value === 255)).toBe(true);
    }
  });
});

describe("a meeting being recorded, in the menu bar", () => {
  const minute = 60_000;
  const meeting = (change: Partial<Meeting> = {}): Meeting => ({
    title: "Weekly sync",
    paused: false,
    elapsedMilliseconds: 2 * minute,
    at: 100 * minute,
    canOpen: true,
    otherAccount: null,
    ...change,
  });

  function meetingMenu(
    recording: Meeting | null,
    {
      dictation = null,
      now = 112 * minute,
    }: { dictation?: DictationMenu | null; now?: number } = {},
  ) {
    const done: unknown[] = [];
    const actions = {
      open: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      allow: () => undefined,
      quit: () => undefined,
      dictation: (action: unknown) => done.push(action),
      meeting: (action: unknown) => done.push(action),
    };
    const result = trayMenu(
      { installed: true, connected: true, running: true },
      "Product",
      actions,
      dictation,
      "darwin",
      recording,
      now,
    );
    const labels = result.template.map((entry) => entry.label).filter(Boolean);
    const click = (label: string) => {
      const item = result.template.find((entry) => entry.label === label);
      (item?.click as (() => void) | undefined)?.();
      return done;
    };
    return { ...result, labels, click };
  }

  test("shows what records and for how long, at the top, with open and stop", () => {
    const { labels, toolTip, template, click } = meetingMenu(meeting());
    expect(labels.slice(0, 4)).toEqual([
      "Meeting: recording · 14 min",
      "Weekly sync",
      "Open Live Transcript",
      "Stop Recording",
    ]);
    expect(template[0]!.enabled).toBe(false);
    expect(template[1]!.enabled).toBe(false);
    expect(template[4]!.type).toBe("separator");
    expect(toolTip).toBe("Product: recording a meeting (14 min)");
    expect(click("Open Live Transcript")).toEqual(["open"]);
    expect(click("Stop Recording")).toEqual(["open", "stop"]);
  });

  test("paused, untitled, in another account", () => {
    const { labels, toolTip } = meetingMenu(
      meeting({ paused: true, title: null, otherAccount: "ana@example.com" }),
    );
    expect(labels[0]).toBe("Meeting: paused · 2 min");
    expect(labels[1]).toMatch(/^Started .+ · ana@example\.com$/u);
    expect(toolTip).toBe("Product: meeting recording paused (2 min)");
  });

  test("a page that can't open it still brings its account up", () => {
    expect(meetingMenu(meeting({ canOpen: false })).labels).toContain("Show Recording");
  });

  test("nothing about meetings while none records", () => {
    const { labels, toolTip } = meetingMenu(null);
    expect(labels.some((label) => /Meeting|Recording|Transcript/u.test(String(label)))).toBe(false);
    expect(toolTip).toBe("Product: this computer is available to agents");
  });

  test("a dictation under way says so in the tooltip; the meeting stays in the menu", () => {
    const { labels, toolTip } = meetingMenu(meeting(), {
      dictation: {
        activity: { phase: "recording" },
        profiles: [],
        mode: "toggle",
        canCopyLast: false,
        cancelKeys: null,
      },
    });
    expect(toolTip).toBe("Product: dictation is listening");
    expect(labels[0]).toBe("Meeting: recording · 14 min");
    expect(labels).toContain("Dictation: listening");
  });

  test("recorded time in words", () => {
    expect(recordedWords(30_000)).toBe("just started");
    expect(recordedWords(59 * minute)).toBe("59 min");
    expect(recordedWords(60 * minute)).toBe("1 h");
    expect(recordedWords(125 * minute)).toBe("2 h 5 min");
  });

  test("its icon is a recording badge, unlike dictation's", () => {
    const mac = trayGlyphStyle("darwin");
    expect(
      trayGlyphBitmap("meeting", mac).buffer.equals(trayGlyphBitmap("recording", mac).buffer),
    ).toBe(false);
  });
});
