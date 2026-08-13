import { z } from "zod";

export const CanonicalHumanIdentityStatus = z.enum([
  "active",
  "recovery_required",
  "disputed",
  "disabled",
]);
export type CanonicalHumanIdentityStatus = z.infer<typeof CanonicalHumanIdentityStatus>;

export const CanonicalHumanLoginBindingStatus = z.enum([
  "active",
  "recovery_pending",
  "stale",
  "disputed",
  "revoked",
]);
export type CanonicalHumanLoginBindingStatus = z.infer<typeof CanonicalHumanLoginBindingStatus>;

export const CanonicalHumanRecoveryState = z.enum([
  "ready",
  "recovery_required",
  "lost_factor",
  "disputed",
  "disabled",
]);
export type CanonicalHumanRecoveryState = z.infer<typeof CanonicalHumanRecoveryState>;

export const CanonicalHumanLoginBinding = z.object({
  id: z.string().uuid(),
  providerId: z.string().min(1).max(128),
  providerAccountId: z.string().min(1).max(1024),
  status: CanonicalHumanLoginBindingStatus,
  revision: z.number().int().positive(),
  verifiedAt: z.string().datetime(),
  lastVerifiedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CanonicalHumanLoginBinding = z.infer<typeof CanonicalHumanLoginBinding>;

export const CanonicalHumanIdentityProjection = z.object({
  activeIdentity: z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1).max(256),
    status: CanonicalHumanIdentityStatus,
    identityRevision: z.number().int().positive(),
    authRevision: z.number().int().positive(),
    activeLoginBindingId: z.string().uuid().nullable(),
    recoveryState: CanonicalHumanRecoveryState,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  loginBindings: z.array(CanonicalHumanLoginBinding).max(64),
});
export type CanonicalHumanIdentityProjection = z.infer<typeof CanonicalHumanIdentityProjection>;

const OperationFields = {
  operationId: z.string().uuid().optional(),
  expectedIdentityRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(512),
} as const;

export const LinkCanonicalHumanLoginBindingRequest = z.object({
  ...OperationFields,
  providerId: z.string().trim().min(1).max(128),
  providerAccountId: z.string().trim().min(1).max(1024),
});
export type LinkCanonicalHumanLoginBindingRequest = z.infer<
  typeof LinkCanonicalHumanLoginBindingRequest
>;

export const CanonicalHumanBindingOperationRequest = z.object({
  ...OperationFields,
});
export type CanonicalHumanBindingOperationRequest = z.infer<
  typeof CanonicalHumanBindingOperationRequest
>;

export const CanonicalHumanIdentityMutationOutcome = z.enum(["applied", "lost_factor", "disputed"]);
export type CanonicalHumanIdentityMutationOutcome = z.infer<
  typeof CanonicalHumanIdentityMutationOutcome
>;

export const CanonicalHumanIdentityMutationResponse = z.object({
  outcome: CanonicalHumanIdentityMutationOutcome,
  operationId: z.string().uuid(),
  identity: CanonicalHumanIdentityProjection,
});
export type CanonicalHumanIdentityMutationResponse = z.infer<
  typeof CanonicalHumanIdentityMutationResponse
>;
