import { expect, test } from "bun:test";
import { avatarPrompt } from "../server/prompts";
import { AVATAR_THEMES, avatarTheme, DEFAULT_AVATAR_THEME, themeStyle } from "../server/themes";

test("every agent's prompt carries the workspace house style and only its own subject", () => {
  const theme = avatarTheme("outline");
  const coach = avatarPrompt({ name: "Run Coach", hint: "a running shoe", theme });
  const money = avatarPrompt({ name: "Money", description: "Tracks spending", theme });
  for (const prompt of [coach, money]) expect(prompt).toContain(theme.style);
  expect(coach).toContain("Subject: a running shoe.");
  expect(money).toContain("Subject: Tracks spending.");
});

test("unknown or missing styles fall back to the default", () => {
  expect(avatarTheme(undefined).id).toBe(DEFAULT_AVATAR_THEME);
  expect(avatarTheme("nope").id).toBe(DEFAULT_AVATAR_THEME);
  expect(new Set(AVATAR_THEMES.map((theme) => theme.id)).size).toBe(AVATAR_THEMES.length);
});

test("brand accents are filled in per agent and stay stable", () => {
  const theme = avatarTheme("og-mono");
  const style = themeStyle(theme, "Run Coach");
  expect(style).not.toContain("{accent}");
  expect(theme.accents?.some((accent) => style.includes(accent))).toBe(true);
  expect(themeStyle(theme, "Run Coach")).toBe(style);
  expect(avatarPrompt({ name: "Run Coach", theme })).toContain(style);
});
