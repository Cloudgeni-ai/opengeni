import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { hasLiteralPermission, hasPermission, requireLiteralPermission } from "../src/access";

const grant = (permissions: AccessGrant["permissions"]): AccessGrant => ({
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "subject",
  permissions,
});

describe("literal high-trust permissions", () => {
  test("workspace:admin remains an ordinary wildcard but cannot manufacture secrets:read", () => {
    const admin = grant(["workspace:admin"]);
    expect(hasPermission(admin.permissions, "variable-sets:read")).toBe(true);
    expect(hasPermission(admin.permissions, "secrets:read")).toBe(false);
    expect(hasLiteralPermission(admin.permissions, "secrets:read")).toBe(false);
    expect(() => requireLiteralPermission(admin, "secrets:read")).toThrow(
      "missing literal permission: secrets:read",
    );
  });

  test("an explicit secrets:read grant passes the literal boundary", () => {
    const explicit = grant(["workspace:admin", "secrets:read"]);
    expect(hasLiteralPermission(explicit.permissions, "secrets:read")).toBe(true);
    expect(() => requireLiteralPermission(explicit, "secrets:read")).not.toThrow();
  });

  test("legacy scopes imply granular metadata and write scopes but never plaintext", () => {
    expect(hasPermission(["variable-sets:use"], "variable-sets:list")).toBe(true);
    expect(hasPermission(["variable-sets:use"], "variable-sets:read")).toBe(true);
    expect(hasPermission(["variable-sets:use"], "secrets:list")).toBe(true);
    expect(hasPermission(["variable-sets:use"], "variable-sets:write")).toBe(false);
    expect(hasPermission(["variable-sets:use"], "secrets:write")).toBe(false);

    expect(hasPermission(["variable-sets:manage"], "variable-sets:write")).toBe(true);
    expect(hasPermission(["variable-sets:manage"], "secrets:write")).toBe(true);
    expect(hasPermission(["variable-sets:manage"], "secrets:read")).toBe(false);
  });
});
