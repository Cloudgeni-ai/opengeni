import { defineSchema } from "./define-schema";
import { z } from "zod";

/** Canonical public permission vocabulary shared by operational and control-plane contracts. */
export const Permission = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "account:read",
    "account:admin",
    "members:manage",
    "workspace:create",
    "billing:read",
    "billing:manage",
    "workspace:read",
    "workspace:admin",
    "sessions:create",
    "sessions:read",
    "sessions:control",
    "stream:view",
    "stream:control",
    "stream:acknowledge",
    "files:upload",
    "files:read",
    "files:write",
    "terminal:attach",
    "documents:manage",
    "documents:search",
    "scheduled_tasks:manage",
    "scheduled_tasks:run",
    "github:manage",
    "github:use",
    "api_keys:manage",
    /** Literal organization-key authority to configure workspace usage allowances. */
    "usage_allowances:manage",
    "connections:read",
    "connections:write",
    "capabilities:manage",
    /** @deprecated alias of secrets:write */
    "environments:manage",
    /** @deprecated alias of secrets:use */
    "environments:use",
    /** @deprecated alias of secrets:list */
    "variable-sets:list",
    /** @deprecated alias of secrets:list */
    "variable-sets:read",
    /** @deprecated alias of secrets:write */
    "variable-sets:write",
    /** @deprecated alias of secrets:write */
    "variable-sets:manage",
    /** @deprecated alias of secrets:use */
    "variable-sets:attach",
    /** @deprecated alias of secrets:use */
    "variable-sets:use",
    "secrets:list",
    /** Literal plaintext read through a tool or API key (agents lack it by default). */
    "secrets:read",
    "secrets:write",
    /** Use secrets by reference; for humans, also reveal ("use = reveal"). */
    "secrets:use",
    "mcp_servers:attach",
    "codemode:call",
    "goals:manage",
    "enrollments:read",
    "enrollments:manage",
    "rigs:use",
    "rigs:manage",
    "artifacts:read",
    "artifacts:publish",
  ]),
);
export type Permission = z.infer<typeof Permission>;

/**
 * Legacy permission names and their secrets equivalents (Q-16). Stored role
 * and API-key permission arrays are aliased at read time, never rewritten.
 */
export const SECRET_PERMISSION_ALIASES = {
  "variable-sets:list": "secrets:list",
  "variable-sets:read": "secrets:list",
  "variable-sets:write": "secrets:write",
  "variable-sets:manage": "secrets:write",
  "environments:manage": "secrets:write",
  "variable-sets:attach": "secrets:use",
  "variable-sets:use": "secrets:use",
  "environments:use": "secrets:use",
} as const satisfies Readonly<Partial<Record<Permission, Permission>>>;

/** Canonical name for a permission: legacy variable-set names map to `secrets:*`. */
export function normalizePermission(name: string): string {
  return Object.hasOwn(SECRET_PERMISSION_ALIASES, name)
    ? SECRET_PERMISSION_ALIASES[name as keyof typeof SECRET_PERMISSION_ALIASES]
    : name;
}
