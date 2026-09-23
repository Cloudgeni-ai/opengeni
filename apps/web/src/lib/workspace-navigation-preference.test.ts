import { describe, expect, test } from "bun:test";

import type { AccessContext, Workspace } from "@/types";

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

function workspace(id: string, accountId = "account-one"): Workspace {
  return {
    id,
    accountId,
    kind: "shared",
    name: id,
    slug: null,
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function accessContext(
  input: {
    workspaceIds?: readonly string[];
    defaultWorkspaceId?: string | null;
    subjectId?: string;
    accountId?: string;
  } = {},
): AccessContext {
  const subjectId = input.subjectId ?? "subject-one";
  const accountId = input.accountId ?? "account-one";
  return {
    mode: "managed",
    subjectId,
    accountGrants: [],
    workspaceGrants: (input.workspaceIds ?? []).map((workspaceId) => ({
      workspaceId,
      accountId,
      subjectId,
      permissions: ["workspace:read"],
    })),
    defaultAccountId: accountId,
    defaultWorkspaceId: input.defaultWorkspaceId ?? null,
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
    const workspaces = [
      workspace("workspace-personal"),
      workspace("workspace-b"),
      workspace("workspace-c"),
    ];
    expect(
      resolveLandingWorkspaceId({
        requestedWorkspaceId: "workspace-c",
        rememberedWorkspaceId: "workspace-b",
        workspaces,
        accessContext: accessContext({
          workspaceIds: workspaces.map((candidate) => candidate.id),
          defaultWorkspaceId: "workspace-personal",
        }),
      }),
    ).toBe("workspace-c");
  });

  test("uses the remembered workspace before the Personal default", () => {
    const workspaces = [workspace("workspace-personal"), workspace("workspace-shared")];
    expect(
      resolveLandingWorkspaceId({
        rememberedWorkspaceId: "workspace-shared",
        workspaces,
        accessContext: accessContext({
          workspaceIds: workspaces.map((candidate) => candidate.id),
          defaultWorkspaceId: "workspace-personal",
        }),
      }),
    ).toBe("workspace-shared");
  });

  test("ignores callback and stored workspaces that are no longer authorized", () => {
    const workspaces = [workspace("workspace-personal")];
    expect(
      resolveLandingWorkspaceId({
        requestedWorkspaceId: "workspace-revoked",
        rememberedWorkspaceId: "workspace-deleted",
        workspaces,
        accessContext: accessContext({
          workspaceIds: ["workspace-personal", "workspace-deleted"],
          defaultWorkspaceId: "workspace-personal",
        }),
      }),
    ).toBe("workspace-personal");
  });

  test("requires the live workspace row and its exact current-subject grant to agree", () => {
    const listed = workspace("workspace-listed");
    const exactAccess = accessContext({ workspaceIds: [listed.id] });
    expect(isAuthorizedWorkspaceId(listed.id, [listed], exactAccess)).toBe(true);
    expect(isAuthorizedWorkspaceId(listed.id, [listed], accessContext())).toBe(false);
    expect(isAuthorizedWorkspaceId(listed.id, [], exactAccess)).toBe(false);
    expect(
      isAuthorizedWorkspaceId(listed.id, [listed], {
        ...exactAccess,
        workspaceGrants: [{ ...exactAccess.workspaceGrants[0]!, accountId: "account-other" }],
      }),
    ).toBe(false);
    expect(
      isAuthorizedWorkspaceId(listed.id, [listed], {
        ...exactAccess,
        workspaceGrants: [{ ...exactAccess.workspaceGrants[0]!, subjectId: "subject-other" }],
      }),
    ).toBe(false);
  });

  test("does not select a deleted default from a stale grant after access refresh fails", () => {
    const available = workspace("workspace-available");
    expect(
      resolveLandingWorkspaceId({
        rememberedWorkspaceId: "workspace-deleted",
        workspaces: [available],
        accessContext: accessContext({
          workspaceIds: ["workspace-deleted", available.id],
          defaultWorkspaceId: "workspace-deleted",
        }),
      }),
    ).toBe(available.id);
  });

  test("returns no landing target when only one-sided workspace evidence remains", () => {
    const listed = workspace("workspace-listed");
    expect(
      resolveLandingWorkspaceId({
        requestedWorkspaceId: "workspace-granted-only",
        rememberedWorkspaceId: listed.id,
        workspaces: [listed],
        accessContext: accessContext({
          workspaceIds: ["workspace-granted-only"],
          defaultWorkspaceId: "workspace-granted-only",
        }),
      }),
    ).toBeNull();
  });
});
