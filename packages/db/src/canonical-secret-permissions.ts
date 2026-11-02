import { normalizePermission, type Permission } from "@opengeni/contracts";

/**
 * For new mutable settings, grants and newly accepted scheduled runs (whose
 * generated chat stores the canonical names); never rewrite accepted snapshots.
 */
export function canonicalSecretPermissions(permissions: readonly Permission[]): Permission[] {
  return [
    ...new Set(permissions.map((permission) => normalizePermission(permission) as Permission)),
  ];
}
