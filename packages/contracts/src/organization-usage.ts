import { z } from "zod";

export const OrganizationUsagePeriod = z.enum(["today", "week", "month", "ytd"]);
export type OrganizationUsagePeriod = z.infer<typeof OrganizationUsagePeriod>;
export const OrganizationUsageQuery = z.object({
  period: OrganizationUsagePeriod.default("month"),
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
