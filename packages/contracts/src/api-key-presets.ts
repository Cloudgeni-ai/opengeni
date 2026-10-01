import { z } from "zod";
import type { Permission } from "./permissions";

/** A creation preset, not a new authorization tier or a stored key attribute. */
export const OrganizationApiKeyPreset = z.enum(["developer_setup"]);
export type OrganizationApiKeyPreset = z.infer<typeof OrganizationApiKeyPreset>;

/**
 * The current setup-route floor: workspace provisioning, configuration/cleanup,
 * and the literal key-management permission required by organization budget
 * writes. workspace:admin also covers workspace discovery and session/tool/
 * schedule guards. It is broad authority, not setup-only, and never confers
 * literal secrets:read. No account:admin, billing, or redundant read scopes.
 */
export const DEVELOPER_SETUP_API_KEY_PRESET = {
  id: "developer_setup",
  label: "Developer setup",
  description:
    "Set up shared workspaces, tools and budgets. Includes broad workspace administration and expires after 24 hours.",
  permissions: ["workspace:create", "workspace:admin", "api_keys:manage"] satisfies Permission[],
  defaultExpiryHours: 24,
} as const;
