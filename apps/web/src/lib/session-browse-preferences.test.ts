import { describe, expect, test } from "bun:test";

import {
  readSessionBrowseGroupBy,
  sessionBrowsePreferenceStorageId,
  writeSessionBrowseGroupBy,
} from "./session-browse-preferences";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("session browse preferences", () => {
  test("isolates the grouping preference by subject", () => {
    const first = sessionBrowsePreferenceStorageId("user:one");
    const otherUser = sessionBrowsePreferenceStorageId("user:two");

    expect(first).not.toBe(otherUser);
    expect(first).toContain("user%3Aone");
  });

  test("round-trips each supported grouping", () => {
    const storage = memoryStorage();
    const id = sessionBrowsePreferenceStorageId("user:one");

    expect(readSessionBrowseGroupBy(id, storage)).toBe("activity");
    writeSessionBrowseGroupBy(id, "creator", storage);
    expect(readSessionBrowseGroupBy(id, storage)).toBe("creator");
    writeSessionBrowseGroupBy(id, "created", storage);
    expect(readSessionBrowseGroupBy(id, storage)).toBe("created");
  });

  test("falls back safely when storage is stale or unavailable", () => {
    const id = sessionBrowsePreferenceStorageId("user:one");
    const stale = {
      getItem: () => "removed-grouping",
      setItem: () => undefined,
    };
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readSessionBrowseGroupBy(id, stale)).toBe("activity");
    expect(readSessionBrowseGroupBy(id, blocked)).toBe("activity");
    expect(() => writeSessionBrowseGroupBy(id, "creator", blocked)).not.toThrow();
  });
});
