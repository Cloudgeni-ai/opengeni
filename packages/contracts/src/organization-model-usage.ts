import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
// Server-parsed only; kept off the root contracts index so browser bundles that
// import the root never carry these schemas.
import { z } from "zod";

import { OrganizationUsagePeriod, OrganizationUsageQuery } from "./organization-usage";

const BigIntString = /* @__PURE__ */ defineSchema(() => primitives.string.regex(/^\d+$/));
const OrganizationModelUsageBillingPath = /* @__PURE__ */ defineSchema(() =>
  z.enum(["opengeni_credits", "external"]),
);

/** Exact per-billing-path sums from per-call model facts; bigint sums stay strings. */
export const OrganizationModelUsageTotals = /* @__PURE__ */ defineSchema(() =>
  z.object({
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
  }),
);
export type OrganizationModelUsageTotals = z.infer<typeof OrganizationModelUsageTotals>;

export const OrganizationModelUsageQuery = /* @__PURE__ */ defineSchema(() =>
  OrganizationUsageQuery.extend({
    afterWorkspaceId: primitives.optionalUuid,
  }),
);

export const OrganizationModelUsage = /* @__PURE__ */ defineSchema(() =>
  z.object({
    accountId: primitives.uuid,
    period: OrganizationUsagePeriod,
    since: primitives.dateTime,
    until: primitives.dateTime,
    billing: z.array(OrganizationModelUsageTotals).max(2),
    /** Exact uncapped per-fact payer split; independent of the top-model list. */
    payers: z
      .array(
        OrganizationModelUsageTotals.omit({ billingPath: true }).extend({
          payer: z.enum(["opengeni_credits", "subscription", "own_key"]),
        }),
      )
      .default([]),
    models: z
      .array(
        z.object({
          provider: primitives.string,
          model: primitives.string,
          totals: OrganizationModelUsageTotals,
        }),
      )
      .max(50),
    modelsTruncated: primitives.boolean,
    workspaces: z
      .array(
        z.object({
          workspaceId: primitives.uuid,
          name: primitives.nullableString,
          billing: z.array(OrganizationModelUsageTotals).max(2),
        }),
      )
      .max(50),
    /** Every Personal workspace, aggregated; individual Personal workspaces are never named. */
    personal: z.object({
      workspacesWithUsage: BigIntString,
      billing: z.array(OrganizationModelUsageTotals).max(2),
    }),
    nextWorkspaceCursor: primitives.nullableUuid,
  }),
);
export type OrganizationModelUsage = z.infer<typeof OrganizationModelUsage>;
