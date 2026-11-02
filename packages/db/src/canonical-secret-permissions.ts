import { normalizePermission, type Permission } from "@opengeni/contracts";

/** For new mutable settings and grants only; never rewrite accepted snapshots. */
export function canonicalSecretPermissions(permissions: readonly Permission[]): Permission[] {
  return [
    ...new Set(permissions.map((permission) => normalizePermission(permission) as Permission)),
  ];
}
