import { describe, expect, test } from "bun:test";

import {
  workspaceManagementLocation,
  workspaceSettingsSectionFromSearch,
} from "./workspace-settings-shell";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const base = `/workspaces/${workspaceId}`;
const shellSource = await Bun.file(`${import.meta.dir}/workspace-settings-shell.tsx`).text();

describe("workspace management navigation", () => {
  test("keeps settings and management destinations in one shell", () => {
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId, "api-keys")).toEqual({
      kind: "settings",
      section: "api-keys",
    });

    for (const route of ["agents", "insights", "memory", "variable-sets", "rigs", "machines"]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).not.toBeNull();
    }

    expect(workspaceManagementLocation(`${base}/rigs/rig-123`, workspaceId)).toEqual({
      kind: "page",
      target: "/workspaces/$workspaceId/rigs",
    });
  });

  test("does not absorb ordinary workspace routes into management", () => {
    for (const route of [
      "sessions",
      "plugins",
      "documents",
      "state",
      "schedules",
      "artifacts",
      "priority",
    ]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).toBeNull();
    }
  });

  test("normalizes unknown and legacy settings searches to General", () => {
    expect(workspaceSettingsSectionFromSearch(undefined)).toBe("general");
    expect(workspaceSettingsSectionFromSearch("permissions")).toBe("general");
    expect(workspaceSettingsSectionFromSearch("models")).toBe("models");
  });

  test("keeps organization settings as quiet secondary navigation", () => {
    expect(shellSource).toContain('to="/workspaces/$workspaceId/organization"');
    expect(shellSource).toContain("Organization settings for ${organizationName}");
    expect(shellSource).toContain("Workspace settings");
    expect(shellSource).toContain("{organizationName}");
    expect(shellSource).not.toContain("Organization settings</span>");
  });
});
