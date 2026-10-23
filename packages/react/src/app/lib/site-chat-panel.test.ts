import { describe, expect, test } from "bun:test";

import {
  clampSiteChatWidth,
  readSiteChatPanelLayout,
  siteChatPanelStorageId,
  writeSiteChatPanelLayout,
} from "./site-chat-panel";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("site chat panel layout", () => {
  const id = siteChatPanelStorageId("user:a@b/c");

  test("is stored per person under a versioned key", () => {
    expect(id).toBe("og.site-view.chat:v1:user%3Aa%40b%2Fc");
    expect(siteChatPanelStorageId("someone-else")).not.toBe(id);
  });

  test("widths stay within the panel's limits", () => {
    expect(clampSiteChatWidth(100)).toBe(320);
    expect(clampSiteChatWidth(480.4)).toBe(480);
    expect(clampSiteChatWidth(5000)).toBe(720);
    expect(clampSiteChatWidth(Number.NaN)).toBe(400);
  });

  test("round-trips a saved layout", () => {
    const storage = memory();
    writeSiteChatPanelLayout(id, { width: 9999, collapsed: true }, storage);
    expect(JSON.parse(storage.values.get(id)!)).toEqual({ width: 720, collapsed: true });
    expect(readSiteChatPanelLayout(id, storage)).toEqual({ width: 720, collapsed: true });
  });

  test("anything unreadable falls back to the default", () => {
    const fallback = { width: 400, collapsed: false };
    expect(readSiteChatPanelLayout(id, memory())).toEqual(fallback);
    expect(readSiteChatPanelLayout(id, null)).toEqual(fallback);
    for (const raw of ["{", "null", "[]", "42", JSON.stringify({ width: "wide", collapsed: 1 })])
      expect(readSiteChatPanelLayout(id, memory({ [id]: raw }))).toEqual(fallback);
    expect(readSiteChatPanelLayout(id, memory({ [id]: JSON.stringify({ width: 10 }) }))).toEqual({
      width: 320,
      collapsed: false,
    });
  });

  test("blocked or full storage doesn't break the panel", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readSiteChatPanelLayout(id, blocked)).toEqual({ width: 400, collapsed: false });
    expect(() =>
      writeSiteChatPanelLayout(id, { width: 500, collapsed: false }, blocked),
    ).not.toThrow();
  });
});
