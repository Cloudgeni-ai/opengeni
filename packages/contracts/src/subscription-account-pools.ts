import { z } from "zod";
import { ClaudeSubscriptionUsage } from "./claude-subscription-usage";

/** Shared, secret-free account list contract for native subscription pools. */
export const SubscriptionAccountSummary = z.object({
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
});
export type SubscriptionAccountSummary = z.infer<typeof SubscriptionAccountSummary>;
export const SubscriptionPoolSettings = z
  .object({
    rotationEnabled: z.boolean(),
    rotationStrategy: z.literal("sharded"),
    activeCredentialId: z.string().uuid().nullable(),
  })
  .strict();
export type SubscriptionPoolSettings = z.infer<typeof SubscriptionPoolSettings>;
export const ClaudeSubscriptionAccount = SubscriptionAccountSummary.extend({
  version: z.number().int().positive(),
  usage: ClaudeSubscriptionUsage.optional(),
}).strict();
export type ClaudeSubscriptionAccount = z.infer<typeof ClaudeSubscriptionAccount>;
export const ClaudeSubscriptionAccountsResponse = z
  .object({
    accounts: z.array(ClaudeSubscriptionAccount),
    activeAccountId: z.string().uuid().nullable(),
    source: z.enum(["organization", "workspace", "user"]),
    organizationId: z.string().uuid(),
    settings: SubscriptionPoolSettings,
  })
  .strict();
export type ClaudeSubscriptionAccountsResponse = z.infer<typeof ClaudeSubscriptionAccountsResponse>;
