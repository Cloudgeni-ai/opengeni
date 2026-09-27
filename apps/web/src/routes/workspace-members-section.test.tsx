import { describe, expect, test } from "bun:test";

import { workspaceAccessLevels } from "@/lib/permissions";

import {
  initialsOf,
  toAccessMember,
  workspaceRoleLabel,
  workspaceRoleOf,
} from "./workspace-members-section";

const viewer = workspaceAccessLevels.find((level) => level.role === "viewer")!;

describe("workspace access rows", () => {
  test("an owner grant reads as Owner, never as custom access", () => {
    const owner = {
      subjectId: "dev",
      subjectLabel: "Local dev",
      role: "owner",
      permissions: ["workspace:read", "workspace:admin", "billing:manage"],
      createdAt: "2026-08-10T12:00:00.000Z",
    };
    expect(workspaceRoleOf(owner)).toEqual({ role: "owner" });
    expect(workspaceRoleLabel(owner)).toBe("Owner");
    const row = toAccessMember(owner, "dev");
    expect(row.isOwner).toBe(true);
    expect(row.isYou).toBe(true);
    expect(row.roleLockedReason).toBeTruthy();
  });

  test("a named role with hand-picked permissions is custom and can go back to its role", () => {
    const edited = { role: "viewer", permissions: [...viewer.permissions, "sessions:create"] };
    expect(workspaceRoleOf(edited)).toEqual({ role: "custom", resetRole: "viewer" });
    expect(workspaceRoleLabel(edited)).toBe("Custom (set via API)");
    expect(workspaceRoleOf({ role: "viewer", permissions: [...viewer.permissions] })).toEqual({
      role: "viewer",
    });
  });

  test("names and initials fall back to the subject", () => {
    const row = toAccessMember(
      {
        subjectId: "service:ci-bot",
        subjectLabel: null,
        role: "member",
        permissions: [],
        createdAt: "2026-08-10T12:00:00.000Z",
      },
      "user:someone",
    );
    expect(row.name).toBe("ci-bot");
    expect(row.kind).toBe("service");
    expect(initialsOf("Maria Chen")).toBe("MC");
    expect(initialsOf("owner@example.com")).toBe("OW");
  });
});
