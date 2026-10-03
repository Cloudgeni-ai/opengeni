import { z } from "zod";

/** Credit amounts are integer USD micros (1 USD = 1,000,000), never floating-point dollars. */
export const AllowanceCredits = z.number().int().nonnegative().safe();
const Version = z.number().int().nonnegative().safe();
const Timestamp = z.string().datetime({ offset: true });
const OperationId = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !value.includes("\0") &&
      !/[\uD800-\uDFFF]/u.test(value) &&
      new TextEncoder().encode(value).byteLength <= 256,
  );
const SubjectId = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes("\0"));

/**
 * A share scales with the current workspace pool, including unexpired grants.
 * Shares may exceed 1 and their sum may exceed 1: they are ceilings, not reserved
 * allocations. Concurrent/in-flight calls can overshoot a ceiling; enforcement
 * happens before the next call, after actual usage is settled.
 * null removes the override and uses the workspace's memberDefault.
 */
export const MemberAllowanceRule = z.union([
  z.object({ share: z.number().finite().nonnegative() }).strict(),
  z.object({ credits: AllowanceCredits }).strict(),
  z.null(),
]);
export type MemberAllowanceRule = z.infer<typeof MemberAllowanceRule>;

export const MemberAllowanceDefault = z.union([
  z.enum(["none", "equal_share"]),
  z.object({ share: z.number().finite().nonnegative() }).strict(),
  z.object({ credits: AllowanceCredits }).strict(),
]);
export type MemberAllowanceDefault = z.infer<typeof MemberAllowanceDefault>;

const Thresholds = z.array(z.number().finite().positive().max(1)).max(16);
/** Omitted threshold lists default to [0.8, 1]. Monthly boundaries are UTC. */
export const WorkspaceAllowanceConfig = z
  .object({
    includedCredits: AllowanceCredits,
    period: z.enum(["monthly", "none"]),
    anchorDay: z.number().int().min(1).max(31).optional(),
    memberDefault: MemberAllowanceDefault.optional(),
    thresholds: z
      .object({ workspace: Thresholds.optional(), member: Thresholds.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type WorkspaceAllowanceConfig = z.infer<typeof WorkspaceAllowanceConfig>;

export const WorkspaceAllowance = WorkspaceAllowanceConfig.extend({ version: Version.min(1) });
export type WorkspaceAllowance = z.infer<typeof WorkspaceAllowance>;
/**
 * Lifecycle version survives clear. version=0 means never configured; a null
 * config with a positive version is cleared. Use this version for recreation.
 * The existing nullable configuration read remains unchanged.
 */
export const WorkspaceAllowanceState = z
  .object({ version: Version, config: WorkspaceAllowance.nullable() })
  .strict()
  .refine((state) => state.config === null || state.config.version === state.version, {
    message: "Allowance configuration and lifecycle versions must match",
    path: ["config", "version"],
  });
export type WorkspaceAllowanceState = z.infer<typeof WorkspaceAllowanceState>;
export const SetWorkspaceAllowanceRequest = WorkspaceAllowanceConfig.extend({
  expectedVersion: Version,
});
export type SetWorkspaceAllowanceRequest = z.infer<typeof SetWorkspaceAllowanceRequest>;
/** Reuse operationId and the exact expectedVersion to recover a lost clear
 * receipt. A later lifecycle change conflicts; read the state before deciding
 * on a new mutation, never guess a version or change it for a retry. */
export const ClearWorkspaceAllowanceRequest = z
  .object({ expectedVersion: Version.min(1), operationId: OperationId.optional() })
  .strict();
export type ClearWorkspaceAllowanceRequest = z.infer<typeof ClearWorkspaceAllowanceRequest>;
export const ClearWorkspaceAllowanceResponse = z.object({ version: Version.min(1) }).strict();
export type ClearWorkspaceAllowanceResponse = z.infer<typeof ClearWorkspaceAllowanceResponse>;

/** Reuse the operationId and exact request to recover an uncertain grant response. */
export const GrantWorkspaceCreditsRequest = z
  .object({
    operationId: OperationId,
    credits: AllowanceCredits.positive(),
    expiresAt: Timestamp.nullable().optional(),
  })
  .strict();
export type GrantWorkspaceCreditsRequest = z.infer<typeof GrantWorkspaceCreditsRequest>;
export const WorkspaceCreditGrant = GrantWorkspaceCreditsRequest.extend({
  remaining: AllowanceCredits,
  expiresAt: Timestamp.nullable(),
});
export type WorkspaceCreditGrant = z.infer<typeof WorkspaceCreditGrant>;

export const SetMemberAllowanceRequest = z
  .object({
    rule: MemberAllowanceRule,
    expectedVersion: Version,
  })
  .strict();
export type SetMemberAllowanceRequest = z.infer<typeof SetMemberAllowanceRequest>;
export const MemberAllowance = z
  .object({
    subjectId: SubjectId,
    rule: MemberAllowanceRule,
    version: Version,
  })
  .strict();
export type MemberAllowance = z.infer<typeof MemberAllowance>;

export const UsageAllowancePeriod = z.union([
  z.literal("current"),
  z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
]);
export type UsageAllowancePeriod = z.infer<typeof UsageAllowancePeriod>;
export const GetUsageRequest = z
  .object({
    period: UsageAllowancePeriod.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type GetUsageRequest = z.infer<typeof GetUsageRequest>;
export const GetMyUsageRequest = GetUsageRequest.pick({ period: true });
export type GetMyUsageRequest = z.infer<typeof GetMyUsageRequest>;

export const UsageAllowanceStatus = z.enum(["ok", "warning", "exhausted"]);
export type UsageAllowanceStatus = z.infer<typeof UsageAllowanceStatus>;
export const UsageAllowanceWindow = z
  .object({
    start: Timestamp.nullable(),
    end: Timestamp.nullable(),
  })
  .strict();
export type UsageAllowanceWindow = z.infer<typeof UsageAllowanceWindow>;
const Usage = z.object({
  limit: AllowanceCredits.nullable(),
  used: AllowanceCredits,
  remaining: z.number().int().safe().nullable(),
  /** Display this ratio rather than raw USD micros in human-facing products. */
  fraction: z.number().finite().nonnegative().nullable(),
  status: UsageAllowanceStatus,
  resetsAt: Timestamp.nullable(),
});
export const WorkspaceAllowanceUsage = Usage.extend({
  includedCredits: AllowanceCredits,
  grantsRemaining: AllowanceCredits,
}).strict();
export type WorkspaceAllowanceUsage = z.infer<typeof WorkspaceAllowanceUsage>;
export const MemberAllowanceUsage = Usage.extend({
  subjectId: SubjectId,
  externalIdentity: z.object({ source: z.string(), externalId: z.string() }).strict().nullable(),
  rule: MemberAllowanceRule,
  version: Version,
}).strict();
export type MemberAllowanceUsage = z.infer<typeof MemberAllowanceUsage>;
/** /usage/me returns only the authenticated subject's member row, never the roster. */
export const WorkspaceUsageResponse = z
  .object({
    period: UsageAllowanceWindow,
    workspace: WorkspaceAllowanceUsage,
    members: z.array(MemberAllowanceUsage),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type WorkspaceUsageResponse = z.infer<typeof WorkspaceUsageResponse>;

export const AllowanceExhaustedRefusal = z
  .object({
    code: z.literal("allowance_exhausted"),
    scope: z.enum(["workspace", "member"]),
    resetsAt: Timestamp.nullable(),
    subjectId: SubjectId.optional(),
    message: z.string(),
  })
  .strict();
export type AllowanceExhaustedRefusal = z.infer<typeof AllowanceExhaustedRefusal>;
