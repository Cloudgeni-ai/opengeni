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
      ownerWorkspaceId: z.string().uuid().nullable(),
      everyWorkspace: z.boolean(),
      workspaceIds: z.array(z.string().uuid()),
      personalWorkspaces: z.boolean(),
      people: z.number().int().nonnegative().nullable(),
    })
    .strict(),
);
export type SubscriptionAccountReach = z.infer<typeof SubscriptionAccountReach>;

/** Shared, secret-free account list contract for native subscription pools. */
export const SubscriptionAccountSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    scope: z.enum(["organization", "workspace", "user"]),
    subject: z.string().min(1),
    email: z.string().email().nullable(),
    label: z.string().nullable(),
    plan: z.string().nullable(),
    status: z.enum(["active", "needs_relogin", "error", "disabled"]),
    active: z.boolean(),
    expiresAt: z.string().datetime().nullable(),
    lastRefreshAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
    allocatorEnabled: z.boolean(),
    allocatorVersion: z.number().int().positive(),
    allocatorUpdatedAt: z.string().datetime().nullable(),
    /** The organization's list only. */
    reach: SubscriptionAccountReach.optional(),
  }),
);
export type SubscriptionAccountSummary = z.infer<typeof SubscriptionAccountSummary>;
export const SubscriptionPoolSettings = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      rotationEnabled: z.boolean(),
      rotationStrategy: z.literal("sharded"),
      activeCredentialId: z.string().uuid().nullable(),
    })
    .strict(),
);
export type SubscriptionPoolSettings = z.infer<typeof SubscriptionPoolSettings>;
export const ClaudeSubscriptionAccount = /* @__PURE__ */ defineSchema(() =>
  SubscriptionAccountSummary.extend({
    version: z.number().int().positive(),
    usage: ClaudeSubscriptionUsage.optional(),
  }).strict(),
);
export type ClaudeSubscriptionAccount = z.infer<typeof ClaudeSubscriptionAccount>;
export const ClaudeSubscriptionAccountsResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      accounts: z.array(ClaudeSubscriptionAccount),
      activeAccountId: z.string().uuid().nullable(),
      source: z.enum(["organization", "workspace", "user"]),
      organizationId: z.string().uuid(),
      settings: SubscriptionPoolSettings,
    })
    .strict(),
);
export type ClaudeSubscriptionAccountsResponse = z.infer<typeof ClaudeSubscriptionAccountsResponse>;
