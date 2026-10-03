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
    source: z.enum(["response_headers", "provider"]).optional(),
  })
  .strict();
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

/** One response's dispatch authority; never combine statuses from different responses. */
export const ClaudeUsageRequestStatus = z
  .object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
    resetsAt: z.string().datetime().nullable(),
    representativeClaim: ClaudeUsageWindowId.nullable(),
    overageStatus: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
    overageResetsAt: z.string().datetime().nullable(),
    upstreamModelId: z.string().min(1).max(256).nullable(),
    observedAt: z.string().datetime(),
    source: z.enum(["response_headers", "provider"]).optional(),
  })
  .strict();
export type ClaudeUsageRequestStatus = z.infer<typeof ClaudeUsageRequestStatus>;

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
    requestStatus: ClaudeUsageRequestStatus.nullable().optional(),
    // Model-scoped dispatch evidence; allowances retain an ordering watermark.
    requestRestrictions: z.array(ClaudeUsageRequestStatus).max(64).optional(),
  })
  .strict();
export type ClaudeSubscriptionUsage = z.infer<typeof ClaudeSubscriptionUsage>;
