// Deliberately exported only from @opengeni/contracts/insights-usage. Importing
// these schemas must not pull in the root contracts index or its browser graph.
import { z } from "zod";

const SafeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UtcDateTime = z.string().datetime();
const Identifier = z.string().uuid();
const OpaqueKey = z.string().min(1);

export const InsightsUsageRange = z.enum(["today", "week", "month", "30d", "90d", "ytd", "custom"]);
export type InsightsUsageRange = z.infer<typeof InsightsUsageRange>;

export const InsightsUsageGroupBy = z.enum([
  "model",
  "provider",
  "payer",
  "plan",
  "workspace",
  "project",
  "session",
  "rootSession",
  "person",
  "schedule",
  "source",
]);
export type InsightsUsageGroupBy = z.infer<typeof InsightsUsageGroupBy>;

/** Recorded entry surface only; API includes SDK/embed. Missing provenance is other. */
export const InsightsUsageSource = z.enum(["web", "api", "slack", "schedule", "agent", "other"]);
export type InsightsUsageSource = z.infer<typeof InsightsUsageSource>;

const UtcDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const instant = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
  }, "Expected a real UTC calendar date (YYYY-MM-DD)");
const DAY_MS = 86_400_000;
const CUSTOM_MAX_DAYS = 370;

function customWindow(from: string, to: string) {
  if (!UtcDay.safeParse(from).success || !UtcDay.safeParse(to).success) return undefined;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  if (start >= end || end - start > CUSTOM_MAX_DAYS * DAY_MS) return undefined;
  const priorStart = start - (end - start);
  const windows = {
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    priorWindowStart: new Date(priorStart).toISOString(),
    priorWindowEnd: new Date(start).toISOString(),
  };
  // The wire datetime schema uses four-digit years, including the resolved prior.
  if (!Object.values(windows).every((value) => UtcDateTime.safeParse(value).success))
    return undefined;
  return { ...windows, bucket: end - start <= 2 * DAY_MS ? ("hour" as const) : ("day" as const) };
}

const CustomDates = z
  .object({ from: UtcDay, to: UtcDay })
  .strict()
  .refine(
    (value) => customWindow(value.from, value.to) !== undefined,
    "Custom days must be ordered, span at most 370 days and have representable current/prior windows",
  );

/** At most 370 inclusive UTC days; exclusive end and equally long immediate prior. */
export function resolveInsightsUsageCustomWindow(dates: { from: string; to: string }) {
  const parsed = CustomDates.parse(dates);
  return customWindow(parsed.from, parsed.to)!;
}

function validateWindowQuery(
  value: { range: InsightsUsageRange; from?: string | undefined; to?: string | undefined },
  context: z.RefinementCtx,
) {
  if (value.range === "custom") {
    if (value.from === undefined || value.to === undefined) {
      context.addIssue({
        code: "custom",
        path: [value.from === undefined ? "from" : "to"],
        message: "Custom range requires both from and to",
      });
    } else if (customWindow(value.from, value.to) === undefined) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message:
          "Custom days must be ordered, span at most 370 days and have representable current/prior windows",
      });
    }
  } else if (value.from !== undefined || value.to !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["range"],
      message: "from/to are only valid with range=custom",
    });
  }
}

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
  from: UtcDay.optional(),
  to: UtcDay.optional(),
  /** At workspace scope this intersects the path workspace; it never expands scope. */
  workspaceId: repeated(Identifier),
  provider: repeated(OpaqueKey),
  model: repeated(InsightsUsageModelKey),
  payer: repeated(InsightsUsagePayer),
  /** Recorded opaque plan key; missing historical snapshots use unknown, not today's plan. */
  plan: repeated(OpaqueKey),
  source: repeated(InsightsUsageSource),
  projectId: repeated(z.union([Identifier, z.literal("unfiled")])),
  /** Authorized owner/member facet key, not a hidden causal initiator. */
  person: repeated(OpaqueKey),
  /** Leaf session and root chat selectors are deliberately separate. */
  sessionId: repeated(Identifier),
  rootSessionId: repeated(Identifier),
  scheduleId: repeated(Identifier),
};

export const WorkspaceInsightsUsageQuery = z
  .object({
    ...Filters,
    groupBy: InsightsUsageGroupBy.default("model"),
    seriesGroups: QueryBoolean.optional(),
    limit: queryLimit(200),
  })
  .strict()
  .superRefine(validateWindowQuery);
export type WorkspaceInsightsUsageQuery = z.infer<typeof WorkspaceInsightsUsageQuery>;
export type WorkspaceInsightsUsageQueryInput = z.input<typeof WorkspaceInsightsUsageQuery>;

export const OrganizationInsightsUsageQuery = z
  .object({
    ...Filters,
    groupBy: InsightsUsageGroupBy.default("model"),
    seriesGroups: QueryBoolean.optional(),
    limit: queryLimit(200),
  })
  .strict()
  .superRefine(validateWindowQuery);
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
  .strict()
  .superRefine(validateWindowQuery);
export type WorkspaceInsightsCallsQuery = z.infer<typeof WorkspaceInsightsCallsQuery>;
export type WorkspaceInsightsCallsQueryInput = z.input<typeof WorkspaceInsightsCallsQuery>;

export const OrganizationInsightsCallsQuery = WorkspaceInsightsCallsQuery;
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

/**
 * List-price classes only: exact write-time snapshots or flagged historical
 * allocations of each call's recorded total, never repricing that total.
 * chargedMicros is the actual debit-ledger total and has no class split.
 */
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
    /** Priced calls covered by exact snapshots OR flagged recorded-total allocations. */
    listClassKnownCalls: SafeCount,
    tokens: InsightsUsageTokens,
    /** Actual debit ledger, not a model price that may exceed a clipped debit. */
    chargedMicros: SafeCount,
    listMicros: SafeCount,
    listByClassMicros: InsightsUsageClassMicros.nullable(),
    /** True when any covered class values allocate a historical recorded total. */
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
    if (value.listByClassMicros !== null) {
      const coveredTotal = classTotal(value.listByClassMicros);
      if (
        coveredTotal > BigInt(value.listMicros) ||
        (value.listClassKnownCalls === value.pricedCalls &&
          coveredTotal !== BigInt(value.listMicros))
      ) {
        context.addIssue({
          code: "custom",
          path: ["listByClassMicros"],
          message:
            "Covered classes cannot exceed the recorded total; complete coverage must preserve it exactly",
        });
      }
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
    /** Private/personal keys remain kind-scoped; named source keys are the source value. */
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
    /** Only an already-authorized people facet key; permits person-only amount selection. */
    personKey: OpaqueKey.optional(),
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
    /** Top six active groups plus remainder; source uses other:folded to avoid other collisions. */
    groups: z
      .record(z.string(), SeriesGroup)
      .refine(
        (value) =>
          Object.keys(value).length <= 7 &&
          Object.keys(value).filter((key) => key !== "other" && key !== "other:folded").length <= 6,
        {
          message: "Series may include at most six groups plus other",
        },
      )
      .optional(),
  })
  .strict();
export type InsightsUsageSeriesPoint = z.infer<typeof InsightsUsageSeriesPoint>;

/** Range/scope-only authorized metadata, not hidden row IDs or unconditional profile hydration. */
export const InsightsUsageFacets = z
  .object({
    workspaces: z.array(
      z.object({ id: Identifier, name: z.string(), personal: z.boolean() }).strict(),
    ),
    providers: z.array(OpaqueKey),
    models: z.array(z.object({ provider: OpaqueKey, model: OpaqueKey }).strict()),
    payers: z.array(OpaqueKey),
    /** Recorded opaque plan keys, with unknown for absent snapshots. */
    plans: z.array(OpaqueKey).default([]),
    sources: z.array(InsightsUsageSource).default([]),
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
    /** Null for truly empty prior windows; ledger-only money survives missing call facts. */
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
    const windowStart = Date.parse(value.windowStart);
    const windowEnd = Date.parse(value.windowEnd);
    const priorWindowStart = Date.parse(value.priorWindowStart);
    const priorWindowEnd = Date.parse(value.priorWindowEnd);
    if (windowStart > windowEnd) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "Window end must not precede start",
      });
    }
    if (priorWindowStart > priorWindowEnd) {
      context.addIssue({
        code: "custom",
        path: ["priorWindowEnd"],
        message: "Prior window end must not precede start",
      });
    }
    // At an exact UTC range boundary, elapsed current/prior windows can be
    // zero-length. Preserve that canonical window instead of inventing a future end.
    if (windowStart === windowEnd) {
      if (
        value.totals.calls !== 0 ||
        value.totals.chargedMicros !== 0 ||
        value.totals.listMicros !== 0 ||
        Object.values(value.totals.tokens).some((tokens) => tokens !== 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["totals"],
          message: "Zero-length windows must have empty measures",
        });
      }
      if (value.groups.length !== 0 || value.groupCount !== 0 || value.groupsTruncated) {
        context.addIssue({
          code: "custom",
          path: ["groups"],
          message: "Zero-length windows must have no groups",
        });
      }
      if (value.series.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["series"],
          message: "Zero-length windows must have no series points",
        });
      }
    }
    if (priorWindowStart === priorWindowEnd && value.prior !== null) {
      context.addIssue({
        code: "custom",
        path: ["prior"],
        message: "Zero-length prior windows must have null measures",
      });
    }
    const expectedBucket =
      value.range === "custom"
        ? windowEnd - windowStart <= 2 * DAY_MS
          ? "hour"
          : "day"
        : value.range === "today"
          ? "hour"
          : "day";
    if (value.bucket !== expectedBucket) {
      context.addIssue({
        code: "custom",
        path: ["bucket"],
        message: "Bucket is automatic for the range",
      });
    }
    // Model-call facts can soft-fail after money is recorded. Preserve those
    // amounts without inventing calls or known token/class coverage.
    if (
      value.prior?.calls === 0 &&
      value.prior.chargedMicros === 0 &&
      value.prior.listMicros === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["prior"],
        message: "Prior without recorded calls or money must be null",
      });
    }
    if (value.range === "custom") {
      if (
        windowStart === windowEnd ||
        windowEnd - windowStart > CUSTOM_MAX_DAYS * DAY_MS ||
        windowStart % DAY_MS !== 0 ||
        windowEnd % DAY_MS !== 0 ||
        priorWindowStart !== windowStart - (windowEnd - windowStart) ||
        priorWindowEnd !== windowStart
      ) {
        context.addIssue({
          code: "custom",
          path: ["windowEnd"],
          message:
            "Custom windows must span at most 370 complete UTC days with an immediate equal-duration prior",
        });
      }
    }
    if (value.groupBy === "source") {
      for (const [index, group] of value.groups.entries()) {
        if (group.kind === "item" && !InsightsUsageSource.safeParse(group.key).success) {
          context.addIssue({
            code: "custom",
            path: ["groups", index, "key"],
            message: "Named source keys must equal their source value",
          });
        }
        if (group.kind === "other" && group.key !== "other:folded") {
          context.addIssue({
            code: "custom",
            path: ["groups", index, "key"],
            message: "Source remainder must use other:folded, distinct from the other source",
          });
        }
      }
      for (const [index, point] of value.series.entries()) {
        if (
          point.groups &&
          Object.keys(point.groups).filter((key) => key !== "other:folded").length > 6
        ) {
          context.addIssue({
            code: "custom",
            path: ["series", index, "groups"],
            message: "Source series permits six named groups plus other:folded",
          });
        }
      }
    }
    const peopleKeys = new Set(value.facets.people.map((person) => person.key));
    for (const [index, group] of value.groups.entries()) {
      if (group.personKey !== undefined && !peopleKeys.has(group.personKey)) {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "personKey"],
          message: "Person amount keys must come from the authorized people facets",
        });
      }
    }
  });
export type InsightsUsageResponse = z.infer<typeof InsightsUsageResponse>;

/** Backend must omit unreadable calls entirely; this schema grants no access. */
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
