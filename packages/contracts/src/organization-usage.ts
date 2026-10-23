import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const OrganizationUsagePeriod = /* @__PURE__ */ defineSchema(() =>
  z.enum(["today", "week", "month", "ytd"]),
);
export type OrganizationUsagePeriod = z.infer<typeof OrganizationUsagePeriod>;
export const OrganizationUsageQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    period: OrganizationUsagePeriod.default("month"),
  }),
);
export const OrganizationUsageWorkspacePageQuery = /* @__PURE__ */ defineSchema(() =>
  OrganizationUsageQuery.extend({
    until: primitives.dateTime,
    afterWorkspaceId: primitives.optionalUuid,
  }),
);
// PostgreSQL SUM(bigint) must never pass through a JavaScript number.
export const OrganizationUsageTotal = /* @__PURE__ */ defineSchema(() =>
  z.object({
    eventType: primitives.string,
    unit: primitives.string,
    quantity: primitives.string.regex(/^-?\d+$/),
    eventCount: primitives.string.regex(/^\d+$/),
  }),
);
/** One member's Personal workspace, as usage only. */
export const OrganizationUsagePersonalWorkspace = /* @__PURE__ */ defineSchema(() =>
  z.object({
    membershipId: primitives.uuid,
    totals: z.array(OrganizationUsageTotal),
  }),
);
export type OrganizationUsagePersonalWorkspace = z.infer<typeof OrganizationUsagePersonalWorkspace>;
export const OrganizationUsageSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    accountId: primitives.uuid,
    period: OrganizationUsagePeriod,
    since: primitives.dateTime,
    until: primitives.dateTime,
    granularity: z.enum(["hour", "day"]),
    totals: z.array(OrganizationUsageTotal),
    buckets: z.array(
      z.object({ bucket: primitives.string, totals: z.array(OrganizationUsageTotal) }),
    ),
    workspaces: z
      .array(
        z.object({
          workspaceId: primitives.uuid,
          name: primitives.nullableString,
          totals: z.array(OrganizationUsageTotal),
        }),
      )
      .max(50),
    nextWorkspaceCursor: primitives.nullableUuid,
    /**
     * Usage in each member's Personal workspace, keyed by the owner's
     * organization membership: amounts only, never the workspace's id, name or
     * content. Only Personal workspaces with usage in the period, the 50 that
     * spent the most. Absent before migration 0543, hence the defaults.
     */
    personalWorkspaces: z.array(OrganizationUsagePersonalWorkspace).max(50).default([]),
    /** How many Personal workspaces had usage in the period, listed or not. */
    personalWorkspaceCount: primitives.nonnegativeInteger.default(0),
    /** Other people's Only-me chats in shared workspaces: member amounts only. */
    privateChats: z
      .array(
        z.object({
          workspaceId: primitives.uuid,
          membershipId: primitives.nullableUuid,
          name: primitives.nullableString,
          totals: z.array(OrganizationUsageTotal),
        }),
      )
      .default([]),
    privateChatsTruncated: primitives.boolean.default(false),
  }),
);
export type OrganizationUsageSummary = z.infer<typeof OrganizationUsageSummary>;

/**
 * A page deliberately excludes totals, charts and Personal rows: those are not
 * recomputed. Pages continue the shared workspaces only.
 */
export const OrganizationUsageWorkspacePage = /* @__PURE__ */ defineSchema(() =>
  OrganizationUsageSummary.omit({
    totals: true,
    buckets: true,
    personalWorkspaces: true,
    personalWorkspaceCount: true,
    privateChats: true,
    privateChatsTruncated: true,
  }),
);
export type OrganizationUsageWorkspacePage = z.infer<typeof OrganizationUsageWorkspacePage>;
