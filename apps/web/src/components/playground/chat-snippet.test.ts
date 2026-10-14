import { describe, expect, test } from "bun:test";

import * as react from "@opengeni/react";

import { changedLines, chatSnippet } from "./chat-snippet";
import { ACCENTS, customAccent, defaultChatStyle } from "./style-knobs";

const dark = defaultChatStyle("dark");

describe("playground snippet", () => {
  test("is short: the component and its style, nothing else", () => {
    const lines = chatSnippet(dark);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines).toContain("    <OpenGeniChat />");
    expect(lines).toContain(`    "--og-color-accent": "${dark.accent.value}",`);
    // Dark is the package default: no theme attribute.
    expect(lines.join("\n")).not.toContain("data-og-theme");
    expect(lines.join("\n")).not.toContain("apiKey");
    expect(typeof react.OpenGeniChat).toBe("function");
    expect(typeof react.OpenGeniProvider).toBe("function");
  });

  test("a color marks its three lines; light marks one", () => {
    const before = chatSnippet(dark);
    const recolored = chatSnippet({ ...dark, accent: ACCENTS[1]! });
    expect(changedLines(before, recolored).map((index) => recolored[index])).toEqual([
      `    "--og-color-accent": "${ACCENTS[1]!.value}",`,
      `    "--og-color-primary": "${ACCENTS[1]!.value}",`,
      `    "--og-color-surface-2": "${ACCENTS[1]!.value}26",`,
    ]);
    const light = chatSnippet({ ...dark, theme: "light" });
    expect(changedLines(before, light).map((index) => light[index])).toEqual([
      '  <div data-og-theme="light" style={{',
    ]);
    expect(changedLines(before, before)).toEqual([]);
  });

  test("a typed brand color counts once it is a full hex", () => {
    expect(customAccent("#FF5A1F")).toEqual({ name: "Custom", value: "#ff5a1f" });
    expect(customAccent("ff5a1f")!.value).toBe("#ff5a1f");
    expect(customAccent("#ff5a")).toBeNull();
    expect(customAccent("orange")).toBeNull();
  });
});
