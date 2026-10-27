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

/**
 * Model-backed features besides the chat model. Under EU-only inference each
 * one runs only on a route whose residency record is EU, and is switched off
 * where the deployment has none. See docs/eu-only-inference.md#side-features.
 */
export const INFERENCE_FEATURE_IDS = [
  "web_search",
  "image_generation",
  "video_generation",
  "realtime_voice",
  "voice_input",
  "meeting_transcription",
  "knowledge_embeddings",
  "code_search",
] as const;
export const InferenceFeatureId = /* @__PURE__ */ defineSchema(() => z.enum(INFERENCE_FEATURE_IDS));
export type InferenceFeatureId = z.infer<typeof InferenceFeatureId>;

/**
 * Why the server switched a feature off. `region_restricted`: the workspace
 * is EU-only and the feature has no EU route here; clients show "Not
 * supported in EU". The same code appears in every availability field that
 * reports such a feature (model availability, realtime voice models, agent
 * capabilities, Knowledge search fallbacks).
 */
export const REGION_RESTRICTED = "region_restricted" as const;
export const FeatureUnavailableReason = /* @__PURE__ */ defineSchema(() =>
  z.enum([REGION_RESTRICTED]),
);
export type FeatureUnavailableReason = z.infer<typeof FeatureUnavailableReason>;

/** One feature's availability for the caller's workspace. */
export const InferenceFeatureAvailability = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: InferenceFeatureId,
      available: primitives.boolean,
      unavailableReason: FeatureUnavailableReason.nullable(),
    })
    .strict(),
);
export type InferenceFeatureAvailability = z.infer<typeof InferenceFeatureAvailability>;

/** User-facing text for a `region_restricted` feature. */
export const REGION_RESTRICTED_MESSAGE = "Not supported in EU";
