import { z } from "zod";

export const MANAGED_AUTH_SESSION_SET_MAX_SLOTS = 8 as const;
export const MANAGED_AUTH_TRANSACTION_TTL_SECONDS = 600 as const;
export const MANAGED_AUTH_RETURN_INTENT_MAX_BYTES = 2_048 as const;
export const MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER = "x-opengeni-api-contract" as const;
export const MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION =
  "2026-08-personal-only-organization-setup-v1" as const;

export const ManagedAuthSessionSetMode = z.enum(["legacy", "dual", "broker"]);
export type ManagedAuthSessionSetMode = z.infer<typeof ManagedAuthSessionSetMode>;

export const ManagedAuthLoginSlotState = z.enum(["active", "reauth_required"]);
export type ManagedAuthLoginSlotState = z.infer<typeof ManagedAuthLoginSlotState>;

export const ManagedAuthVerifiedClaim = z.object({
  kind: z.literal("email"),
  value: z.string().email().max(320),
});
export type ManagedAuthVerifiedClaim = z.infer<typeof ManagedAuthVerifiedClaim>;

/** Secret-free, browser-safe summary. Provider session ids and tokens never enter this shape. */
export const ManagedAuthLoginSlot = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(256),
  verifiedClaim: ManagedAuthVerifiedClaim,
  state: ManagedAuthLoginSlotState,
});
export type ManagedAuthLoginSlot = z.infer<typeof ManagedAuthLoginSlot>;

export const ManagedAuthSessionSetState = z.enum(["ready", "actor_change_required"]);
export type ManagedAuthSessionSetState = z.infer<typeof ManagedAuthSessionSetState>;

export const ManagedAuthSessionSetProjection = z.object({
  mode: ManagedAuthSessionSetMode,
  generation: z.string().regex(/^[1-9][0-9]*$/),
  actorEpoch: z.string().regex(/^[1-9][0-9]*$/),
  csrfToken: z.string().min(32).max(512),
  selectedSlotId: z.string().uuid().nullable(),
  state: ManagedAuthSessionSetState,
  slots: z.array(ManagedAuthLoginSlot).max(MANAGED_AUTH_SESSION_SET_MAX_SLOTS),
});
export type ManagedAuthSessionSetProjection = z.infer<typeof ManagedAuthSessionSetProjection>;

export const ManagedAuthOperationIdentity = z.object({
  operationId: z.string().uuid(),
  expectedGeneration: z.string().regex(/^[1-9][0-9]*$/),
});
export type ManagedAuthOperationIdentity = z.infer<typeof ManagedAuthOperationIdentity>;

export const BootstrapManagedAuthSessionSetRequest = ManagedAuthOperationIdentity;
export type BootstrapManagedAuthSessionSetRequest = z.infer<
  typeof BootstrapManagedAuthSessionSetRequest
>;

export const ManagedAuthReturnIntent = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > MANAGED_AUTH_RETURN_INTENT_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "return intent exceeds its UTF-8 byte limit" });
    }
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("?") ||
      value.includes("#") ||
      /[\u0000-\u001f\u007f\\]/.test(value)
    ) {
      context.addIssue({
        code: "custom",
        message: "return intent must be a safe same-origin path",
      });
      return;
    }
    try {
      const parsed = new URL(value, "https://opengeni.invalid");
      const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
      const supportedPath = new RegExp(
        `^/(?:sessions/${uuid}|workspaces/${uuid}(?:/sessions(?:/${uuid})?)?)$`,
        "i",
      );
      if (
        parsed.origin !== "https://opengeni.invalid" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !supportedPath.test(value) ||
        parsed.pathname !== value
      ) {
        context.addIssue({
          code: "custom",
          message: "return intent contains unsafe authority data",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "return intent is not a valid same-origin path",
      });
    }
  });

export const BeginManagedAuthLoginTransactionRequest = ManagedAuthOperationIdentity.extend({
  kind: z.enum(["add", "reauth"]),
  slotId: z.string().uuid().optional(),
  returnIntent: ManagedAuthReturnIntent.optional(),
}).superRefine((value, context) => {
  if ((value.kind === "reauth") !== Boolean(value.slotId)) {
    context.addIssue({
      code: "custom",
      path: ["slotId"],
      message: "reauth requires exactly one slot id and add forbids one",
    });
  }
});
export type BeginManagedAuthLoginTransactionRequest = z.infer<
  typeof BeginManagedAuthLoginTransactionRequest
>;

export const ManagedAuthLoginTransaction = z.object({
  id: z.string().uuid(),
  kind: z.enum(["add", "reauth"]),
  expiresAt: z.string().datetime(),
  returnIntentId: z.string().uuid().nullable(),
});
export type ManagedAuthLoginTransaction = z.infer<typeof ManagedAuthLoginTransaction>;

export const CompleteManagedAuthEmailPasswordTransactionRequest =
  ManagedAuthOperationIdentity.extend({
    transactionId: z.string().uuid(),
    email: z.string().email().max(320),
    password: z.string().min(1).max(1_024),
  });
export type CompleteManagedAuthEmailPasswordTransactionRequest = z.infer<
  typeof CompleteManagedAuthEmailPasswordTransactionRequest
>;

export const CompleteManagedAuthLoginTransactionResponse = z.object({
  projection: ManagedAuthSessionSetProjection,
  returnIntent: ManagedAuthReturnIntent.nullable(),
});
export type CompleteManagedAuthLoginTransactionResponse = z.infer<
  typeof CompleteManagedAuthLoginTransactionResponse
>;

export const CancelManagedAuthLoginTransactionRequest = ManagedAuthOperationIdentity.extend({
  transactionId: z.string().uuid(),
});
export type CancelManagedAuthLoginTransactionRequest = z.infer<
  typeof CancelManagedAuthLoginTransactionRequest
>;

export const SelectManagedAuthLoginSlotRequest = ManagedAuthOperationIdentity.extend({
  slotId: z.string().uuid(),
});
export type SelectManagedAuthLoginSlotRequest = z.infer<typeof SelectManagedAuthLoginSlotRequest>;

export const LogoutManagedAuthLoginSlotRequest = ManagedAuthOperationIdentity.extend({
  slotId: z.string().uuid(),
  replacementSlotId: z.string().uuid().nullable(),
});
export type LogoutManagedAuthLoginSlotRequest = z.infer<typeof LogoutManagedAuthLoginSlotRequest>;

export const LogoutManagedAuthSessionSetRequest = ManagedAuthOperationIdentity;
export type LogoutManagedAuthSessionSetRequest = z.infer<typeof LogoutManagedAuthSessionSetRequest>;

export const ManagedAuthLogoutAllReceipt = z.object({
  generation: z.string().regex(/^[1-9][0-9]*$/),
  actorEpoch: z.string().regex(/^[1-9][0-9]*$/),
  state: z.literal("logged_out"),
});
export type ManagedAuthLogoutAllReceipt = z.infer<typeof ManagedAuthLogoutAllReceipt>;

export const ResolveManagedAuthDeepLinkRequest = z.object({
  path: ManagedAuthReturnIntent,
});
export type ResolveManagedAuthDeepLinkRequest = z.infer<typeof ResolveManagedAuthDeepLinkRequest>;

export const ManagedAuthDeepLinkResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("switch_required"), slot: ManagedAuthLoginSlot }),
  z.object({ kind: z.literal("unavailable") }),
]);
export type ManagedAuthDeepLinkResolution = z.infer<typeof ManagedAuthDeepLinkResolution>;

export const ManagedAuthSessionSetErrorCode = z.enum([
  "actor_change_required",
  "actor_mutation_in_flight",
  "api_contract_changed",
  "browser_session_set_required",
  "browser_session_set_unavailable",
  "generation_conflict",
  "invalid_browser_session_set_request",
  "invalid_transaction",
  "managed_authentication_required",
  "managed_authentication_unavailable",
  "operation_outcome_unknown",
  "operation_reused",
  "origin_rejected",
  "provider_route_blocked",
  "slot_limit_reached",
  "slot_already_exists",
  "slot_unavailable",
]);
export type ManagedAuthSessionSetErrorCode = z.infer<typeof ManagedAuthSessionSetErrorCode>;
