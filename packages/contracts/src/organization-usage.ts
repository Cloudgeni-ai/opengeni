import { z } from "zod";

export const OrganizationUsagePeriod = z.enum(["today", "week", "month", "ytd"]);
export type OrganizationUsagePeriod = z.infer<typeof OrganizationUsagePeriod>;
export const OrganizationUsageQuery = z.object({
  period: OrganizationUsagePeriod.default("month"),
});
export const OrganizationUsageWorkspacePageQuery = OrganizationUsageQuery.extend({
  until: z.string().datetime(),
  afterWorkspaceId: z.string().uuid().optional(),
});
// PostgreSQL SUM(bigint) must never pass through a JavaScript number.
export const OrganizationUsageTotal = z.object({
  eventType: z.string(),
  unit: z.string(),
  quantity: z.string().regex(/^-?\d+$/),
  eventCount: z.string().regex(/^\d+$/),
});
export const OrganizationUsageSummary = z.object({
  accountId: z.string().uuid(),
  period: OrganizationUsagePeriod,
  since: z.string().datetime(),
  until: z.string().datetime(),
  granularity: z.enum(["hour", "day"]),
  totals: z.array(OrganizationUsageTotal),
  buckets: z.array(z.object({ bucket: z.string(), totals: z.array(OrganizationUsageTotal) })),
  workspaces: z
    .array(
      z.object({
        workspaceId: z.string().uuid(),
        name: z.string().nullable(),
        totals: z.array(OrganizationUsageTotal),
      }),
    )
    .max(50),
  nextWorkspaceCursor: z.string().uuid().nullable(),
});
export type OrganizationUsageSummary = z.infer<typeof OrganizationUsageSummary>;

/** A page deliberately excludes totals and charts: those are not recomputed. */
export const OrganizationUsageWorkspacePage = OrganizationUsageSummary.omit({
  totals: true,
  buckets: true,
});
export type OrganizationUsageWorkspacePage = z.infer<typeof OrganizationUsageWorkspacePage>;

const BigIntString = z.string().regex(/^\d+$/);
const OrganizationModelUsageBillingPath = z.enum(["opengeni_credits", "external"]);

/** Exact per-billing-path sums from per-call model facts; bigint sums stay strings. */
export const OrganizationModelUsageTotals = z.object({
  billingPath: OrganizationModelUsageBillingPath,
  calls: BigIntString,
  inputTokens: BigIntString,
  outputTokens: BigIntString,
  cachedTokens: BigIntString,
  cacheInputTokens: BigIntString,
  cacheWriteTokens: BigIntString,
  totalTokens: BigIntString,
  tokenKnownCalls: BigIntString,
  cacheKnownCalls: BigIntString,
  creditMicros: BigIntString,
  estimatedProviderMicros: BigIntString,
  estimatedProviderKnownCalls: BigIntString,
});
export type OrganizationModelUsageTotals = z.infer<typeof OrganizationModelUsageTotals>;

export const OrganizationModelUsageQuery = OrganizationUsageQuery.extend({
  afterWorkspaceId: z.string().uuid().optional(),
});

export const OrganizationModelUsage = z.object({
  accountId: z.string().uuid(),
  period: OrganizationUsagePeriod,
  since: z.string().datetime(),
  until: z.string().datetime(),
  billing: z.array(OrganizationModelUsageTotals).max(2),
  models: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string(),
        totals: OrganizationModelUsageTotals,
      }),
    )
    .max(50),
  modelsTruncated: z.boolean(),
  workspaces: z
    .array(
      z.object({
        workspaceId: z.string().uuid(),
        name: z.string().nullable(),
        billing: z.array(OrganizationModelUsageTotals).max(2),
      }),
    )
    .max(50),
  /** Every Personal workspace, aggregated; individual Personal workspaces are never named. */
  personal: z.object({
    workspacesWithUsage: BigIntString,
    billing: z.array(OrganizationModelUsageTotals).max(2),
  }),
  nextWorkspaceCursor: z.string().uuid().nullable(),
});
export type OrganizationModelUsage = z.infer<typeof OrganizationModelUsage>;
