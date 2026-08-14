import { describe, expect, test } from "bun:test";
import {
  readSessionDockCollapsed,
  sessionDockLayoutStorageId,
  writeSessionDockCollapsed,
} from "./session-dock-preferences";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("session dock preferences", () => {
  test("isolates layout and visibility by subject and session", () => {
    const first = sessionDockLayoutStorageId("user:one", "session-a");
    const otherUser = sessionDockLayoutStorageId("user:two", "session-a");
    const otherSession = sessionDockLayoutStorageId("user:one", "session-b");

    expect(first).not.toBe(otherUser);
    expect(first).not.toBe(otherSession);
    expect(first).toContain("user%3Aone");
  });

  test("round-trips collapsed and expanded states without inventing a default", () => {
    const storage = memoryStorage();
    const id = sessionDockLayoutStorageId("user:one", "session-a");

    expect(readSessionDockCollapsed(id, storage)).toBeNull();
    writeSessionDockCollapsed(id, true, storage);
    expect(readSessionDockCollapsed(id, storage)).toBe(true);
    writeSessionDockCollapsed(id, false, storage);
    expect(readSessionDockCollapsed(id, storage)).toBe(false);
  });
});
