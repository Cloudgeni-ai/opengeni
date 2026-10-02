import { describe, expect, test } from "bun:test";
import { Permission } from "@opengeni/contracts";

import {
  WORKSPACE_KEY_PERMISSION_GROUPS,
  accessLabel,
  apiKeyPresets,
  apiKeyStatus,
  expiryDate,
  isWorkspaceKeyPermission,
  keyDateLabel,
  permissionLabel,
  presetById,
  presetFor,
} from "./api-key-presets";

describe("workspace API key presets", () => {
  test("every workspace-level permission is offered exactly once, with a human label", () => {
    const offered = WORKSPACE_KEY_PERMISSION_GROUPS.flatMap((group) => [...group.permissions]);
    expect(new Set(offered).size).toBe(offered.length);
    const expected = Permission.options.filter(isWorkspaceKeyPermission);
    expect([...offered].sort()).toEqual([...expected].sort());
    for (const permission of offered) expect(permissionLabel(permission)).not.toBe(permission);
  });

  test("no preset carries an organization scope", () => {
    for (const preset of apiKeyPresets()) {
      for (const permission of preset.permissions) {
        expect(isWorkspaceKeyPermission(permission)).toBe(true);
      }
    }
  });

  test("All permissions is exactly the supported workspace set, distinct from automation", () => {
    const all = presetById("all_permissions");
    expect([...all.permissions].sort()).toEqual(
      Permission.options.filter(isWorkspaceKeyPermission).sort(),
    );
    expect(presetFor([...all.permissions].reverse())).toBe("all_permissions");
    expect(accessLabel(all.permissions)).toBe("All permissions");
    for (const permission of [
      "workspace:admin",
      "members:manage",
      "api_keys:manage",
      "secrets:read",
      "variable-sets:read",
    ]) {
      expect(all.permissions).toContain(permission);
      expect(presetById("full_automation").permissions).not.toContain(permission);
    }
  });

  test("recognises a preset by its exact permissions, otherwise Custom", () => {
    const run = apiKeyPresets().find((preset) => preset.id === "run_sessions")!;
    expect(presetFor([...run.permissions].reverse())).toBe("run_sessions");
    expect(accessLabel(run.permissions)).toBe("Run sessions");
    expect(presetFor(["sessions:read"])).toBe("custom");
    expect(accessLabel(["sessions:read", "files:read"])).toBe("Custom · 2 permissions");
  });

  test("a key past its expiry is Expired, and revoked wins", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    expect(apiKeyStatus({ expiresAt: null, revokedAt: null }, now)).toBe("active");
    expect(apiKeyStatus({ expiresAt: "2027-03-31T00:00:00Z", revokedAt: null }, now)).toBe(
      "active",
    );
    expect(apiKeyStatus({ expiresAt: "2026-09-20T00:00:00Z", revokedAt: null }, now)).toBe(
      "expired",
    );
    expect(
      apiKeyStatus({ expiresAt: "2026-09-20T00:00:00Z", revokedAt: "2026-08-12T00:00:00Z" }, now),
    ).toBe("revoked");
  });

  test("expiry choices count from now", () => {
    const now = new Date(2026, 8, 27, 12);
    expect(expiryDate("never", now)).toBeNull();
    expect(keyDateLabel(expiryDate("30d", now)!)).toBe("27 Oct 2026");
    expect(keyDateLabel(expiryDate("90d", now)!)).toBe("26 Dec 2026");
    expect(keyDateLabel(expiryDate("1y", now)!)).toBe("27 Sep 2027");
  });
});
