import { z } from "zod";

export const ClaudeUsageWindowId = z.enum([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);
export const ClaudeUsageWindow = z
  .object({
    id: ClaudeUsageWindowId,
    usedPercent: z.number().finite().nonnegative().nullable(),
    resetsAt: z.string().datetime().nullable(),
    status: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
    observedAt: z.string().datetime(),
  })
  .strict();
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

/** Provider observations, never an estimate based on OpenGeni token counts. */
export const ClaudeSubscriptionUsage = z
  .object({
    connected: z.boolean(),
    credentialVersion: z.number().int().positive().nullable(),
    windows: z.array(ClaudeUsageWindow).max(6),
    observedAt: z.string().datetime().nullable(),
    source: z.enum(["response_headers", "provider"]).nullable(),
    refreshStatus: z.enum([
      "not_checked",
      "available",
      "scope_required",
      "unavailable",
      "reconnect",
    ]),
    refreshCheckedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ClaudeSubscriptionUsage = z.infer<typeof ClaudeSubscriptionUsage>;
