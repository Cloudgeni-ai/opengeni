import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/** Catalog identities, never endpoint/domain matching. Custom transports are explicit categories. */
export const OrganizationIntegrationKey = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/),
);
const keys = /* @__PURE__ */ defineSchema(() =>
  z
    .array(OrganizationIntegrationKey)
    .max(10000)
    .refine((values) => new Set(values).size === values.length, "Duplicate integration identities"),
);
/**
 * Who may turn on a reviewed OAuth integration for personal accounts (each
 * person then connects their own account): any member holding the personal
 * setup permission, or only integration admins. Admins are unaffected.
 */
export const PersonalIntegrationSetupPolicy = /* @__PURE__ */ defineSchema(() =>
  z.enum(["members", "admins"]),
);
export type PersonalIntegrationSetupPolicy = z.infer<typeof PersonalIntegrationSetupPolicy>;

export const OrganizationIntegrationPolicy = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      mode: z.enum(["unrestricted", "restricted"]).default("unrestricted"),
      allowedIntegrationKeys: keys.default([]),
      personalIntegrationSetup: PersonalIntegrationSetupPolicy.default("members"),
      revision: primitives.nonnegativeInteger.safe().default(0),
    })
    .strict(),
);
export type OrganizationIntegrationPolicy = z.infer<typeof OrganizationIntegrationPolicy>;

export const UpdateOrganizationIntegrationPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      mode: z.enum(["unrestricted", "restricted"]),
      allowedIntegrationKeys: keys,
      /** Omitted keeps the current setting. */
      personalIntegrationSetup: PersonalIntegrationSetupPolicy.optional(),
      expectedRevision: primitives.nonnegativeInteger.max(Number.MAX_SAFE_INTEGER - 1),
      operationId: primitives.uuid,
    })
    .strict(),
);
export type UpdateOrganizationIntegrationPolicyRequest = z.infer<
  typeof UpdateOrganizationIntegrationPolicyRequest
>;

export class OrganizationIntegrationDeniedError extends Error {
  constructor() {
    super("Integration acquisition is not allowed by organization policy");
    this.name = "OrganizationIntegrationDeniedError";
  }
}

/** integrationKey must come from trusted classification, not client-supplied metadata. */
export function assertOrganizationIntegrationAllowed(
  policy: OrganizationIntegrationPolicy,
  integrationKey: string | null,
): void {
  if (policy.mode === "unrestricted") return;
  if (integrationKey === null || !policy.allowedIntegrationKeys.includes(integrationKey)) {
    throw new OrganizationIntegrationDeniedError();
  }
}
