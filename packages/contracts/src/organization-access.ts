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
const canonicalPermissions = Permission.options.filter((permission) => !aliases[permission]);
/** Everything that only observes. Reading secret values observes too. */
const observationalPermissions = canonicalPermissions.filter((permission) =>
  /:(read|list|view|search)$/.test(permission),
);
/** Secret values are opt-in: Read only leaves them out, Custom can add them. */
const secretValuePermissions = new Set<Permission>(["secrets:read", "variable-sets:read"]);
const readOnlyPermissions = observationalPermissions.filter(
  (permission) => !secretValuePermissions.has(permission),
);

/** Custom has no implicit permissions. Presets are expanded only by this helper. */
export function organizationAccessPresetPermissions(
  preset: OrganizationAccessPreset,
): Permission[] {
  return preset === "full"
    ? [...canonicalPermissions]
    : preset === "read_only"
      ? [...readOnlyPermissions]
      : [];
}

/** True when nothing can be changed, including an empty set and secret-value reads. */
export function isReadOnlyPermissionSet(permissions: readonly Permission[]): boolean {
  return permissions.every((permission) =>
    observationalPermissions.includes(aliases[permission] ?? permission),
  );
}

const OrganizationAccessPolicyInput = z
  .object({
    preset: OrganizationAccessPreset,
    permissions: z.array(Permission),
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
  const permissions = canonicalPermissions.filter((permission) => requested.has(permission));
  const same = (candidate: readonly Permission[]) =>
    candidate.length === permissions.length &&
    candidate.every((permission) => requested.has(permission));
  return {
    preset: same(canonicalPermissions)
      ? "full"
      : same(readOnlyPermissions)
        ? "read_only"
        : "custom",
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
