import { defineSchema } from "./define-schema";
import { z } from "zod";

export const ManagedSignInProvider = /* @__PURE__ */ defineSchema(() =>
  z.enum(["google", "github"]),
);
export const ManagedSignInMethods = /* @__PURE__ */ defineSchema(() =>
  z.object({
    identityId: z.string().uuid(),
    email: z.string().email(),
    emailVerified: z.boolean(),
    identityRevision: z.number().int().positive(),
    freshAuthenticationRequired: z.boolean(),
    methods: z.array(
      z.object({
        provider: z.enum(["credential", "google", "github"]),
        connected: z.boolean(),
        available: z.boolean(),
        canDisconnect: z.boolean(),
        implicitRelinkingSuppressed: z.boolean(),
      }),
    ),
  }),
);
export type ManagedSignInMethods = z.infer<typeof ManagedSignInMethods>;
export const ManagedSignInMutation = /* @__PURE__ */ defineSchema(() =>
  z.object({
    expectedIdentityId: z.string().uuid(),
    operationId: z.string().uuid(),
    expectedIdentityRevision: z.number().int().positive(),
  }),
);
export const ManagedSignInProviderMutation = /* @__PURE__ */ defineSchema(() =>
  ManagedSignInMutation.extend({
    provider: ManagedSignInProvider,
  }).strict(),
);
export const ManagedSignInPasswordMutation = /* @__PURE__ */ defineSchema(() =>
  ManagedSignInMutation.extend({
    newPassword: z.string().min(8).max(128),
    currentPassword: z.string().min(1).max(1024).optional(),
  }).strict(),
);
export const ManagedSignInMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    reauthenticationRequired: z.literal(true),
    notification: z.enum(["sent", "failed", "outcome_unknown"]),
  }),
);
export const ManagedSignInConnectResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ url: z.string().url() }),
);
