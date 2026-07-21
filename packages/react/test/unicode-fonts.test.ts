import { describe, expect, test } from "bun:test";
import { detectUnicodeFontNeeds } from "../src/lib/use-unicode-fonts";

describe("Unicode font detection", () => {
  test("keeps Latin-only workspaces off the script font graph", () => {
    expect(detectUnicodeFontNeeds(["apps/web/src/server.ts", "résumé.md"])).toEqual({
      japanese: false,
      arabic: false,
    });
  });

  test("detects Japanese and Arabic paths independently and together", () => {
    expect(detectUnicodeFontNeeds(["日本語/設定.ts"])).toEqual({
      japanese: true,
      arabic: false,
    });
    expect(detectUnicodeFontNeeds(["مرحبا/إعدادات.ts"])).toEqual({
      japanese: false,
      arabic: true,
    });
    expect(detectUnicodeFontNeeds(["日本語/مرحبا.ts"])).toEqual({
      japanese: true,
      arabic: true,
    });
  });
});
