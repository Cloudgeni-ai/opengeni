import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { LatencyMode, ReasoningEffort } from "./index";

/**
 * A person's explicit model-account choice for a session and their own
 * personal preferences (contract SUB-SEL-02, SUB-SEL-04, SUB-ELIG-05,
 * SUB-OWN-05, D-24, D-27 and D-28), for every provider on the shared
 * subscription core.
 *
 * The picker lists the shared accounts of the workspace's pool and the
 * caller's own personal accounts (never another person's). A personal
 * account can be chosen only by its owner, in their private session or
 * Personal workspace, or for their own newly accepted sends in a shared
 * session, while personal accounts are allowed there. Choosing never widens
 * already accepted work; the database enforces the same authority boundary.
 */
const ProviderId = /* @__PURE__ */ defineSchema(() =>
  primitives.string.regex(/^[a-z][a-z0-9_]{1,31}$/),
);

/** Why a listed account cannot be chosen for this session. */
export const ModelAccountChoiceRefusal = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "inactive",
    "personal_not_allowed",
    "personal_not_owner_work",
    /** The session has no owner (for example a scheduled run started with an API key). */
    "session_has_no_owner",
  ]),
);
export type ModelAccountChoiceRefusal = z.infer<typeof ModelAccountChoiceRefusal>;

/**
 * Stored observation only, not a live check or a promise of available capacity.
 * Source/time describe the snapshot, not each retained window. Windows can be
 * partial, unknown or stale; a past reset does not prove replenishment.
 */
export const ModelAccountUsageSnapshot = /* @__PURE__ */ defineSchema(() =>
  z.object({
    observedAt: z.string().datetime().nullable(),
    source: z.enum(["usage_endpoint", "response_headers", "refusal"]).nullable(),
    windows: z.array(
      z.object({
        id: primitives.string,
        /** Null means unknown; values over 100 can represent overage. */
        usedPercent: z.number().finite().nonnegative().nullable(),
        resetsAt: z.string().datetime().nullable(),
        status: z.enum(["ok", "warning", "exhausted", "unknown"]),
      }),
    ),
    exhaustedUntil: z.string().datetime().nullable(),
    exhaustedKind: z.enum(["quota", "rate_limit"]).nullable(),
  }),
);
export type ModelAccountUsageSnapshot = z.infer<typeof ModelAccountUsageSnapshot>;

export const ModelAccountChoiceOption = /* @__PURE__ */ defineSchema(() =>
  z.object({
    provider: ProviderId,
    connectionId: primitives.uuid,
    label: primitives.nullableString,
    accountEmail: primitives.nullableString,
    planType: primitives.nullableString,
    status: primitives.string,
    /** The caller's own personal account. */
    personal: primitives.boolean,
    /** The workspace pool a shared account belongs to, or `personal`. */
    source: z.enum(["workspace", "organization", "personal"]),
    /** Models the account may serve (null: every model the provider offers). */
    allowedModelIds: z.array(primitives.string).nullable(),
    choosable: primitives.boolean,
    refusal: ModelAccountChoiceRefusal.nullable(),
    /** Omitted on older servers; null when this visible account has no decodable snapshot. */
    usage: ModelAccountUsageSnapshot.nullable().optional(),
  }),
);
export type ModelAccountChoiceOption = z.infer<typeof ModelAccountChoiceOption>;

/** A session's binding for one provider: its explicit choice or its automatic placement. */
const SessionModelAccountBinding = /* @__PURE__ */ defineSchema(() =>
  z.object({
    provider: ProviderId,
    connectionId: primitives.nullableUuid,
    choice: z.enum(["explicit", "automatic"]),
  }),
);

/** Last lease-backed selection, not a queued choice or an unplaced proposal. */
export const SessionModelAccountServing = /* @__PURE__ */ defineSchema(() =>
  z.object({
    turnId: primitives.uuid,
    provider: ProviderId,
    connectionId: primitives.nullableUuid,
    modelId: primitives.nonEmptyString,
    preferredModelId: primitives.nonEmptyString,
    reasoningEffort: z.lazy(() => ReasoningEffort),
    latencyMode: z.lazy(() => LatencyMode),
  }),
);
export type SessionModelAccountServing = z.infer<typeof SessionModelAccountServing>;

export const SessionModelAccountChoiceResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /**
     * The session's current account when it has bindings for one provider
     * only: `explicit` after a person's choice, else the account automatic
     * placement last used. Null when it has none, or bindings for several
     * providers (see `bindings`). `connectionId` is null when the caller may
     * not see that account.
     */
    binding: SessionModelAccountBinding.nullable(),
    /** One binding per provider: a session keeps each provider's choice separately. */
    bindings: z.array(SessionModelAccountBinding),
    /** Omitted by older servers. Account identity is withheld under the same visibility rule. */
    serving: SessionModelAccountServing.nullable().optional(),
    accounts: z.array(ModelAccountChoiceOption),
    personal: z.object({
      /** Personal accounts are allowed in this workspace (effective setting). */
      connectionsAllowed: primitives.boolean,
      /** Personal fallback is allowed in this workspace (effective setting). */
      fallbackAllowed: primitives.boolean,
      /** The caller's own personal-fallback opt-in. */
      fallbackOptIn: primitives.boolean,
    }),
  }),
);
export type SessionModelAccountChoiceResponse = z.infer<typeof SessionModelAccountChoiceResponse>;

/**
 * A connection makes it the session's choice for that connection's provider;
 * other providers' choices stay. `connectionId: null` returns the session to
 * automatic account selection: only `provider`'s choice when given, else
 * every provider's.
 */
export const SetSessionModelAccountChoiceRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ connectionId: primitives.nullableUuid, provider: ProviderId.optional() }).strict(),
);
export type SetSessionModelAccountChoiceRequest = z.infer<
  typeof SetSessionModelAccountChoiceRequest
>;

export const SetSessionModelAccountChoiceResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    changed: primitives.boolean,
    /** A waiting turn re-places now; otherwise the choice applies from the next turn. */
    appliedTo: z.enum(["waiting_turn", "next_turn"]),
    provider: ProviderId.nullable(),
    connectionId: primitives.nullableUuid,
    choice: z.enum(["explicit", "automatic"]),
  }),
);
export type SetSessionModelAccountChoiceResponse = z.infer<
  typeof SetSessionModelAccountChoiceResponse
>;

export const ModelAccountPreferences = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Use my personal accounts when every shared account is exhausted, where allowed. */
    personalFallbackOptIn: primitives.boolean,
    /** 0 before any preference was saved; pass it back as `expectedVersion`. */
    version: primitives.nonnegativeInteger,
  }),
);
export type ModelAccountPreferences = z.infer<typeof ModelAccountPreferences>;

export const UpdateModelAccountPreferencesRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      personalFallbackOptIn: primitives.boolean,
      expectedVersion: z.number().int().nonnegative().optional(),
    })
    .strict(),
);
export type UpdateModelAccountPreferencesRequest = z.infer<
  typeof UpdateModelAccountPreferencesRequest
>;
