// Server-parsed only; kept off the root contracts index so browser bundles that
// import the root never carry these schemas.
import { z } from "zod";

import { OrganizationUsagePeriod, OrganizationUsageQuery } from "./organization-usage";

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
