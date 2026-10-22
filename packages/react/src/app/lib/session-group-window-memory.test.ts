import { describe, expect, test } from "bun:test";

import {
  readSessionGroupWindows,
  sessionGroupWindowMemoryId,
  writeSessionGroupWindows,
} from "./session-group-window-memory";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("session group window memory", () => {
  const id = sessionGroupWindowMemoryId("user:maja", "workspace-a");

  test("restores manual windows after the rail remounts in the same view", () => {
    const storage = memoryStorage();
    writeSessionGroupWindows(
      id,
      "view-1",
      new Map([
        ["channel:default", 12],
        ["channel:p", 8],
      ]),
      storage,
    );
    expect(Object.fromEntries(readSessionGroupWindows(id, "view-1", storage))).toEqual({
      "channel:default": 12,
      "channel:p": 8,
    });
  });

  test("a different view starts from the default step", () => {
    const storage = memoryStorage();
    writeSessionGroupWindows(id, "view-1", new Map([["channel:default", 12]]), storage);
    expect(readSessionGroupWindows(id, "view-2", storage).size).toBe(0);
  });

  test("is scoped to the person and the workspace", () => {
    expect(sessionGroupWindowMemoryId("user:maja", "workspace-b")).not.toBe(id);
    expect(sessionGroupWindowMemoryId("user:jonas", "workspace-a")).not.toBe(id);
    const storage = memoryStorage();
    writeSessionGroupWindows(id, "view-1", new Map([["channel:default", 12]]), storage);
    expect(
      readSessionGroupWindows(
        sessionGroupWindowMemoryId("user:jonas", "workspace-a"),
        "view-1",
        storage,
      ).size,
    ).toBe(0);
  });

  test("stores only expanded groups and clears when none remain", () => {
    const storage = memoryStorage();
    writeSessionGroupWindows(id, "view-1", new Map([["channel:default", 12]]), storage);
    writeSessionGroupWindows(id, "view-1", new Map([["channel:default", 4]]), storage);
    expect(storage.values.has(id)).toBe(false);
  });

  test("ignores malformed values and bounds restored windows", () => {
    const storage = memoryStorage();
    storage.setItem(
      id,
      JSON.stringify({ view: "view-1", counts: { a: "12", b: 2.5, c: 3, d: 9000, e: 8 } }),
    );
    expect(Object.fromEntries(readSessionGroupWindows(id, "view-1", storage))).toEqual({
      d: 500,
      e: 8,
    });
    storage.setItem(id, "{not json");
    expect(readSessionGroupWindows(id, "view-1", storage).size).toBe(0);
    expect(readSessionGroupWindows(id, "view-1", null).size).toBe(0);
  });
});
