import { describe, expect, test } from "bun:test";
import type { Rig } from "@/types";
import { activeSessionRigs, selectableSessionRigs } from "./rig-selectability";

function rig(id: string, scope: Rig["scope"], active: boolean): Rig {
  return {
    id,
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    scope,
    generation: 1,
    status: "active",
    name: id,
    description: null,
    createdBy: null,
    activeVersion: active
      ? {
          id: "33333333-3333-4333-8333-333333333333",
          rigId: id,
          version: 1,
          image: null,
          setupScript: null,
          checks: [],
          credentialHooks: [],
          defaultVariableSetIds: [],
          changelog: null,
          providerImages: {},
          createdBy: null,
          active: true,
          verificationStatus: "passed",
          createdAt: "2026-08-31T12:00:00.000Z",
        }
      : null,
    activeVersionHealth: null,
    versionCount: 1,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
  };
}

describe("Rig session selectability", () => {
  test("never offers inactive Rigs to create or restart pickers", () => {
    const workspaceActive = rig("workspace-active", "workspace", true);
    const workspaceInactive = rig("workspace-inactive", "workspace", false);
    const personalActive = rig("personal-active", "user", true);
    const personalInactive = rig("personal-inactive", "user", false);
    const rigs = [workspaceActive, workspaceInactive, personalActive, personalInactive];

    expect(activeSessionRigs(rigs).map((candidate) => candidate.id)).toEqual([
      workspaceActive.id,
      personalActive.id,
    ]);
    expect(selectableSessionRigs(rigs, false).map((candidate) => candidate.id)).toEqual([
      workspaceActive.id,
    ]);
    expect(selectableSessionRigs(rigs, true).map((candidate) => candidate.id)).toEqual([
      workspaceActive.id,
      personalActive.id,
    ]);
  });
});
