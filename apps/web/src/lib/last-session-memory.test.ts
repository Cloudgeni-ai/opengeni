import { describe, expect, test } from "bun:test";

import {
  forgetLastSessionId,
  lastSessionMemoryId,
  readLastSessionId,
  rememberLastSessionId,
} from "./last-session-memory";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("last session memory", () => {
  const id = lastSessionMemoryId("user:maja", "workspace-a");

  test("remembers the last opened session per person and workspace", () => {
    const storage = memoryStorage();
    rememberLastSessionId(id, "session-1", storage);
    rememberLastSessionId(id, "session-2", storage);
    expect(readLastSessionId(id, storage)).toBe("session-2");
    expect(readLastSessionId(lastSessionMemoryId("user:maja", "workspace-b"), storage)).toBeNull();
    expect(readLastSessionId(lastSessionMemoryId("user:ola", "workspace-a"), storage)).toBeNull();
  });

  test("the new-session page forgets it", () => {
    const storage = memoryStorage();
    rememberLastSessionId(id, "session-1", storage);
    forgetLastSessionId(id, undefined, storage);
    expect(readLastSessionId(id, storage)).toBeNull();
  });

  test("a gone session is forgotten only while it is still the remembered one", () => {
    const storage = memoryStorage();
    rememberLastSessionId(id, "session-2", storage);
    forgetLastSessionId(id, "session-1", storage);
    expect(readLastSessionId(id, storage)).toBe("session-2");
    forgetLastSessionId(id, "session-2", storage);
    expect(readLastSessionId(id, storage)).toBeNull();
  });

  test("ignores unusable values and blocked storage", () => {
    const storage = memoryStorage();
    storage.values.set(id, "x".repeat(300));
    expect(readLastSessionId(id, storage)).toBeNull();
    rememberLastSessionId(id, "", storage);
    expect(storage.values.get(id)).toBe("x".repeat(300));

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLastSessionId(id, blocked)).toBeNull();
    expect(() => rememberLastSessionId(id, "session-1", blocked)).not.toThrow();
    expect(() => forgetLastSessionId(id, undefined, blocked)).not.toThrow();
    expect(readLastSessionId(id, null)).toBeNull();
  });
});
