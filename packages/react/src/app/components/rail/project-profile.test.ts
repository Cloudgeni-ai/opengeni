import { describe, expect, test } from "bun:test";
import { sameProjectAvatar } from "./project-profile";

describe("sameProjectAvatar", () => {
  test("treats letters the dialog upper-cases as unchanged", () => {
    expect(
      sameProjectAvatar(
        { kind: "letters", letters: "ux", hue: 270 },
        { kind: "letters", letters: "UX", hue: 270 },
      ),
    ).toBe(true);
  });

  test("notices a real change to any field", () => {
    const emoji = { kind: "emoji", emoji: "🎨", hue: 270 } as const;
    expect(sameProjectAvatar(emoji, { ...emoji })).toBe(true);
    expect(sameProjectAvatar(emoji, { ...emoji, hue: 210 })).toBe(false);
    expect(sameProjectAvatar(emoji, { ...emoji, emoji: "🐛" })).toBe(false);
    expect(
      sameProjectAvatar(
        { kind: "letters", letters: "UX", hue: 270 },
        { kind: "letters", letters: "UI", hue: 270 },
      ),
    ).toBe(false);
    expect(sameProjectAvatar(emoji, { kind: "icon", icon: "bug", hue: 270 })).toBe(false);
  });

  test("compares cleared avatars", () => {
    expect(sameProjectAvatar(null, null)).toBe(true);
    expect(sameProjectAvatar(null, { kind: "letters", letters: "UX", hue: 270 })).toBe(false);
  });
});
