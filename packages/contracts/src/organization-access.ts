import { z } from "zod";
import { Permission } from "./permissions";

export const OrganizationAccessPreset = z.enum(["read_only", "full", "custom"]);
export type OrganizationAccessPreset = z.infer<typeof OrganizationAccessPreset>;

export const OrganizationWorkspaceScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({
      kind: z.literal("selected"),
      workspaceIds: z
        .array(
          z
            .string()
            .uuid()
            .transform((id) => id.toLowerCase()),
        )
        .max(500)
        .refine((ids) => new Set(ids).size === ids.length, "Workspace IDs must be unique"),
    })
    .strict(),
]);
export type OrganizationWorkspaceScope = z.infer<typeof OrganizationWorkspaceScope>;

export const OrganizationActor = z.enum(["user", "organization"]);
export type OrganizationActor = z.infer<typeof OrganizationActor>;

const aliases: Partial<Record<Permission, Permission>> = {
  "environments:manage": "variable-sets:manage",
  "environments:use": "variable-sets:use",
};
// Computed on first use, never at module load: the web build can place
// `Permission` in a chunk that finishes initializing after this one, and a
// top-level read of `Permission.options` then crashes the whole app.
let permissionSets:
  | { canonical: Permission[]; observational: Permission[]; readOnly: Permission[] }
  | undefined;
function sets() {
  if (permissionSets) return permissionSets;
  const canonical = Permission.options.filter((permission) => !aliases[permission]);
  /** Everything that only observes. Reading secret values observes too. */
  const observational = canonical.filter((permission) =>
    /:(read|list|view|search)$/.test(permission),
  );
  /** Secret values are opt-in: Read only leaves them out, Custom can add them. */
  const secretValue = new Set<Permission>(["secrets:read", "variable-sets:read"]);
  const readOnly = observational.filter((permission) => !secretValue.has(permission));
  permissionSets = { canonical, observational, readOnly };
  return permissionSets;
}

/** Custom has no implicit permissions. Presets are expanded only by this helper. */
export function organizationAccessPresetPermissions(
  preset: OrganizationAccessPreset,
): Permission[] {
  return preset === "full"
    ? [...sets().canonical]
    : preset === "read_only"
      ? [...sets().readOnly]
      : [];
}

/** True when nothing can be changed, including an empty set and secret-value reads. */
export function isReadOnlyPermissionSet(permissions: readonly Permission[]): boolean {
  return permissions.every((permission) =>
    sets().observational.includes(aliases[permission] ?? permission),
  );
}

const OrganizationAccessPolicyInput = z
  .object({
    preset: OrganizationAccessPreset,
    // Lazy for the same module-order reason as `sets()` above.
    permissions: z.array(z.lazy(() => Permission)),
    workspaceScope: OrganizationWorkspaceScope,
  })
  .strict();

export type OrganizationAccessPolicy = z.infer<typeof OrganizationAccessPolicyInput>;

/** Canonical ordering, alias mapping and labels; never adds an unrequested grant. */
export function normalizeOrganizationAccessPolicy(
  policy: OrganizationAccessPolicy,
): OrganizationAccessPolicy {
  const parsed = OrganizationAccessPolicyInput.parse(policy);
  const requested = new Set(
    parsed.permissions.map((permission) => aliases[permission] ?? permission),
  );
  const { canonical, readOnly } = sets();
  const permissions = canonical.filter((permission) => requested.has(permission));
  const same = (candidate: readonly Permission[]) =>
    candidate.length === permissions.length &&
    candidate.every((permission) => requested.has(permission));
  return {
    preset: same(canonical) ? "full" : same(readOnly) ? "read_only" : "custom",
    permissions,
    workspaceScope:
      parsed.workspaceScope.kind === "selected"
        ? { kind: "selected", workspaceIds: [...parsed.workspaceScope.workspaceIds].sort() }
        : { kind: "all" },
  };
}

export const OrganizationAccessPolicy = OrganizationAccessPolicyInput.transform(
  normalizeOrganizationAccessPolicy,
);

/* ----------------------------------------------------------------------------
   Service accounts: an organization identity with no person behind it. It
   holds organization API keys; its role caps what those keys can be given.
   Up to admin, never owner.
   -------------------------------------------------------------------------- */

export const OrganizationServiceAccountRole = z.enum(["admin", "member"]);
export type OrganizationServiceAccountRole = z.infer<typeof OrganizationServiceAccountRole>;

/** What only an organization administrator can do; a member service account's keys never hold it. */
export const ORGANIZATION_ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  "account:admin",
  "members:manage",
  "billing:manage",
  "api_keys:manage",
  "usage_allowances:manage",
];

/** The permissions a service account's keys may hold, given its role. */
export function serviceAccountAllowsPermission(
  role: OrganizationServiceAccountRole,
  permission: Permission,
): boolean {
  return role === "admin" || !ORGANIZATION_ADMIN_ONLY_PERMISSIONS.includes(permission);
}

export const OrganizationServiceAccount = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  role: OrganizationServiceAccountRole,
  /** Keys that are not revoked, including expired ones. */
  activeKeyCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrganizationServiceAccount = z.infer<typeof OrganizationServiceAccount>;

export const ListOrganizationServiceAccountsResponse = z.object({
  serviceAccounts: z.array(OrganizationServiceAccount),
});
export type ListOrganizationServiceAccountsResponse = z.infer<
  typeof ListOrganizationServiceAccountsResponse
>;

export const CreateOrganizationServiceAccountRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(500).optional(),
    role: OrganizationServiceAccountRole.default("member"),
  })
  .strict();
export type CreateOrganizationServiceAccountRequest = z.infer<
  typeof CreateOrganizationServiceAccountRequest
>;

export const UpdateOrganizationServiceAccountRequest = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
    role: OrganizationServiceAccountRole.optional(),
  })
  .strict()
  .refine((request) => Object.keys(request).length > 0, "At least one change is required");
export type UpdateOrganizationServiceAccountRequest = z.infer<
  typeof UpdateOrganizationServiceAccountRequest
>;
