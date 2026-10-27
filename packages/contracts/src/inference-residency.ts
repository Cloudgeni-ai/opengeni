import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * An organization's EU-only inference setting. When on, every model call for
 * its workspaces runs on an EU route or not at all. Any member can read it;
 * owners and admins can turn it on, and only an owner or admin in the app in a
 * browser can turn it off. See docs/organization-tenancy.md.
 */
export const OrganizationInferenceResidency = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    euOnly: primitives.boolean,
    /** 0 until the setting is first changed. */
    version: primitives.nonnegativeInteger,
    updatedAt: primitives.string.datetime({ offset: true }).nullable(),
    /** Whether the caller may turn EU-only off: only an owner or admin in a browser. */
    canTurnOff: primitives.boolean,
    changed: primitives.optionalBoolean,
  }),
);
export type OrganizationInferenceResidency = z.infer<typeof OrganizationInferenceResidency>;

export const UpdateOrganizationInferenceResidencyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      euOnly: primitives.boolean,
      expectedVersion: primitives.nonnegativeInteger,
      operationId: primitives.uuid,
    })
    .strict(),
);
export type UpdateOrganizationInferenceResidencyRequest = z.infer<
  typeof UpdateOrganizationInferenceResidencyRequest
>;
