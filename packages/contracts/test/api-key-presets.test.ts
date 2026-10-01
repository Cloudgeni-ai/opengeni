import { describe, expect, test } from "bun:test";
import { DEVELOPER_SETUP_API_KEY_PRESET, OrganizationApiKeyPreset } from "../src/api-key-presets";
import { Permission } from "../src/permissions";

describe("Developer setup API key preset", () => {
  test("pins the exact current route floor, not all permissions or redundant wildcard scopes", () => {
    expect(DEVELOPER_SETUP_API_KEY_PRESET).toMatchObject({
      id: "developer_setup",
      label: "Developer setup",
      defaultExpiryHours: 24,
      permissions: ["workspace:create", "workspace:admin", "api_keys:manage"],
    });
    for (const permission of DEVELOPER_SETUP_API_KEY_PRESET.permissions) {
      expect(Permission.safeParse(permission).success).toBe(true);
    }
    expect(new Set(DEVELOPER_SETUP_API_KEY_PRESET.permissions).size).toBe(3);
    expect(DEVELOPER_SETUP_API_KEY_PRESET.permissions.length).toBeLessThan(
      Permission.options.length,
    );
    expect(DEVELOPER_SETUP_API_KEY_PRESET.description).toContain("broad workspace administration");
  });

  test("does not accept all-permissions or arbitrary preset fallback", () => {
    expect(OrganizationApiKeyPreset.parse("developer_setup")).toBe("developer_setup");
    expect(OrganizationApiKeyPreset.safeParse("all_permissions").success).toBe(false);
    expect(OrganizationApiKeyPreset.safeParse("custom").success).toBe(false);
  });
});
