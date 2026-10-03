// Deliberately exported only from @opengeni/contracts/insights-usage. Importing
// these schemas must not pull in the root contracts index or its browser graph.
import { z } from "zod";

const SafeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UtcDateTime = z.string().datetime();
const Identifier = z.string().uuid();
const OpaqueKey = z.string().min(1);

export const InsightsUsageRange = z.enum(["today", "week", "month", "30d", "90d", "ytd"]);
export type InsightsUsageRange = z.infer<typeof InsightsUsageRange>;

export const InsightsUsageGroupBy = z.enum([
  "model",
  "provider",
  "payer",
  "workspace",
  "project",
  "rootSession",
  "person",
  "schedule",
]);
export type InsightsUsageGroupBy = z.infer<typeof InsightsUsageGroupBy>;
const WorkspaceGroupBy = InsightsUsageGroupBy.exclude(["workspace"]);

// Literal union avoids replacing existing, structurally identical named enum
// fingerprints in the additive public-API inventory.
export const InsightsUsagePayer = z.union([
  z.literal("opengeni_credits"),
  z.literal("subscription"),
  z.literal("own_key"),
]);
export type InsightsUsagePayer = z.infer<typeof InsightsUsagePayer>;

/** Split at the FIRST slash: model IDs themselves may contain slashes. */
export const InsightsUsageModelKey = z.string().regex(/^[^/\s]+\/\S+$/);
export type InsightsUsageModelKey = z.infer<typeof InsightsUsageModelKey>;

function repeated<T extends z.ZodType>(item: T) {
  return z
    .union([z.string(), z.array(z.string()).min(1)])
    .transform((value, context) => {
      const entries = (Array.isArray(value) ? value : [value]).flatMap((part) =>
        part.split(",").map((entry) => entry.trim()),
      );
      const parsed = z.array(item).min(1).safeParse(entries);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
        return z.NEVER;
      }
      return parsed.data;
    })
    .optional();
}

function queryLimit(max: number) {
  return z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(SafeCount.min(1).max(max))
    .default(50);
}

const QueryBoolean = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

// Repeated, comma-separated, and mixed values: AND across fields, OR within a
// field. Empty segments are rejected, never silently widened to all records.
const Filters = {
  range: InsightsUsageRange.default("week"),
  provider: repeated(OpaqueKey),
  model: repeated(InsightsUsageModelKey),
  payer: repeated(InsightsUsagePayer),
  projectId: repeated(z.union([Identifier, z.literal("unfiled")])),
  person: repeated(OpaqueKey),
  rootSessionId: repeated(Identifier),
  scheduleId: repeated(Identifier),
};

export const WorkspaceInsightsUsageQuery = z
  .object({
    ...Filters,
    groupBy: WorkspaceGroupBy.default("model"),
    seriesGroups: QueryBoolean.optional(),
    limit: queryLimit(200),
  })
  .strict();
export type WorkspaceInsightsUsageQuery = z.infer<typeof WorkspaceInsightsUsageQuery>;
export type WorkspaceInsightsUsageQueryInput = z.input<typeof WorkspaceInsightsUsageQuery>;

export const OrganizationInsightsUsageQuery = z
  .object({
    ...Filters,
    workspaceId: repeated(Identifier),
    groupBy: InsightsUsageGroupBy.default("model"),
    seriesGroups: QueryBoolean.optional(),
    limit: queryLimit(200),
  })
  .strict();
export type OrganizationInsightsUsageQuery = z.infer<typeof OrganizationInsightsUsageQuery>;
export type OrganizationInsightsUsageQueryInput = z.input<typeof OrganizationInsightsUsageQuery>;

/** Organization-capable shared shape; use the workspace parser at workspace scope. */
export const InsightsUsageQuery = OrganizationInsightsUsageQuery;
export type InsightsUsageQuery = OrganizationInsightsUsageQuery;
export type InsightsUsageQueryInput = OrganizationInsightsUsageQueryInput;

export const WorkspaceInsightsCallsQuery = z
  .object({
    ...Filters,
    cursor: OpaqueKey.optional(),
    limit: queryLimit(100),
  })
  .strict();
export type WorkspaceInsightsCallsQuery = z.infer<typeof WorkspaceInsightsCallsQuery>;
export type WorkspaceInsightsCallsQueryInput = z.input<typeof WorkspaceInsightsCallsQuery>;

export const OrganizationInsightsCallsQuery = WorkspaceInsightsCallsQuery.extend({
  workspaceId: repeated(Identifier),
});
export type OrganizationInsightsCallsQuery = z.infer<typeof OrganizationInsightsCallsQuery>;
export type OrganizationInsightsCallsQueryInput = z.input<typeof OrganizationInsightsCallsQuery>;
export const InsightsCallsQuery = OrganizationInsightsCallsQuery;
export type InsightsCallsQuery = OrganizationInsightsCallsQuery;
export type InsightsCallsQueryInput = OrganizationInsightsCallsQueryInput;

/** Missing historical token classes are represented by known-call counters, not guessed zeroes. */
export const InsightsUsageTokens = z
  .object({
    uncachedInput: SafeCount,
    cacheRead: SafeCount,
    cacheWrite: SafeCount,
    output: SafeCount,
    reasoning: SafeCount,
  })
  .strict();
export type InsightsUsageTokens = z.infer<typeof InsightsUsageTokens>;

/** List-price classes only; chargedMicros is authoritative and has no class split. */
export const InsightsUsageClassMicros = z
  .object({
    uncachedInput: SafeCount,
    cacheRead: SafeCount,
    cacheWrite: SafeCount,
    output: SafeCount,
  })
  .strict();
export type InsightsUsageClassMicros = z.infer<typeof InsightsUsageClassMicros>;

const PayerMeasures = z
  .object({
    calls: SafeCount,
    chargedMicros: SafeCount,
    listMicros: SafeCount,
  })
  .strict();

function classTotal(value: InsightsUsageClassMicros): bigint {
  return (
    BigInt(value.uncachedInput) +
    BigInt(value.cacheRead) +
    BigInt(value.cacheWrite) +
    BigInt(value.output)
  );
}

export const InsightsUsageMeasures = z
  .object({
    calls: SafeCount,
    tokenKnownCalls: SafeCount,
    cacheKnownCalls: SafeCount,
    cacheWriteKnownCalls: SafeCount,
    listClassKnownCalls: SafeCount,
    tokens: InsightsUsageTokens,
    chargedMicros: SafeCount,
    listMicros: SafeCount,
    listByClassMicros: InsightsUsageClassMicros.nullable(),
    listByClassApprox: z.boolean(),
    pricedCalls: SafeCount,
    byPayer: z
      .object({
        opengeni_credits: PayerMeasures,
        subscription: PayerMeasures,
        own_key: PayerMeasures,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of [
      "tokenKnownCalls",
      "cacheKnownCalls",
      "cacheWriteKnownCalls",
      "pricedCalls",
    ] as const) {
      if (value[field] > value.calls) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Known calls cannot exceed calls",
        });
      }
    }
    if (value.listClassKnownCalls > value.pricedCalls) {
      context.addIssue({
        code: "custom",
        path: ["listClassKnownCalls"],
        message: "Class coverage cannot exceed priced calls",
      });
    }
    if (
      value.listByClassMicros !== null &&
      !value.listByClassApprox &&
      value.listClassKnownCalls === value.pricedCalls &&
      classTotal(value.listByClassMicros) !== BigInt(value.listMicros)
    ) {
      context.addIssue({
        code: "custom",
        path: ["listByClassMicros"],
        message: "Complete exact list classes must sum to listMicros",
      });
    }
    for (const field of ["calls", "chargedMicros", "listMicros"] as const) {
      const total = Object.values(value.byPayer).reduce(
        (sum, payer) => sum + BigInt(payer[field]),
        0n,
      );
      if (total !== BigInt(value[field])) {
        context.addIssue({
          code: "custom",
          path: ["byPayer"],
          message: `Payer ${field} must sum to the total`,
        });
      }
    }
  });
export type InsightsUsageMeasures = z.infer<typeof InsightsUsageMeasures>;

export const InsightsUsageScope = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("workspace"), accountId: Identifier, workspaceId: Identifier })
    .strict(),
  z
    .object({ kind: z.literal("organization"), accountId: Identifier, workspaceId: z.null() })
    .strict(),
]);
export type InsightsUsageScope = z.infer<typeof InsightsUsageScope>;

export const InsightsUsageGroup = z
  .object({
    key: OpaqueKey,
    kind: z.enum([
      "item",
      "other",
      "deleted",
      "private",
      "personal",
      "unfiled",
      "service",
      "restricted",
    ]),
    label: z.string(),
    provider: OpaqueKey.optional(),
    model: OpaqueKey.optional(),
    workspaceId: Identifier.optional(),
    you: z.boolean().optional(),
    measures: InsightsUsageMeasures,
  })
  .strict();
export type InsightsUsageGroup = z.infer<typeof InsightsUsageGroup>;

const SeriesGroup = z
  .object({
    chargedMicros: SafeCount,
    listMicros: SafeCount,
    tokens: InsightsUsageTokens,
    calls: SafeCount,
    byPayer: InsightsUsageMeasures.shape.byPayer,
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ["calls", "chargedMicros", "listMicros"] as const) {
      const total = Object.values(value.byPayer).reduce(
        (sum, payer) => sum + BigInt(payer[field]),
        0n,
      );
      if (total !== BigInt(value[field])) {
        context.addIssue({
          code: "custom",
          path: ["byPayer"],
          message: `Payer ${field} must sum to the total`,
        });
      }
    }
  });

export const InsightsUsageSeriesPoint = z
  .object({
    start: UtcDateTime,
    measures: InsightsUsageMeasures,
    /** Top six active groups plus "other" when requested. */
    groups: z
      .record(z.string(), SeriesGroup)
      .refine((value) => Object.keys(value).filter((key) => key !== "other").length <= 6, {
        message: "Series may include at most six groups plus other",
      })
      .optional(),
  })
  .strict();
export type InsightsUsageSeriesPoint = z.infer<typeof InsightsUsageSeriesPoint>;

/** Range/scope-only visible metadata; opaque private/personal row keys are NOT facets. */
export const InsightsUsageFacets = z
  .object({
    workspaces: z.array(
      z.object({ id: Identifier, name: z.string(), personal: z.boolean() }).strict(),
    ),
    providers: z.array(OpaqueKey),
    models: z.array(z.object({ provider: OpaqueKey, model: OpaqueKey }).strict()),
    payers: z.array(OpaqueKey),
    projects: z.array(z.object({ id: Identifier, name: z.string() }).strict()),
    people: z.array(
      z.object({ key: OpaqueKey, name: z.string().nullable(), you: z.boolean() }).strict(),
    ),
    schedules: z.array(z.object({ id: Identifier, name: z.string() }).strict()),
  })
  .strict();
export type InsightsUsageFacets = z.infer<typeof InsightsUsageFacets>;

export const InsightsUsageResponse = z
  .object({
    scope: InsightsUsageScope,
    range: InsightsUsageRange,
    windowStart: UtcDateTime,
    windowEnd: UtcDateTime,
    priorWindowStart: UtcDateTime,
    priorWindowEnd: UtcDateTime,
    bucket: z.enum(["hour", "day"]),
    generatedAt: UtcDateTime,
    dataThrough: UtcDateTime.nullable(),
    totals: InsightsUsageMeasures,
    prior: InsightsUsageMeasures.nullable(),
    groupBy: InsightsUsageGroupBy,
    groups: z.array(InsightsUsageGroup),
    groupCount: SafeCount,
    groupsTruncated: z.boolean(),
    series: z.array(InsightsUsageSeriesPoint),
    facets: InsightsUsageFacets,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.windowStart) >= Date.parse(value.windowEnd)) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "Window end must follow start",
      });
    }
    if (Date.parse(value.priorWindowStart) >= Date.parse(value.priorWindowEnd)) {
      context.addIssue({
        code: "custom",
        path: ["priorWindowEnd"],
        message: "Prior window end must follow start",
      });
    }
    if (value.bucket !== (value.range === "today" ? "hour" : "day")) {
      context.addIssue({
        code: "custom",
        path: ["bucket"],
        message: "Bucket is automatic for the range",
      });
    }
    if (value.prior?.calls === 0) {
      context.addIssue({
        code: "custom",
        path: ["prior"],
        message: "Zero-call prior must be null",
      });
    }
    if (value.scope.kind === "workspace" && value.groupBy === "workspace") {
      context.addIssue({
        code: "custom",
        path: ["groupBy"],
        message: "Workspace grouping is organization-only",
      });
    }
  });
export type InsightsUsageResponse = z.infer<typeof InsightsUsageResponse>;

export const InsightsCall = z
  .object({
    id: Identifier,
    occurredAt: UtcDateTime,
    workspaceId: Identifier,
    sessionId: Identifier.nullable(),
    sessionTitle: z.string().nullable(),
    sessionKind: z.enum(["visible", "private", "deleted"]),
    personKey: OpaqueKey.nullable(),
    provider: OpaqueKey,
    model: OpaqueKey,
    payer: InsightsUsagePayer,
    tokens: InsightsUsageTokens.nullable(),
    chargedMicros: SafeCount,
    listMicros: SafeCount.nullable(),
    listByClassMicros: InsightsUsageClassMicros.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sessionKind === "private" &&
      (value.sessionId !== null || value.sessionTitle !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sessionKind"],
        message: "Private calls expose no session id or title",
      });
    }
    if (
      value.listByClassMicros !== null &&
      (value.listMicros === null ||
        classTotal(value.listByClassMicros) !== BigInt(value.listMicros))
    ) {
      context.addIssue({
        code: "custom",
        path: ["listByClassMicros"],
        message: "Call list classes must sum to its recorded listMicros",
      });
    }
  });
export type InsightsCall = z.infer<typeof InsightsCall>;

export const InsightsCallsResponse = z
  .object({
    calls: z.array(InsightsCall).max(100),
    nextCursor: OpaqueKey.nullable(),
  })
  .strict();
export type InsightsCallsResponse = z.infer<typeof InsightsCallsResponse>;
