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
/** One member's Personal workspace, as usage only. */
export const OrganizationUsagePersonalWorkspace = z.object({
  membershipId: z.string().uuid(),
  totals: z.array(OrganizationUsageTotal),
});
export type OrganizationUsagePersonalWorkspace = z.infer<typeof OrganizationUsagePersonalWorkspace>;
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
  /**
   * Usage in each member's Personal workspace, keyed by the owner's
   * organization membership: amounts only, never the workspace's id, name or
   * content. Only Personal workspaces with usage in the period, the 50 that
   * spent the most. Absent from a pre-0537 database, hence the defaults.
   */
  personalWorkspaces: z.array(OrganizationUsagePersonalWorkspace).max(50).default([]),
  /** How many Personal workspaces had usage in the period, listed or not. */
  personalWorkspaceCount: z.number().int().nonnegative().default(0),
});
export type OrganizationUsageSummary = z.infer<typeof OrganizationUsageSummary>;

/**
 * A page deliberately excludes totals, charts and Personal rows: those are not
 * recomputed. Pages continue the shared workspaces only.
 */
export const OrganizationUsageWorkspacePage = OrganizationUsageSummary.omit({
  totals: true,
  buckets: true,
  personalWorkspaces: true,
  personalWorkspaceCount: true,
});
export type OrganizationUsageWorkspacePage = z.infer<typeof OrganizationUsageWorkspacePage>;
