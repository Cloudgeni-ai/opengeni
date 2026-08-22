import { Permission as PermissionSchema, type Permission } from "@opengeni/contracts";

export function normalizeWorkspaceMembershipPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const parsed = PermissionSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}
