import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { currentCreditDebitAttribution } from "./credit-debit-attribution";

/** All amounts are integer USD micros, never dollars or floating-point credits. */
export type MemberAllowanceRule = { share: number } | { credits: number } | null;
export type WorkspaceAllowanceConfig = {
  includedCredits: number;
  period: "monthly" | "none";
  anchorDay?: number;
  memberDefault?: "none" | "equal_share" | Exclude<MemberAllowanceRule, null>;
  thresholds?: { workspace?: number[]; member?: number[] };
};
export type WorkspaceAllowance = WorkspaceAllowanceConfig & { version: number };
export type AllowanceStatus = "ok" | "warning" | "exhausted";
export type AllowanceUsage = {
  limit: number | null;
  used: number;
  remaining: number | null;
  fraction: number | null;
  status: AllowanceStatus;
  resetsAt: string | null;
};
export type MemberAllowance = {
  subjectId: string;
  rule: MemberAllowanceRule;
  version: number;
};
export type WorkspaceUsage = {
  period: { start: string | null; end: string | null };
  workspace: AllowanceUsage & { includedCredits: number; grantsRemaining: number };
  members: (AllowanceUsage &
    MemberAllowance & {
      externalIdentity: { source: string; externalId: string } | null;
    })[];
  nextCursor: string | null;
};
export type AllowanceExhausted = {
  code: "allowance_exhausted";
  scope: "workspace" | "member";
  resetsAt: string | null;
  subjectId?: string;
  message: string;
};
type Scope = { accountId: string; workspaceId: string };
type Actor = { actorSubjectId: string; actorType?: string | undefined };

export class UsageAllowanceVersionConflictError extends Error {
  constructor() {
    super("Usage allowance version conflict");
    this.name = "UsageAllowanceVersionConflictError";
  }
}

function amount(value: number, name: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(
      `${name} must be ${positive ? "a positive" : "a non-negative"} safe integer in USD micros`,
    );
  }
}

export function validateMemberAllowanceRule(rule: MemberAllowanceRule): void {
  if (rule === null) return;
  if ("credits" in rule) {
    if (Object.keys(rule).length !== 1)
      throw new Error("Member rule must have only credits or share");
    amount(rule.credits, "credits");
  } else if ("share" in rule) {
    if (Object.keys(rule).length !== 1 || !Number.isFinite(rule.share) || rule.share < 0) {
      throw new Error("share must be a finite non-negative number");
    }
  } else {
    throw new Error("Member rule must have credits or share");
  }
}

export function validateWorkspaceAllowanceConfig(config: WorkspaceAllowanceConfig): void {
  amount(config.includedCredits, "includedCredits");
  if (config.period !== "monthly" && config.period !== "none")
    throw new Error("Invalid allowance period");
  if (
    config.anchorDay !== undefined &&
    (!Number.isInteger(config.anchorDay) || config.anchorDay < 1 || config.anchorDay > 31)
  ) {
    throw new Error("anchorDay must be an integer from 1 to 31");
  }
  if (
    config.memberDefault !== undefined &&
    config.memberDefault !== "none" &&
    config.memberDefault !== "equal_share"
  ) {
    validateMemberAllowanceRule(config.memberDefault);
  }
  for (const list of [config.thresholds?.workspace, config.thresholds?.member]) {
    if (
      list !== undefined &&
      (list.length > 16 ||
        list.some((threshold) => !Number.isFinite(threshold) || threshold <= 0 || threshold > 1))
    ) {
      throw new Error(
        "thresholds must contain at most 16 fractions greater than zero and at most one",
      );
    }
  }
}

async function command<T>(db: Database, input: Scope & Record<string, unknown>): Promise<T> {
  if (
    ["set", "clear", "member", "grant"].includes(String(input.action)) &&
    currentCreditDebitAttribution().kind === "turn"
  ) {
    // This context is installed by the authenticated request boundary, not
    // supplied in the allowance command. Agent attempts cannot substitute
    // human-looking actor labels to author allowance policy.
    throw new Error("Agent attempts cannot change usage allowances");
  }
  try {
    return await withRlsContext(db, input, async (scoped) => {
      if (typeof input.actorSubjectId === "string")
        await setSubjectRlsContext(scoped, input.actorSubjectId);
      const [row] = await rawRows<{ result: T }>(
        scoped,
        sql`select usage_allowance_command(${JSON.stringify(input)}::jsonb) as result`,
      );
      if (!row) throw new Error("Usage allowance command returned no result");
      return row.result;
    });
  } catch (error) {
    const cause = error as { code?: string; cause?: { code?: string } };
    if ((cause.code ?? cause.cause?.code) === "40001")
      throw new UsageAllowanceVersionConflictError();
    throw error;
  }
}

function actor(input: Actor): Actor & { actorType: string } {
  return { actorSubjectId: input.actorSubjectId, actorType: input.actorType ?? "subject" };
}
function version(value: number): void {
  amount(value, "expectedVersion");
}

export async function getWorkspaceAllowance(
  db: Database,
  input: Scope,
): Promise<WorkspaceAllowance | null> {
  return await command(db, { ...input, action: "get" });
}

export async function setWorkspaceAllowance(
  db: Database,
  input: Scope & Actor & WorkspaceAllowanceConfig & { expectedVersion: number },
): Promise<WorkspaceAllowance> {
  const { accountId, workspaceId, expectedVersion, actorSubjectId, actorType } = input;
  const config: WorkspaceAllowanceConfig = {
    includedCredits: input.includedCredits,
    period: input.period,
    ...(input.anchorDay === undefined ? {} : { anchorDay: input.anchorDay }),
    ...(input.memberDefault === undefined ? {} : { memberDefault: input.memberDefault }),
    ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
  };
  version(expectedVersion);
  validateWorkspaceAllowanceConfig(config);
  return await command(db, {
    accountId,
    workspaceId,
    expectedVersion,
    ...actor({ actorSubjectId, actorType }),
    action: "set",
    config,
  });
}

export async function clearWorkspaceAllowance(
  db: Database,
  input: Scope & Actor & { expectedVersion: number },
): Promise<{ version: number }> {
  version(input.expectedVersion);
  if (input.expectedVersion === 0) throw new UsageAllowanceVersionConflictError();
  return await command(db, { ...input, ...actor(input), action: "clear" });
}

export async function grantWorkspaceCredits(
  db: Database,
  input: Scope & Actor & { operationId: string; credits: number; expiresAt?: string | null },
): Promise<{ operationId: string; credits: number; remaining: number; expiresAt: string | null }> {
  amount(input.credits, "credits", true);
  if (!input.operationId.trim() || new TextEncoder().encode(input.operationId).length > 256) {
    throw new Error("operationId must be non-empty and at most 256 bytes");
  }
  if (input.expiresAt != null && !Number.isFinite(Date.parse(input.expiresAt)))
    throw new Error("Invalid grant expiresAt");
  return await command(db, {
    ...input,
    ...actor(input),
    expiresAt: input.expiresAt ?? null,
    action: "grant",
  });
}

export async function setMemberAllowance(
  db: Database,
  input: Scope &
    Actor & { rule: MemberAllowanceRule; expectedVersion: number } & (
      | { subjectId: string; externalIdentity?: never }
      | { externalIdentity: { source: string; externalId: string }; subjectId?: never }
    ),
): Promise<MemberAllowance> {
  version(input.expectedVersion);
  validateMemberAllowanceRule(input.rule);
  return await command(db, { ...input, ...actor(input), action: "member" });
}

type RawUsage = {
  config: WorkspaceAllowanceConfig | null;
  period: WorkspaceUsage["period"];
  used: number;
  includedUsed: number;
  grantsUsed: number;
  grantsRemaining: number;
  memberCount: number;
  members: (MemberAllowance & {
    used: number;
    externalIdentity: { source: string; externalId: string } | null;
  })[];
};

export function allowanceUsage(
  limit: number | null,
  used: number,
  resetsAt: string | null,
  thresholds = [0.8, 1],
): AllowanceUsage {
  const fraction = limit === null ? null : limit === 0 ? 1 : used / limit;
  const remaining = limit === null ? null : Math.max(0, limit - used);
  return {
    limit,
    used,
    remaining,
    fraction,
    status:
      remaining === 0
        ? "exhausted"
        : fraction !== null && thresholds.some((t) => fraction >= t)
          ? "warning"
          : "ok",
    resetsAt,
  };
}

export async function getWorkspaceUsage(
  db: Database,
  input: Scope & {
    period?: "current" | string;
    limit?: number;
    cursor?: string | null;
    subjectId?: string;
  },
): Promise<WorkspaceUsage> {
  if (
    input.period !== undefined &&
    input.period !== "current" &&
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)
  ) {
    throw new Error("period must be current or YYYY-MM");
  }
  const pageSize = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
  const raw = await command<RawUsage>(db, { ...input, limit: pageSize, action: "usage" });
  return projectUsage(raw, pageSize);
}

function projectUsage(raw: RawUsage, pageSize: number): WorkspaceUsage {
  const config = raw.config;
  const pool = config
    ? config.includedCredits + Number(raw.grantsUsed) + Number(raw.grantsRemaining)
    : null;
  const memberPool = config ? config.includedCredits + Number(raw.grantsRemaining) : null;
  const resetsAt = config ? raw.period.end : null;
  const members = raw.members.slice(0, pageSize).map((member) => {
    let rule = member.rule;
    if (rule === null) {
      const fallback = config?.memberDefault ?? "none";
      rule =
        fallback === "none"
          ? null
          : fallback === "equal_share"
            ? { share: raw.memberCount > 0 ? 1 / Number(raw.memberCount) : 0 }
            : fallback;
    }
    const limit =
      rule === null
        ? null
        : "credits" in rule
          ? rule.credits
          : memberPool === null
            ? null
            : Math.min(Number.MAX_SAFE_INTEGER, Math.floor(memberPool * rule.share));
    return {
      ...member,
      rule: member.rule,
      ...allowanceUsage(limit, Number(member.used), resetsAt, config?.thresholds?.member),
    };
  });
  return {
    period: config ? raw.period : { start: null, end: null },
    workspace: {
      ...allowanceUsage(pool, Number(raw.used), resetsAt, config?.thresholds?.workspace),
      includedCredits: config?.includedCredits ?? 0,
      grantsRemaining: Number(raw.grantsRemaining),
    },
    members,
    nextCursor: raw.members.length > pageSize ? members.at(-1)!.subjectId : null,
  };
}

export async function checkWorkspaceAllowance(
  db: Database,
  input: Scope & { subjectId?: string | null },
): Promise<AllowanceExhausted | null> {
  const raw = await command<RawUsage>(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    limit: 1,
    action: "check",
  });
  const usage = projectUsage(raw, 1);
  if (usage.workspace.status === "exhausted") {
    return {
      code: "allowance_exhausted",
      scope: "workspace",
      resetsAt: usage.workspace.resetsAt,
      message: "The workspace usage allowance is exhausted.",
    };
  }
  const member = input.subjectId
    ? usage.members.find((row) => row.subjectId === input.subjectId)
    : null;
  if (member?.status === "exhausted") {
    return {
      code: "allowance_exhausted",
      scope: "member",
      subjectId: member.subjectId,
      resetsAt: member.resetsAt,
      message: "The member usage allowance is exhausted.",
    };
  }
  return null;
}

/** Bounded periodic work, independent of reads/admission and webhook delivery. */
export async function maintainWorkspaceAllowances(
  db: Database,
  input: { limit?: number; memberLimit?: number } = {},
): Promise<number> {
  const [row] = await rawRows<{ processed: number }>(
    db,
    sql`select maintain_usage_allowances(${input.limit ?? 20}::integer,${input.memberLimit ?? 100}::integer) as processed`,
  );
  return Number(row?.processed ?? 0);
}
