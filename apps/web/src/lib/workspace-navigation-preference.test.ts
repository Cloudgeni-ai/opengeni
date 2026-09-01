import { describe, expect, test } from "bun:test";

import {
  isAuthorizedWorkspaceId,
  parseRootWorkspaceSearch,
  readLastWorkspaceId,
  resolveLandingWorkspaceId,
  workspaceNavigationPreferenceStorageId,
  writeLastWorkspaceId,
} from "./workspace-navigation-preference";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("workspace navigation preference", () => {
  test("scopes the remembered workspace to the authenticated subject", () => {
    expect(workspaceNavigationPreferenceStorageId("user:one")).not.toBe(
      workspaceNavigationPreferenceStorageId("user:two"),
    );
  });

  test("round-trips one browser-local last workspace", () => {
    const storage = memoryStorage();
    const storageId = workspaceNavigationPreferenceStorageId("user:one");

    expect(readLastWorkspaceId(storageId, storage)).toBeNull();
    writeLastWorkspaceId(storageId, "workspace-b", storage);
    expect(readLastWorkspaceId(storageId, storage)).toBe("workspace-b");
  });

  test("keeps navigation usable when browser storage is unavailable", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    expect(readLastWorkspaceId("preference", denied)).toBeNull();
    expect(() => writeLastWorkspaceId("preference", "workspace-a", denied)).not.toThrow();
  });

  test("accepts one bounded callback workspace parameter", () => {
    expect(parseRootWorkspaceSearch({ workspaceId: "workspace-a" })).toEqual({
      workspaceId: "workspace-a",
    });
    expect(parseRootWorkspaceSearch({ workspaceId: ["workspace-a"] })).toEqual({});
    expect(parseRootWorkspaceSearch({ workspaceId: "" })).toEqual({});
    expect(parseRootWorkspaceSearch({ workspaceId: "x".repeat(257) })).toEqual({});
  });

  test("prefers an authorized callback target over the remembered workspace", () => {
    expect(
      resolveLandingWorkspaceId({
        requestedWorkspaceId: "workspace-c",
        rememberedWorkspaceId: "workspace-b",
        defaultWorkspaceId: "workspace-personal",
        listedWorkspaceIds: ["workspace-personal", "workspace-b", "workspace-c"],
        grantedWorkspaceIds: [],
      }),
    ).toBe("workspace-c");
  });

  test("uses the remembered workspace before the Personal default", () => {
    expect(
      resolveLandingWorkspaceId({
        rememberedWorkspaceId: "workspace-shared",
        defaultWorkspaceId: "workspace-personal",
        listedWorkspaceIds: ["workspace-personal", "workspace-shared"],
        grantedWorkspaceIds: [],
      }),
    ).toBe("workspace-shared");
  });

  test("ignores callback and stored workspaces that are no longer authorized", () => {
    expect(
      resolveLandingWorkspaceId({
        requestedWorkspaceId: "workspace-revoked",
        rememberedWorkspaceId: "workspace-deleted",
        defaultWorkspaceId: "workspace-personal",
        listedWorkspaceIds: ["workspace-personal"],
        grantedWorkspaceIds: [],
      }),
    ).toBe("workspace-personal");
  });

  test("recognizes workspace grants when the workspace inventory is sparse", () => {
    expect(isAuthorizedWorkspaceId("workspace-granted", [], ["workspace-granted"])).toBe(true);
    expect(
      resolveLandingWorkspaceId({
        rememberedWorkspaceId: "workspace-granted",
        defaultWorkspaceId: null,
        listedWorkspaceIds: [],
        grantedWorkspaceIds: ["workspace-granted"],
      }),
    ).toBe("workspace-granted");
  });
});
