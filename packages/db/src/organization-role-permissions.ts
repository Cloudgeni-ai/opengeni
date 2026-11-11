import type { Permission } from "@opengeni/contracts";

export const allAccountPermissions: Permission[] = [
  "account:read",
  "account:admin",
  "members:manage",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "api_keys:manage",
];

/** The account permissions an organization role holds, as access grants are built from it. */
export function accountPermissionsForOrganizationRole(
  role: "owner" | "admin" | "member",
): Permission[] {
  if (role === "owner") return allAccountPermissions;
  if (role === "admin") {
    return ["account:read", "members:manage", "workspace:create", "billing:read"];
  }
  return ["account:read"];
}
