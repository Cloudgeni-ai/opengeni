import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const CanonicalHumanIdentityStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "recovery_required", "disputed", "disabled"]),
);
export type CanonicalHumanIdentityStatus = z.infer<typeof CanonicalHumanIdentityStatus>;

export const CanonicalHumanLoginBindingStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "recovery_pending", "stale", "disputed", "revoked"]),
);
export type CanonicalHumanLoginBindingStatus = z.infer<typeof CanonicalHumanLoginBindingStatus>;

export const CanonicalHumanRecoveryState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["ready", "recovery_required", "lost_factor", "disputed", "disabled"]),
);
export type CanonicalHumanRecoveryState = z.infer<typeof CanonicalHumanRecoveryState>;

export const CanonicalHumanLoginBinding = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    providerId: z.string().min(1).max(128),
    providerAccountId: z.string().min(1).max(1024),
    status: CanonicalHumanLoginBindingStatus,
    revision: primitives.positiveInteger,
    verifiedAt: primitives.dateTime,
    lastVerifiedAt: primitives.dateTime,
    revokedAt: z.string().datetime().nullable(),
    createdAt: primitives.dateTime,
    updatedAt: primitives.dateTime,
  }),
);
export type CanonicalHumanLoginBinding = z.infer<typeof CanonicalHumanLoginBinding>;

export const CanonicalHumanIdentityProjection = /* @__PURE__ */ defineSchema(() =>
  z.object({
    activeIdentity: z.object({
      id: primitives.uuid,
      displayName: z.string().min(1).max(256),
      status: CanonicalHumanIdentityStatus,
      identityRevision: primitives.positiveInteger,
      authRevision: primitives.positiveInteger,
      activeLoginBindingId: primitives.nullableUuid,
      recoveryState: CanonicalHumanRecoveryState,
      createdAt: primitives.dateTime,
      updatedAt: primitives.dateTime,
    }),
    loginBindings: z.array(CanonicalHumanLoginBinding).max(64),
  }),
);
export type CanonicalHumanIdentityProjection = z.infer<typeof CanonicalHumanIdentityProjection>;

const OperationFields = {
  operationId: primitives.optionalUuid,
  expectedIdentityRevision: primitives.positiveInteger,
  reason: primitives.string.trim().min(1).max(512),
} as const;

export const LinkCanonicalHumanLoginBindingRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...OperationFields,
    providerId: primitives.string.trim().min(1).max(128),
    providerAccountId: primitives.string.trim().min(1).max(1024),
  }),
);
export type LinkCanonicalHumanLoginBindingRequest = z.infer<
  typeof LinkCanonicalHumanLoginBindingRequest
>;

export const CanonicalHumanBindingOperationRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...OperationFields,
  }),
);
export type CanonicalHumanBindingOperationRequest = z.infer<
  typeof CanonicalHumanBindingOperationRequest
>;

export const CanonicalHumanIdentityMutationOutcome = /* @__PURE__ */ defineSchema(() =>
  z.enum(["applied", "lost_factor", "disputed"]),
);
export type CanonicalHumanIdentityMutationOutcome = z.infer<
  typeof CanonicalHumanIdentityMutationOutcome
>;

export const CanonicalHumanIdentityMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    outcome: CanonicalHumanIdentityMutationOutcome,
    operationId: primitives.uuid,
    identity: CanonicalHumanIdentityProjection,
  }),
);
export type CanonicalHumanIdentityMutationResponse = z.infer<
  typeof CanonicalHumanIdentityMutationResponse
>;
