import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { ClaudeSubscriptionUsage } from "./claude-subscription-usage";

/**
 * Who an account in the organization's list reaches: the workspace that owns
 * it (its own account, used only there), every workspace including new ones,
 * chosen shared workspaces, Personal workspaces, or chosen people.
 */
export const SubscriptionAccountReach = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      ownerWorkspaceId: primitives.nullableUuid,
      everyWorkspace: primitives.boolean,
      workspaceIds: z.array(primitives.uuid),
      personalWorkspaces: primitives.boolean,
      people: z.number().int().nonnegative().nullable(),
    })
    .strict(),
);
export type SubscriptionAccountReach = z.infer<typeof SubscriptionAccountReach>;

/** Shared, secret-free account list contract for native subscription pools. */
export const SubscriptionAccountSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    scope: z.enum(["organization", "workspace", "user"]),
    subject: primitives.nonEmptyString,
    email: z.string().email().nullable(),
    label: primitives.nullableString,
    plan: primitives.nullableString,
    status: z.enum(["active", "needs_relogin", "error", "disabled"]),
    active: primitives.boolean,
    expiresAt: z.string().datetime().nullable(),
    lastRefreshAt: z.string().datetime().nullable(),
    lastError: primitives.nullableString,
    allocatorEnabled: primitives.boolean,
    allocatorVersion: primitives.positiveInteger,
    allocatorUpdatedAt: z.string().datetime().nullable(),
    /** The organization's list only. */
    reach: SubscriptionAccountReach.optional(),
  }),
);
export type SubscriptionAccountSummary = z.infer<typeof SubscriptionAccountSummary>;
export const SubscriptionPoolSettings = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      rotationEnabled: primitives.boolean,
      rotationStrategy: z.literal("sharded"),
      activeCredentialId: primitives.nullableUuid,
    })
    .strict(),
);
export type SubscriptionPoolSettings = z.infer<typeof SubscriptionPoolSettings>;
export const ClaudeSubscriptionAccount = /* @__PURE__ */ defineSchema(() =>
  SubscriptionAccountSummary.extend({
    version: primitives.positiveInteger,
    usage: ClaudeSubscriptionUsage.optional(),
  }).strict(),
);
export type ClaudeSubscriptionAccount = z.infer<typeof ClaudeSubscriptionAccount>;
export const ClaudeSubscriptionAccountsResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      accounts: z.array(ClaudeSubscriptionAccount),
      activeAccountId: primitives.nullableUuid,
      source: z.enum(["organization", "workspace", "user"]),
      organizationId: primitives.uuid,
      settings: SubscriptionPoolSettings,
    })
    .strict(),
);
export type ClaudeSubscriptionAccountsResponse = z.infer<typeof ClaudeSubscriptionAccountsResponse>;
