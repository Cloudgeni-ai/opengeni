import { describe, expect, test } from "bun:test";

import { matchesShortcut, NEW_SESSION_SHORTCUT, shortcutLabel } from "./keyboard-shortcuts";

function key(
  overrides: Partial<{
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    repeat: boolean;
  }> = {},
) {
  return {
    code: "KeyO",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides,
  };
}

describe("keyboard shortcuts", () => {
  test("matches Cmd/Ctrl+Shift+O for new session", () => {
    const chord = NEW_SESSION_SHORTCUT.chord;
    expect(matchesShortcut(key({ metaKey: true, shiftKey: true }), chord)).toBe(true);
    expect(matchesShortcut(key({ ctrlKey: true, shiftKey: true }), chord)).toBe(true);
    expect(matchesShortcut(key({ metaKey: true }), chord)).toBe(false);
    expect(matchesShortcut(key({ shiftKey: true }), chord)).toBe(false);
    expect(matchesShortcut(key({ metaKey: true, shiftKey: true, altKey: true }), chord)).toBe(
      false,
    );
    expect(matchesShortcut(key({ metaKey: true, shiftKey: true, code: "KeyN" }), chord)).toBe(
      false,
    );
    expect(matchesShortcut(key({ metaKey: true, shiftKey: true, repeat: true }), chord)).toBe(
      false,
    );
  });

  test("labels prefer Apple glyphs when on Apple", () => {
    expect(shortcutLabel(NEW_SESSION_SHORTCUT)).toMatch(/⌘⇧O|Ctrl\+Shift\+O/);
  });
});
