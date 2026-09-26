import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SESSION_BROWSE_PREFERENCES,
  readSessionBrowseGroupBy,
  sessionBrowsePreferencesCustomized,
  sessionBrowsePreferenceStorageId,
  writeSessionBrowseGroupBy,
  readSessionBrowsePreferences,
  writeSessionBrowsePreferences,
} from "./session-browse-preferences";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("session browse preferences", () => {
  test("the default view is not a customized or filtered view", () => {
    const storage = memoryStorage();
    const id = sessionBrowsePreferenceStorageId("user:new", "workspace:personal");
    expect(sessionBrowsePreferencesCustomized(DEFAULT_SESSION_BROWSE_PREFERENCES)).toBe(false);
    expect(sessionBrowsePreferencesCustomized(readSessionBrowsePreferences(id, storage))).toBe(
      false,
    );
    expect(
      sessionBrowsePreferencesCustomized({
        ...DEFAULT_SESSION_BROWSE_PREFERENCES,
        groupBy: "activity",
      }),
    ).toBe(true);
    expect(
      sessionBrowsePreferencesCustomized({ ...DEFAULT_SESSION_BROWSE_PREFERENCES, status: "all" }),
    ).toBe(true);
    expect(
      sessionBrowsePreferencesCustomized({
        ...DEFAULT_SESSION_BROWSE_PREFERENCES,
        showEmptyGroups: true,
      }),
    ).toBe(true);
    expect(
      sessionBrowsePreferencesCustomized({ ...DEFAULT_SESSION_BROWSE_PREFERENCES, sortBy: "name" }),
    ).toBe(true);
  });

  test("persists the complete view independently for each workspace and subject", () => {
    const storage = memoryStorage();
    const id = sessionBrowsePreferenceStorageId("user:one", "workspace:one");
    const other = sessionBrowsePreferenceStorageId("user:one", "workspace:two");
    const view = { groupBy: "none", sortBy: "name", status: "all", showEmptyGroups: true } as const;
    writeSessionBrowsePreferences(id, view, storage);
    expect(readSessionBrowsePreferences(id, storage)).toEqual(view);
    expect(readSessionBrowsePreferences(other, storage)).toEqual({
      groupBy: "project",
      sortBy: "updatedAt",
      status: "active",
      showEmptyGroups: false,
    });
    storage.setItem(
      `${id}:view`,
      '{"groupBy":"bad","sortBy":"bad","status":"bad","showEmptyGroups":"true"}',
    );
    expect(readSessionBrowsePreferences(id, storage)).toEqual(
      readSessionBrowsePreferences(other, storage),
    );
  });
  test("isolates the grouping preference by subject", () => {
    const first = sessionBrowsePreferenceStorageId("user:one");
    const otherUser = sessionBrowsePreferenceStorageId("user:two");

    expect(first).not.toBe(otherUser);
    expect(first).toContain("user%3Aone");
  });

  test("round-trips each supported grouping", () => {
    const storage = memoryStorage();
    const id = sessionBrowsePreferenceStorageId("user:one");

    expect(readSessionBrowseGroupBy(id, storage)).toBe("project");
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

    expect(readSessionBrowseGroupBy(id, stale)).toBe("project");
    expect(readSessionBrowseGroupBy(id, blocked)).toBe("project");
    expect(readSessionBrowseGroupBy(id, null)).toBe("project");
    expect(readSessionBrowsePreferences(id, blocked).groupBy).toBe("project");
    expect(readSessionBrowsePreferences(id, null).groupBy).toBe("project");
    expect(() => writeSessionBrowseGroupBy(id, "creator", blocked)).not.toThrow();
  });
  test("preserves saved groupings in complete and legacy preferences", () => {
    const storage = memoryStorage();
    const id = sessionBrowsePreferenceStorageId("user:one", "workspace:one");
    for (const groupBy of ["activity", "created", "creator", "project", "none"] as const) {
      writeSessionBrowseGroupBy(id, groupBy, storage);
      expect(readSessionBrowseGroupBy(id, storage)).toBe(groupBy);
      expect(readSessionBrowsePreferences(id, storage).groupBy).toBe(groupBy);
    }
    for (const groupBy of ["activity", "created", "creator", "project", "none"] as const) {
      const view = {
        groupBy,
        sortBy: "updatedAt",
        status: "active",
        showEmptyGroups: false,
      } as const;
      writeSessionBrowsePreferences(id, view, storage);
      expect(readSessionBrowsePreferences(id, storage)).toEqual(view);
    }
  });

  test("defaults to project for malformed or incomplete saved views", () => {
    const storage = memoryStorage();
    const id = sessionBrowsePreferenceStorageId("user:one");
    for (const value of ["{", "{}", '{"groupBy":"removed-grouping"}']) {
      storage.setItem(`${id}:view`, value);
      expect(readSessionBrowsePreferences(id, storage).groupBy).toBe("project");
    }
  });
});
