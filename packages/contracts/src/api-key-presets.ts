import { z } from "zod";
import type { Permission } from "./permissions";

/** Optional creation alias for the developer_setup organization access tier. */
export const OrganizationApiKeyPreset = z.enum(["developer_setup"]);
export type OrganizationApiKeyPreset = z.infer<typeof OrganizationApiKeyPreset>;

/**
 * The current setup-route floor: workspace provisioning, configuration/cleanup,
 * and explicit literal budget authority. workspace:admin also covers discovery and session/tool/
 * schedule guards. It is broad authority, not setup-only, and never confers
 * literal secrets:read. No account:admin, billing, or redundant read scopes.
 */
export const DEVELOPER_SETUP_API_KEY_PRESET = {
  id: "developer_setup",
  label: "Developer setup",
  description:
    "Set up shared workspaces, tools and budgets. Includes broad workspace administration and expires after 24 hours. Can't manage API keys.",
  permissions: [
    "workspace:create",
    "workspace:admin",
    "usage_allowances:manage",
  ] satisfies Permission[],
  defaultExpiryHours: 24,
} as const;
