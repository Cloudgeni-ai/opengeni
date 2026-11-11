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
    writeSiteChatPanelLayout(id, { width: 9999, collapsed: true, position: "left" }, storage);
    const saved = { width: 720, collapsed: true, position: "left" } as const;
    expect(JSON.parse(storage.values.get(id)!)).toEqual(saved);
    expect(readSiteChatPanelLayout(id, storage)).toEqual(saved);
  });

  test("the chat sits on the right unless the person moved it left", () => {
    const at = (position: unknown) =>
      readSiteChatPanelLayout(id, memory({ [id]: JSON.stringify({ width: 500, position }) }))
        .position;
    expect(at("left")).toBe("left");
    expect(at("right")).toBe("right");
    // Saved before the choice existed, or anything else: the right.
    expect(at(undefined)).toBe("right");
    expect(at("top")).toBe("right");
    expect(at(1)).toBe("right");
  });

  test("anything unreadable falls back to the default", () => {
    const fallback = { width: 400, collapsed: false, position: "right" } as const;
    expect(readSiteChatPanelLayout(id, memory())).toEqual(fallback);
    expect(readSiteChatPanelLayout(id, null)).toEqual(fallback);
    for (const raw of ["{", "null", "[]", "42", JSON.stringify({ width: "wide", collapsed: 1 })])
      expect(readSiteChatPanelLayout(id, memory({ [id]: raw }))).toEqual(fallback);
    expect(readSiteChatPanelLayout(id, memory({ [id]: JSON.stringify({ width: 10 }) }))).toEqual({
      width: 320,
      collapsed: false,
      position: "right",
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
    expect(readSiteChatPanelLayout(id, blocked)).toEqual({
      width: 400,
      collapsed: false,
      position: "right",
    });
    expect(() =>
      writeSiteChatPanelLayout(id, { width: 500, collapsed: false, position: "left" }, blocked),
    ).not.toThrow();
  });
});
