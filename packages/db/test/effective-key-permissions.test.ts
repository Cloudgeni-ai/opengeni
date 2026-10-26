import { expect, test } from "bun:test";
import { effectiveKeyPermissions } from "../src/organization-service-accounts";

test("an explicit key with connections:write shows connections:personal, as enforcement allows", () => {
  const permissions = effectiveKeyPermissions({
    permissions: ["workspace:read", "connections:write"],
    permissionMode: "explicit",
  });
  expect(permissions).toContain("connections:personal");
  expect(permissions).toContain("connections:write");
  expect(permissions).not.toContain("capabilities:manage");
});

test("connections:personal alone never shows connections:write", () => {
  expect(
    effectiveKeyPermissions({
      permissions: ["workspace:read", "connections:personal"],
      permissionMode: "explicit",
    }),
  ).toEqual(["workspace:read", "connections:personal"]);
});
