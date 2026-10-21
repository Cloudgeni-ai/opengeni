import { describe, expect, test } from "bun:test";
import {
  applicableChords,
  chordAccelerator,
  chordAriaKeys,
  chordKeys,
  chordLabel,
  matchesChord,
  type Chord,
} from "./chords";
import type { ChatRecord } from "./chat-directory";
import { isSwitcherKey, openChatSwitcher, stepChatSwitcher, SWITCHER_LIMIT } from "./chat-switcher";
import { LOOSE_MATCH_BELOW, rankLabel, rankWithKeywords } from "./rank";
import { APP_ACTIONS } from "./registry";

function key(
  code: string,
  modifiers: Partial<{
    meta: boolean;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    key: string;
  }> = {},
) {
  return {
    code,
    key: modifiers.key ?? "",
    metaKey: Boolean(modifiers.meta),
    ctrlKey: Boolean(modifiers.ctrl),
    shiftKey: Boolean(modifiers.shift),
    altKey: Boolean(modifiers.alt),
    repeat: false,
    isComposing: false,
  };
}

describe("chords", () => {
  const newChat: Chord = { code: "KeyO", mod: true, shift: true };

  test("⌘ on Mac and Ctrl elsewhere, exactly", () => {
    expect(matchesChord(key("KeyO", { meta: true, shift: true }), newChat, "mac")).toBe(true);
    expect(matchesChord(key("KeyO", { ctrl: true, shift: true }), newChat, "mac")).toBe(false);
    expect(matchesChord(key("KeyO", { ctrl: true, shift: true }), newChat, "other")).toBe(true);
    expect(matchesChord(key("KeyO", { meta: true, shift: true }), newChat, "other")).toBe(false);
    // Extra modifiers are a different chord.
    expect(matchesChord(key("KeyO", { meta: true, shift: true, alt: true }), newChat, "mac")).toBe(
      false,
    );
    expect(matchesChord(key("KeyO", { meta: true }), newChat, "mac")).toBe(false);
  });

  test("punctuation matches the typed character on other layouts", () => {
    const sheet: Chord = { code: "Slash", mod: true };
    // US: the physical "/" key.
    expect(matchesChord(key("Slash", { meta: true, key: "/" }), sheet, "mac")).toBe(true);
    // Nordic: "/" is Shift+7.
    expect(matchesChord(key("Digit7", { meta: true, shift: true, key: "/" }), sheet, "mac")).toBe(
      true,
    );
    // Shift+7 that types something else is not the chord.
    expect(matchesChord(key("Digit7", { meta: true, shift: true, key: "&" }), sheet, "mac")).toBe(
      false,
    );
    // A chord that needs Shift only matches its physical key.
    const copyLink: Chord = { code: "Comma", mod: true, shift: true };
    expect(matchesChord(key("Comma", { meta: true, shift: true, key: "<" }), copyLink, "mac")).toBe(
      true,
    );
    expect(matchesChord(key("KeyM", { meta: true, shift: true, key: "," }), copyLink, "mac")).toBe(
      false,
    );
  });

  test("held keys and input methods never fire", () => {
    expect(
      matchesChord({ ...key("KeyO", { meta: true, shift: true }), repeat: true }, newChat, "mac"),
    ).toBe(false);
    expect(
      matchesChord(
        { ...key("KeyO", { meta: true, shift: true }), isComposing: true },
        newChat,
        "mac",
      ),
    ).toBe(false);
  });

  test("shows each platform's notation", () => {
    const toggle: Chord = { code: "KeyS", mod: true, control: true };
    expect(chordKeys(toggle, "mac")).toEqual(["⌃", "⌘", "S"]);
    expect(chordLabel({ code: "Comma", mod: true, shift: true }, "mac")).toBe("⇧⌘,");
    expect(chordLabel({ code: "Comma", mod: true, shift: true }, "other")).toBe("Ctrl+Shift+,");
    expect(chordLabel({ code: "ArrowUp", alt: true }, "mac")).toBe("⌥↑");
    expect(chordAriaKeys({ code: "ArrowUp", alt: true }, "other")).toBe("Alt+ArrowUp");
    expect(chordAccelerator({ code: "KeyP", mod: true, alt: true })).toBe("CmdOrCtrl+Alt+P");
    expect(chordAccelerator(toggle)).toBe("Ctrl+CmdOrCtrl+S");
  });

  test("browser-reserved keys stay on desktop", () => {
    const action = APP_ACTIONS.find((candidate) => candidate.id === "chat.new")!;
    expect(applicableChords(action.chords, "web", "mac").map((chord) => chord.code)).toEqual([
      "KeyO",
    ]);
    expect(applicableChords(action.chords, "desktop", "mac").map((chord) => chord.code)).toEqual([
      "KeyN",
      "KeyO",
    ]);
    const inbox = APP_ACTIONS.find((candidate) => candidate.id === "go.inbox")!;
    // Ctrl+Shift+I opens developer tools in browsers on Windows and Linux.
    expect(applicableChords(inbox.chords, "web", "other")).toEqual([]);
    expect(applicableChords(inbox.chords, "desktop", "other")).toHaveLength(1);
  });

  test("no two actions share a chord on any surface", () => {
    for (const surface of ["web", "desktop"] as const) {
      for (const platform of ["mac", "other"] as const) {
        const seen = new Map<string, string>();
        for (const action of APP_ACTIONS) {
          for (const chord of applicableChords(action.chords, surface, platform)) {
            const label = chordLabel(chord, platform);
            expect(seen.get(label) ?? action.id).toBe(action.id);
            seen.set(label, action.id);
          }
        }
      }
    }
  });
});

describe("ranking", () => {
  test("prefix, then word start, then anywhere, then words in any order, then letters", () => {
    const query = "deploy";
    const prefix = rankLabel("Deploy the desktop app", query)!;
    const wordStart = rankLabel("Fix deploy script", query)!;
    const inside = rankLabel("Redeploying staging", query)!;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inside);
    const anyOrder = rankLabel("Fix the deploy script", "script fix")!;
    expect(anyOrder).toBeLessThan(inside);
    expect(anyOrder).toBeGreaterThan(rankLabel("Keyboard shortcuts", "kbsh")!);
  });

  test("ignores case and accents", () => {
    expect(rankLabel("Møte med Jørgen", "møte")).not.toBeNull();
    expect(rankLabel("Café menu", "cafe")).not.toBeNull();
    expect(rankLabel("ÅRSOPPGJØR", "årsopp")).not.toBeNull();
  });

  test("drops scattered letters", () => {
    expect(rankLabel("A long title about many unrelated things", "zq")).toBeNull();
    expect(rankLabel("Keyboard shortcuts", "kbsh")).not.toBeNull();
    expect(rankLabel("Anything", "x")).toBeNull();
    // Abbreviations start words; letters picked out of the middle of words don't.
    expect(rankLabel("Refactor billing webhooks", "rbw")).not.toBeNull();
    expect(rankLabel("Customer churn analysis", "rna")).toBeNull();
  });

  test("real matches outrank every letters-in-order guess", () => {
    expect(rankLabel("Pin", "pin")!).toBeGreaterThanOrEqual(LOOSE_MATCH_BELOW);
    expect(rankLabel("Fix the deploy script", "script fix")!).toBeGreaterThanOrEqual(
      LOOSE_MATCH_BELOW,
    );
    expect(rankLabel("Postgres slow query investigation", "pin")!).toBeLessThan(LOOSE_MATCH_BELOW);
  });

  test("keywords find an action under another name, a little lower", () => {
    const direct = rankWithKeywords("Copy link", ["share", "url"], "copy")!;
    const byKeyword = rankWithKeywords("Copy link", ["share", "url"], "share")!;
    expect(byKeyword).not.toBeNull();
    expect(byKeyword).toBeLessThan(direct);
  });
});

describe("chat switcher", () => {
  const record = (id: string, extra: Partial<ChatRecord> = {}): ChatRecord => ({
    id,
    workspaceId: "w",
    title: id,
    updatedAt: 1,
    pinned: false,
    archived: false,
    row: null,
    ...extra,
  });
  const directory = (recent: string[], records: ChatRecord[] = recent.map((id) => record(id))) => ({
    recent,
    rows: new Map(records.map((item) => [item.id, item])),
  });

  test("a press from a chat goes to the previous chat, and back again", () => {
    const first = openChatSwitcher(directory(["a", "b", "c"]), "a", false)!;
    expect(first.ids).toEqual(["a", "b", "c"]);
    expect(first.ids[first.index]).toBe("b");
    // Opening b moves it to the front, so the next press returns to a.
    const second = openChatSwitcher(directory(["b", "a", "c"]), "b", false)!;
    expect(second.ids[second.index]).toBe("a");
  });

  test("holding Control and pressing Tab walks down and wraps; Shift walks back", () => {
    let state = openChatSwitcher(directory(["a", "b", "c"]), "a", false)!;
    state = stepChatSwitcher(state, 1);
    expect(state.ids[state.index]).toBe("c");
    expect(state.visible).toBe(true);
    state = stepChatSwitcher(state, 1);
    expect(state.ids[state.index]).toBe("a");
    state = stepChatSwitcher(state, -1);
    expect(state.ids[state.index]).toBe("c");
  });

  test("Shift+Control+Tab starts at the oldest chat", () => {
    const state = openChatSwitcher(directory(["a", "b", "c"]), "a", true)!;
    expect(state.ids[state.index]).toBe("c");
  });

  test("away from a chat the most recent chat is the target", () => {
    const state = openChatSwitcher(directory(["a", "b"]), null, false)!;
    expect(state.ids[state.index]).toBe("a");
  });

  test("the open chat leads even before its visit is recorded", () => {
    const state = openChatSwitcher(directory(["a", "b"]), "x", false)!;
    expect(state.ids).toEqual(["x", "a", "b"]);
    expect(state.ids[state.index]).toBe("a");
  });

  test("archived and subagent chats are left out, and nothing opens with nowhere to go", () => {
    const rows = [
      record("a"),
      record("old", { archived: true }),
      record("child", { row: { parentSessionId: "a" } as ChatRecord["row"] }),
    ];
    expect(openChatSwitcher(directory(["a", "old", "child"], rows), "a", false)).toBeNull();
    expect(openChatSwitcher(directory([]), null, false)).toBeNull();
  });

  test("the list stops at ten chats", () => {
    const ids = Array.from({ length: 15 }, (_, index) => `c${index}`);
    expect(openChatSwitcher(directory(ids), "c0", false)!.ids).toHaveLength(SWITCHER_LIMIT);
  });

  test("only Control+Tab opens it", () => {
    const tab = { code: "Tab", ctrlKey: true, metaKey: false, altKey: false };
    expect(isSwitcherKey(tab)).toBe(true);
    expect(isSwitcherKey({ ...tab, metaKey: true })).toBe(false);
    expect(isSwitcherKey({ ...tab, altKey: true })).toBe(false);
    expect(isSwitcherKey({ ...tab, ctrlKey: false })).toBe(false);
    expect(isSwitcherKey({ ...tab, code: "KeyQ" })).toBe(false);
  });
});
