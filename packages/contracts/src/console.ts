import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Opengeni Console: the organization surface for products that embed
 * Opengeni. Owners and admins read their end users' sessions in workspaces
 * the product manages, see what they cost, and create server keys.
 *
 * Amounts are integer USD micros ($1 = 1_000_000) taken from the credit
 * ledger, the same debits billing charges. They are actual charges, so work
 * paid by a connected subscription or the organization's own model keys
 * shows only the platform fee.
 */

/**
 * How much of an end user's session an owner or admin can see in Console.
 * `full` shows the transcript, `metadata` shows only counts, cost and status,
 * and `off` hides managed-workspace sessions entirely. The default is `full`.
 * No level ever shows a real Opengeni member's Only me chat.
 */
export const ConsoleReviewLevel = /* @__PURE__ */ defineSchema(() =>
  z.enum(["full", "metadata", "off"]),
);
export type ConsoleReviewLevel = z.infer<typeof ConsoleReviewLevel>;

/** `managed`: created by the product's server key (or marked so in Console); `team`: used in the app. */
export const ConsoleWorkspaceKind = /* @__PURE__ */ defineSchema(() => z.enum(["managed", "team"]));
export type ConsoleWorkspaceKind = z.infer<typeof ConsoleWorkspaceKind>;

/** How a workspace came to be managed by the product. */
export const ConsoleManagedSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["api_key", "backfill", "console"]),
);
export type ConsoleManagedSource = z.infer<typeof ConsoleManagedSource>;

export const ConsoleRange = /* @__PURE__ */ defineSchema(() => z.enum(["7d", "30d", "90d"]));
export type ConsoleRange = z.infer<typeof ConsoleRange>;

export const ConsoleRangeQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({ range: ConsoleRange.default("30d") }),
);
export type ConsoleRangeQuery = z.infer<typeof ConsoleRangeQuery>;

const Micros = /* @__PURE__ */ defineSchema(() => z.number().int().nonnegative());

export const ConsoleSettings = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    reviewLevel: ConsoleReviewLevel,
    updatedAt: primitives.dateTime.nullable(),
    updatedBySubjectId: primitives.nullableString,
  }),
);
export type ConsoleSettings = z.infer<typeof ConsoleSettings>;

export const UpdateConsoleSettingsRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ reviewLevel: ConsoleReviewLevel }).strict(),
);
export type UpdateConsoleSettingsRequest = z.infer<typeof UpdateConsoleSettingsRequest>;

export const ConsoleSpendPoint = /* @__PURE__ */ defineSchema(() =>
  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), spendMicros: Micros }),
);
export type ConsoleSpendPoint = z.infer<typeof ConsoleSpendPoint>;

export const ConsoleModelSpend = /* @__PURE__ */ defineSchema(() =>
  z.object({
    model: primitives.string,
    spendMicros: Micros,
    calls: primitives.nonnegativeInteger,
    inputTokens: primitives.nonnegativeInteger,
    outputTokens: primitives.nonnegativeInteger,
    cachedTokens: primitives.nonnegativeInteger,
  }),
);
export type ConsoleModelSpend = z.infer<typeof ConsoleModelSpend>;

/** Overview and Usage: organization totals for one range. */
export const ConsoleSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    range: ConsoleRange,
    since: primitives.dateTime,
    until: primitives.dateTime,
    reviewLevel: ConsoleReviewLevel,
    spend: z.object({
      totalMicros: Micros,
      managedMicros: Micros,
      teamMicros: Micros,
      /** Personal workspaces and charges not tied to a workspace. */
      otherMicros: Micros,
      byDay: z.array(ConsoleSpendPoint),
      byModel: z.array(ConsoleModelSpend).max(20),
    }),
    workspaces: z.object({
      managed: primitives.nonnegativeInteger,
      team: primitives.nonnegativeInteger,
    }),
    /** Root sessions active in the range, in managed workspaces. */
    managedSessions: primitives.nonnegativeInteger,
    /** Distinct end users with a session active in the range, in managed workspaces. */
    endUsers: primitives.nonnegativeInteger,
    /** Set when the session counts stopped early on a very large organization. */
    countsTruncated: primitives.boolean,
  }),
);
export type ConsoleSummary = z.infer<typeof ConsoleSummary>;

export const ListConsoleWorkspacesQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    range: ConsoleRange.default("30d"),
    kind: z.enum(["all", "managed", "team"]).default("all"),
  }),
);
export type ListConsoleWorkspacesQuery = z.infer<typeof ListConsoleWorkspacesQuery>;

export const ConsoleWorkspace = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    name: primitives.string,
    kind: ConsoleWorkspaceKind,
    managedSource: ConsoleManagedSource.nullable(),
    /** The organization API key that created it, when known. */
    createdByApiKeyId: primitives.nullableUuid,
    externalSource: primitives.nullableString,
    externalId: primitives.nullableString,
    createdAt: primitives.dateTime,
    spendMicros: Micros,
    /** Root sessions active in the range (a count only; team workspace content is never shown). */
    sessions: primitives.nonnegativeInteger,
    lastActivityAt: primitives.dateTime.nullable(),
  }),
);
export type ConsoleWorkspace = z.infer<typeof ConsoleWorkspace>;

export const ConsoleWorkspaceListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    range: ConsoleRange,
    since: primitives.dateTime,
    until: primitives.dateTime,
    workspaces: z.array(ConsoleWorkspace),
  }),
);
export type ConsoleWorkspaceListResponse = z.infer<typeof ConsoleWorkspaceListResponse>;

export const UpdateConsoleWorkspaceRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ kind: ConsoleWorkspaceKind }).strict(),
);
export type UpdateConsoleWorkspaceRequest = z.infer<typeof UpdateConsoleWorkspaceRequest>;

export const ConsoleEndUser = /* @__PURE__ */ defineSchema(() =>
  z.object({
    subjectId: primitives.string,
    /** The product's own id for the user (`asUser(id)`), when Opengeni knows it. */
    externalId: primitives.nullableString,
    source: primitives.nullableString,
  }),
);
export type ConsoleEndUser = z.infer<typeof ConsoleEndUser>;

export const ConsoleFeedbackSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    positive: primitives.nonnegativeInteger,
    negative: primitives.nonnegativeInteger,
  }),
);
export type ConsoleFeedbackSummary = z.infer<typeof ConsoleFeedbackSummary>;

export const ConsoleSessionSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    workspaceId: primitives.uuid,
    workspaceName: primitives.string,
    /** Null when the review level is `metadata`. */
    title: primitives.nullableString,
    /** The opening message, shortened; null when the review level is `metadata`. */
    firstMessage: primitives.nullableString,
    visibility: z.enum(["workspace", "private"]),
    endUser: ConsoleEndUser.nullable(),
    status: primitives.string,
    feedback: ConsoleFeedbackSummary,
    turns: primitives.nonnegativeInteger,
    costMicros: Micros,
    createdAt: primitives.dateTime,
    updatedAt: primitives.dateTime,
  }),
);
export type ConsoleSessionSummary = z.infer<typeof ConsoleSessionSummary>;

export const ListConsoleSessionsQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
    workspaceId: primitives.optionalUuid,
    /** Matches the title and opening message; only with the `full` review level. */
    q: z.string().trim().min(1).max(200).optional(),
  }),
);
export type ListConsoleSessionsQuery = z.infer<typeof ListConsoleSessionsQuery>;

export const ConsoleSessionListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    reviewLevel: ConsoleReviewLevel,
    sessions: z.array(ConsoleSessionSummary),
    nextCursor: primitives.nullableString,
    /** True when the organization has more managed workspaces than one list reads. */
    truncated: z.boolean().default(false),
  }),
);
export type ConsoleSessionListResponse = z.infer<typeof ConsoleSessionListResponse>;

export const ConsoleSessionFeedback = /* @__PURE__ */ defineSchema(() =>
  z.object({
    sentiment: z.enum(["positive", "negative"]).nullable(),
    /** Null when the review level is `metadata`. */
    comment: primitives.nullableString,
    turnId: primitives.nullableUuid,
    createdAt: primitives.dateTime,
  }),
);
export type ConsoleSessionFeedback = z.infer<typeof ConsoleSessionFeedback>;

export const ConsoleSessionDetail = /* @__PURE__ */ defineSchema(() =>
  z.object({
    reviewLevel: ConsoleReviewLevel,
    session: ConsoleSessionSummary,
    model: primitives.nullableString,
    reasoningEffort: primitives.nullableString,
    /** First to last activity. */
    durationMs: primitives.nonnegativeInteger,
    tokens: z.object({
      input: primitives.nonnegativeInteger,
      output: primitives.nonnegativeInteger,
      cached: primitives.nonnegativeInteger,
      total: primitives.nonnegativeInteger,
    }),
    modelCalls: primitives.nonnegativeInteger,
    models: z.array(primitives.string),
    toolCalls: primitives.nonnegativeInteger,
    feedback: z.array(ConsoleSessionFeedback),
    /** Set when this read was written to the audit log. */
    auditEventId: primitives.nullableUuid,
  }),
);
export type ConsoleSessionDetail = z.infer<typeof ConsoleSessionDetail>;

export const ConsoleSessionEventsQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(500).default(250),
  }),
);
export type ConsoleSessionEventsQuery = z.infer<typeof ConsoleSessionEventsQuery>;

export const ConsoleAuditAction = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "session.transcript_viewed",
    "session.metadata_viewed",
    "settings.review_level_changed",
    "workspace.kind_changed",
  ]),
);
export type ConsoleAuditAction = z.infer<typeof ConsoleAuditAction>;

export const ConsoleAuditEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    action: ConsoleAuditAction,
    actorSubjectId: primitives.string,
    actorLabel: primitives.nullableString,
    workspaceId: primitives.nullableUuid,
    workspaceName: primitives.nullableString,
    sessionId: primitives.nullableUuid,
    detail: z.record(z.string(), z.unknown()),
    createdAt: primitives.dateTime,
  }),
);
export type ConsoleAuditEvent = z.infer<typeof ConsoleAuditEvent>;

export const ListConsoleAuditEventsQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(512).optional(),
    sessionId: primitives.optionalUuid,
  }),
);
export type ListConsoleAuditEventsQuery = z.infer<typeof ListConsoleAuditEventsQuery>;

export const ConsoleAuditEventListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    events: z.array(ConsoleAuditEvent),
    nextCursor: primitives.nullableString,
  }),
);
export type ConsoleAuditEventListResponse = z.infer<typeof ConsoleAuditEventListResponse>;

/** Console's view of an organization API key, beside the ordinary key record. */
export const ConsoleApiKeyUsage = /* @__PURE__ */ defineSchema(() =>
  z.object({
    apiKeyId: primitives.uuid,
    /** The person (or key) that created it, when known. */
    createdBySubjectId: primitives.nullableString,
    /** Managed workspaces this key created. */
    managedWorkspaces: primitives.nonnegativeInteger,
    /** Spend in the range in the managed workspaces this key created. */
    spendMicros: Micros,
  }),
);
export type ConsoleApiKeyUsage = z.infer<typeof ConsoleApiKeyUsage>;

export const ConsoleApiKeyUsageResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    range: ConsoleRange,
    since: primitives.dateTime,
    until: primitives.dateTime,
    apiKeys: z.array(ConsoleApiKeyUsage),
  }),
);
export type ConsoleApiKeyUsageResponse = z.infer<typeof ConsoleApiKeyUsageResponse>;
