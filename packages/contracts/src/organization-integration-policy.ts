import { z } from "zod";

/** Catalog identities, never endpoint/domain matching. Custom transports are explicit categories. */
export const OrganizationIntegrationKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);
const keys = z
  .array(OrganizationIntegrationKey)
  .max(10000)
  .refine((values) => new Set(values).size === values.length, "Duplicate integration identities");
export const OrganizationIntegrationPolicy = z
  .object({
    mode: z.enum(["unrestricted", "restricted"]).default("unrestricted"),
    allowedIntegrationKeys: keys.default([]),
    revision: z.number().int().nonnegative().safe().default(0),
  })
  .strict();
export type OrganizationIntegrationPolicy = z.infer<typeof OrganizationIntegrationPolicy>;

export const UpdateOrganizationIntegrationPolicyRequest = z
  .object({
    mode: z.enum(["unrestricted", "restricted"]),
    allowedIntegrationKeys: keys,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    operationId: z.string().uuid(),
  })
  .strict();
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
