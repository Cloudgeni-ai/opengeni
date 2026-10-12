import { z } from "zod";

/**
 * A person's explicit model-account choice for a session and their own
 * personal preferences (contract SUB-SEL-02, SUB-SEL-04, SUB-ELIG-05,
 * SUB-OWN-05, D-24, D-27 and D-28), for every provider on the shared
 * subscription core.
 *
 * The picker lists the shared accounts of the workspace's pool and the
 * caller's own personal accounts (never another person's). A personal
 * account can be chosen only by its owner, in their private session or
 * Personal workspace, while personal accounts are allowed there; the
 * database enforces the same rule when the choice is written.
 */
const ProviderId = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);

/** Why a listed account cannot be chosen for this session. */
export const ModelAccountChoiceRefusal = z.enum([
  "inactive",
  "personal_not_allowed",
  "personal_not_owner_work",
]);
export type ModelAccountChoiceRefusal = z.infer<typeof ModelAccountChoiceRefusal>;

export const ModelAccountChoiceOption = z.object({
  provider: ProviderId,
  connectionId: z.string().uuid(),
  label: z.string().nullable(),
  accountEmail: z.string().nullable(),
  planType: z.string().nullable(),
  status: z.string(),
  /** The caller's own personal account. */
  personal: z.boolean(),
  /** The workspace pool a shared account belongs to, or `personal`. */
  source: z.enum(["workspace", "organization", "personal"]),
  /** Models the account may serve (null: every model the provider offers). */
  allowedModelIds: z.array(z.string()).nullable(),
  choosable: z.boolean(),
  refusal: ModelAccountChoiceRefusal.nullable(),
});
export type ModelAccountChoiceOption = z.infer<typeof ModelAccountChoiceOption>;

export const SessionModelAccountChoiceResponse = z.object({
  /**
   * The session's current account: `explicit` after a person's choice, else
   * the account automatic placement last used. `connectionId` is null when
   * the caller may not see that account.
   */
  binding: z
    .object({
      provider: ProviderId,
      connectionId: z.string().uuid().nullable(),
      choice: z.enum(["explicit", "automatic"]),
    })
    .nullable(),
  accounts: z.array(ModelAccountChoiceOption),
  personal: z.object({
    /** Personal accounts are allowed in this workspace (effective setting). */
    connectionsAllowed: z.boolean(),
    /** Personal fallback is allowed in this workspace (effective setting). */
    fallbackAllowed: z.boolean(),
    /** The caller's own personal-fallback opt-in. */
    fallbackOptIn: z.boolean(),
  }),
});
export type SessionModelAccountChoiceResponse = z.infer<typeof SessionModelAccountChoiceResponse>;

/** `connectionId: null` returns the session to automatic account selection. */
export const SetSessionModelAccountChoiceRequest = z
  .object({ connectionId: z.string().uuid().nullable() })
  .strict();
export type SetSessionModelAccountChoiceRequest = z.infer<
  typeof SetSessionModelAccountChoiceRequest
>;

export const SetSessionModelAccountChoiceResponse = z.object({
  changed: z.boolean(),
  /** A waiting turn re-places now; otherwise the choice applies from the next turn. */
  appliedTo: z.enum(["waiting_turn", "next_turn"]),
  provider: ProviderId.nullable(),
  connectionId: z.string().uuid().nullable(),
  choice: z.enum(["explicit", "automatic"]),
});
export type SetSessionModelAccountChoiceResponse = z.infer<
  typeof SetSessionModelAccountChoiceResponse
>;

export const ModelAccountPreferences = z.object({
  /** Use my personal accounts when every shared account is exhausted, where allowed. */
  personalFallbackOptIn: z.boolean(),
  /** 0 before any preference was saved; pass it back as `expectedVersion`. */
  version: z.number().int().nonnegative(),
});
export type ModelAccountPreferences = z.infer<typeof ModelAccountPreferences>;

export const UpdateModelAccountPreferencesRequest = z
  .object({
    personalFallbackOptIn: z.boolean(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export type UpdateModelAccountPreferencesRequest = z.infer<
  typeof UpdateModelAccountPreferencesRequest
>;
