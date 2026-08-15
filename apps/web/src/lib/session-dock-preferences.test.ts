import { describe, expect, test } from "bun:test";
import {
  readSessionDockCollapsed,
  readSessionDockNavigation,
  sessionDockLayoutStorageId,
  updateSessionDockNavigation,
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

  test("merges navigation choices and clears stale resources", () => {
    const storage = memoryStorage();
    const id = sessionDockLayoutStorageId("user:one", "session-a");

    updateSessionDockNavigation(
      id,
      { activeTab: "browser", browserSessionId: "browser-a" },
      storage,
    );
    updateSessionDockNavigation(
      id,
      { artifactId: "artifact-a", filePath: "src/index.ts" },
      storage,
    );
    expect(readSessionDockNavigation(id, storage)).toEqual({
      activeTab: "browser",
      browserSessionId: "browser-a",
      artifactId: "artifact-a",
      filePath: "src/index.ts",
    });

    updateSessionDockNavigation(id, { browserSessionId: null }, storage);
    expect(readSessionDockNavigation(id, storage).browserSessionId).toBeUndefined();
    expect(readSessionDockNavigation(id, storage).artifactId).toBe("artifact-a");
  });

  test("ignores malformed navigation records", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const id = sessionDockLayoutStorageId("user:one", "session-a");
    storage.setItem(`${id}:navigation`, "not-json");
    expect(readSessionDockNavigation(id, storage)).toEqual({});
  });
});
