import { describe, expect, test } from "bun:test";

import {
  workspaceManagementLocation,
  workspaceSettingsSectionFromSearch,
} from "./workspace-settings-shell";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const base = `/workspaces/${workspaceId}`;

describe("workspace management navigation", () => {
  test("keeps settings and management destinations in one shell", () => {
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId, "api-keys")).toEqual({
      kind: "settings",
      section: "api-keys",
    });

    for (const route of [
      "agents",
      "insights",
      "documents",
      "memory",
      "state",
      "variable-sets",
      "rigs",
      "machines",
    ]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).not.toBeNull();
    }

    expect(workspaceManagementLocation(`${base}/rigs/rig-123`, workspaceId)).toEqual({
      kind: "page",
      target: "/workspaces/$workspaceId/rigs",
    });
  });

  test("does not absorb ordinary workspace routes into management", () => {
    for (const route of ["sessions", "plugins", "schedules", "artifacts", "priority"]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).toBeNull();
    }
  });

  test("normalizes unknown and legacy settings searches to General", () => {
    expect(workspaceSettingsSectionFromSearch(undefined)).toBe("general");
    expect(workspaceSettingsSectionFromSearch("permissions")).toBe("general");
    expect(workspaceSettingsSectionFromSearch("models")).toBe("models");
  });
});
