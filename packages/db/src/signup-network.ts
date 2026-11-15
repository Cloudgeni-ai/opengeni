import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows, withAccountRls } from "./database";
import { getBillingBalance } from "./credit-balances";
import { nestedPostgresSqlState } from "./persistence-errors";

/**
 * Signup network velocity (migration 1354) and the denied network rule
 * (migration 1368): the post-setup evaluation fan-out and the owner-only
 * operator review helpers. Rows hold keyed hashes only, never addresses, and
 * review output carries a 16-hex group key, email domains and account UUIDs
 * only.
 */

export const SIGNUP_NETWORK_POLICY_VERSION = "ip-velocity-v1";
/** Migration 1368: a network used by a denied or currently held account. */
export const SIGNUP_DENIED_NETWORK_POLICY_VERSION = "denied-network-v1";
/** Detector holds listed by the network review and released by its rollback. */
export const SIGNUP_NETWORK_HOLD_POLICY_VERSIONS = [
  SIGNUP_NETWORK_POLICY_VERSION,
  SIGNUP_DENIED_NETWORK_POLICY_VERSION,
] as const;
export type SignupNetworkHoldPolicyVersion = (typeof SIGNUP_NETWORK_HOLD_POLICY_VERSIONS)[number];
/** Plain review reason for each network hold rule. */
export const SIGNUP_NETWORK_HOLD_REASONS: Record<SignupNetworkHoldPolicyVersion, string> = {
  "ip-velocity-v1": "Several new organizations from one network within the velocity window",
  "denied-network-v1": "Network used in the last 90 days by a denied or currently held account",
};
export const PROMOTION_DETECTOR_ACTOR = "service:promotion-detector";
/** SQLSTATE raised by the setup receipt trigger when the network rate limit refuses. */
export const SIGNUP_NETWORK_RATE_LIMIT_SQLSTATE = "OG429";

/**
 * Evaluates each account in its own transaction under its own account scope,
 * sequentially and best-effort, through the ordinary Free eligibility seam
 * (which runs the abuse detectors and may hold only that account). Failures
 * are reported to `onError` and never thrown; the lazy per-account evaluation
 * at Free issuance and admission remains the correctness backstop.
 */
export async function evaluateSignupNetworkAccounts(
  db: Database,
  accountIds: readonly string[],
  onError: (accountId: string, error: unknown) => void = () => {},
): Promise<{ evaluated: number; failed: number }> {
  let evaluated = 0;
  let failed = 0;
  for (const accountId of new Set(accountIds)) {
    try {
      await withAccountRls(db, accountId, async (tx) => {
        await rawRows(tx, sql`select free_plan_credit_eligible(${accountId}::uuid) as eligible`);
      });
      evaluated += 1;
    } catch (error) {
      failed += 1;
      onError(accountId, error);
    }
  }
  return { evaluated, failed };
}

export type SignupNetworkVelocitySettings = {
  revision: number;
  mode: "off" | "observe" | "enforce";
  windowHours: number;
  exactHoldThreshold: number;
  prefixHoldThreshold: number | null;
  rateLimitEnabled: boolean;
  rateLimitMax: number;
  rateLimitWindowHours: number;
  /** Migration 1368; "off" until set. Older databases omit it. */
  deniedNetworkMode?: "off" | "observe" | "enforce";
  deniedNetworkLookbackDays?: number;
  operator: string | null;
  changedAt: string | null;
};

export type SignupNetworkVelocityChanges = Partial<
  Pick<
    SignupNetworkVelocitySettings,
    | "mode"
    | "windowHours"
    | "exactHoldThreshold"
    | "prefixHoldThreshold"
    | "rateLimitEnabled"
    | "rateLimitMax"
    | "deniedNetworkMode"
  >
>;

/** Owner connection only. */
export async function readSignupNetworkVelocitySettings(
  ownerDb: Database,
): Promise<SignupNetworkVelocitySettings> {
  const [row] = await rawRows<{ settings: SignupNetworkVelocitySettings }>(
    ownerDb,
    sql`select opengeni_private.signup_network_velocity_settings(
      session_tenancy_fence_target_schema()::regnamespace::text) as settings`,
  );
  return row!.settings;
}

/** Owner connection only; revision-fenced (SQLSTATE 40001 when stale). */
export async function setSignupNetworkVelocitySettings(
  ownerDb: Database,
  input: {
    changes: SignupNetworkVelocityChanges;
    operator: string;
    reason: string;
    expectedRevision: number;
  },
): Promise<{ previous: SignupNetworkVelocitySettings; current: SignupNetworkVelocitySettings }> {
  const [row] = await rawRows<{
    result: { previous: SignupNetworkVelocitySettings; current: SignupNetworkVelocitySettings };
  }>(
    ownerDb,
    sql`select opengeni_private.set_signup_network_velocity(
      ${JSON.stringify(input.changes)}::jsonb, ${input.operator}, ${input.reason},
      ${input.expectedRevision}::bigint) as result`,
  );
  return row!.result;
}

export type SignupNetworkHoldAccount = {
  accountId: string;
  decision: string;
  revision: number;
  actor: string;
  decidedAt: string;
  ruleId: string | null;
  policyVersion: string | null;
  /** Why the detector held the account (see SIGNUP_NETWORK_HOLD_REASONS). */
  reason: string;
  /** Null when the API had no trusted client address at setup. */
  addressGroup: string | null;
  prefixGroup: string | null;
  exactGroupSize: number | null;
  prefixGroupSize: number | null;
  /** denied-network-v1 evidence; null for ip-velocity-v1 holds. */
  deniedNetwork: {
    deniedAccounts: number | null;
    heldAccounts: number | null;
    matchedVia: string[];
    matchedAccountIds: string[];
    lastFlaggedUseAt: string | null;
  } | null;
  signupAt: string | null;
  setUpAt: string | null;
  emailDomain: string | null;
  chats: number | null;
  sessions: number | null;
  directApiSpendMicros: number | null;
  inAppSpendMicros: number | null;
  otherSpendMicros: number | null;
  freeGrantedMicros: number | null;
  freeUsedMicros: number | null;
  /** From the ordinary billing projection: purchased credit, paid-plan credit and credit on hold. */
  balance: {
    creditsMicros: number;
    paidPlanCreditMicros: number;
    heldCreditMicros: number;
    balanceMicros: number;
  } | null;
  unreadable: string[];
};

export type SignupNetworkHoldGroup = {
  addressGroup: string;
  /** Self-serve organizations from this exact network in the last 7 days (bounded at 200). */
  recentOrganizations: number;
  /** Distinct /24 or /48 prefix groups among them. */
  prefixGroups: string[];
  firstSetUpAt: string | null;
  lastSetUpAt: string | null;
  heldAccounts: number;
  members: {
    accountId: string;
    setUpAt: string;
    decision: string | null;
    revision: number;
    actor: string | null;
  }[];
};

export type SignupNetworkHolds = {
  schemaVersion: 2;
  policyVersions: readonly SignupNetworkHoldPolicyVersion[];
  settings: SignupNetworkVelocitySettings;
  /**
   * Denied or held accounts, how many owners the denied network rule has
   * captured, how many have no self-serve owner to capture, and the oldest
   * capture of a currently flagged account (sign-ins after it are not yet
   * captured; --network-capture-flagged refreshes it).
   */
  deniedNetworkCoverage: {
    flaggedAccounts: number;
    capturedOwners: number;
    withoutSelfServeOwner: number;
    oldestCaptureAt: string | null;
  } | null;
  holdCount: number;
  truncated: boolean;
  accounts: SignupNetworkHoldAccount[];
  groups: SignupNetworkHoldGroup[];
};

class RolledBackRead<T> extends Error {
  constructor(readonly value: T) {
    super("rolled back read");
  }
}

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/**
 * Pending detector holds from the network rules (velocity and denied network)
 * with per-account and per-network evidence, for an operator or agent reviewer. Owner connection
 * only; every read runs in one transaction that is always rolled back. A part
 * that cannot be read is null and named in `unreadable`.
 */
export async function listSignupNetworkHolds(
  ownerDb: Database,
  options: { limit?: number } = {},
): Promise<SignupNetworkHolds> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const settings = await readSignupNetworkVelocitySettings(ownerDb);
  try {
    await ownerDb.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await rawRows(txDb, sql`set transaction isolation level repeatable read`);
      await rawRows(txDb, sql`set local statement_timeout = '60s'`);
      await rawRows(
        txDb,
        sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`,
      );
      await rawRows(
        txDb,
        sql`select opengeni_private.open_session_tenancy_fence_inventory(session_tenancy_fence_target_schema())`,
      );
      const holds = await rawRows<Record<string, unknown>>(
        txDb,
        sql`select d.account_id::text as account_id, d.decision, d.revision::int as revision, d.actor,
          d.updated_at, h.rule_id, h.policy_version, h.evidence, s.address_hash, s.prefix_hash,
          s.set_up_at, s.owner_auth_user_id
        from promotion_decisions d
        join opengeni_private.promotion_decision_history h
          on h.data_schema = session_tenancy_fence_target_schema()::regnamespace::text
          and h.account_id = d.account_id and h.revision = d.revision
        left join opengeni_private.signup_network_sources s
          on s.data_schema = h.data_schema and s.account_id = d.account_id
        where d.decision = 'held' and d.actor = ${PROMOTION_DETECTOR_ACTOR}
          and h.policy_version in (${SIGNUP_NETWORK_POLICY_VERSION}, ${SIGNUP_DENIED_NETWORK_POLICY_VERSION})
        order by coalesce(s.set_up_at, d.updated_at) desc, d.account_id limit ${limit + 1}`,
      );
      const selected = holds.slice(0, limit);
      const accounts: SignupNetworkHoldAccount[] = [];
      for (const hold of selected) accounts.push(await readHoldAccount(txDb, hold));
      const groups: SignupNetworkHoldGroup[] = [];
      const addressHashes = [
        ...new Set(
          selected
            .map((hold) => hold.address_hash)
            .filter((hash): hash is string => typeof hash === "string"),
        ),
      ];
      for (const addressHash of addressHashes) groups.push(await readHoldGroup(txDb, addressHash));
      // Last statement before the rollback: a failure here aborts nothing
      // that is still read, so it only nulls the coverage.
      let deniedNetworkCoverage: SignupNetworkHolds["deniedNetworkCoverage"] = null;
      try {
        const [coverage] = await rawRows<Record<string, unknown>>(
          txDb,
          sql`select count(*)::int as flagged, count(f.account_id)::int as captured,
              count(*) filter (where not exists (select 1 from managed_accounts a
                where a.id = d.account_id and a.external_source = 'better-auth:user'))::int as without_owner,
              min(f.captured_at) as oldest
            from promotion_decisions d
            left join opengeni_private.signup_network_flagged_owners f
              on f.data_schema = session_tenancy_fence_target_schema()::regnamespace::text
              and f.account_id = d.account_id
            where d.decision in ('denied', 'held')`,
        );
        deniedNetworkCoverage = {
          flaggedAccounts: Number(coverage!.flagged),
          capturedOwners: Number(coverage!.captured),
          withoutSelfServeOwner: Number(coverage!.without_owner),
          oldestCaptureAt: iso(coverage!.oldest),
        };
      } catch {
        deniedNetworkCoverage = null;
      }
      throw new RolledBackRead<SignupNetworkHolds>({
        schemaVersion: 2,
        policyVersions: SIGNUP_NETWORK_HOLD_POLICY_VERSIONS,
        settings,
        deniedNetworkCoverage,
        holdCount: accounts.length,
        truncated: holds.length > limit,
        accounts,
        groups: groups.sort((a, b) => b.recentOrganizations - a.recentOrganizations),
      });
    });
  } catch (error) {
    if (error instanceof RolledBackRead) {
      const result = error.value as SignupNetworkHolds;
      for (const account of result.accounts) {
        try {
          const balance = await withAccountRls(
            ownerDb,
            account.accountId,
            async (tx) => await getBillingBalance(tx, account.accountId),
          );
          account.balance = {
            creditsMicros: balance.creditsMicros ?? 0,
            paidPlanCreditMicros: balance.paidPlanCreditMicros ?? 0,
            heldCreditMicros: balance.heldCreditMicros ?? 0,
            balanceMicros: balance.balanceMicros,
          };
        } catch {
          account.unreadable.push("balance");
        }
      }
      return result;
    }
    throw error;
  }
  throw new Error("signup network holds read did not roll back");
}

/** One read under a savepoint; a failure yields null and the part's name. */
async function part<T>(
  tx: Database,
  name: string,
  unreadable: string[],
  read: (db: Database) => Promise<T>,
): Promise<T | null> {
  try {
    return await tx.transaction(async (savepoint) => await read(savepoint as unknown as Database));
  } catch {
    unreadable.push(name);
    return null;
  }
}

async function readHoldAccount(
  tx: Database,
  hold: Record<string, unknown>,
): Promise<SignupNetworkHoldAccount> {
  const accountId = String(hold.account_id);
  const unreadable: string[] = [];
  const evidence = (hold.evidence ?? {}) as Record<string, unknown>;
  await rawRows(
    tx,
    sql`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', '', true), set_config('opengeni.subject_id', '', true)`,
  );
  const owner = await part(tx, "owner", unreadable, async (db) => {
    // The setup record names the owner; without one (no trusted address at
    // setup), the account's owning user.
    const [row] = await rawRows<{ created_at: unknown; email_domain: string | null }>(
      db,
      sql`select created_at, nullif(lower(substring(email from '@([^@]*)$')), '') as email_domain
        from auth_users where id = coalesce(${(hold.owner_auth_user_id as string | null) ?? null}::text,
          (select external_id from managed_accounts
            where id = ${accountId}::uuid and external_source = 'better-auth:user'))`,
    );
    return row ?? null;
  });
  const chats = await part(tx, "chats", unreadable, async (db) => {
    const [row] = await rawRows<{ sessions: number; top_level: number }>(
      db,
      sql`select count(*)::int as sessions,
        (count(*) filter (where parent_session_id is null))::int as top_level
        from sessions where account_id = ${accountId}::uuid`,
    );
    return row ?? { sessions: 0, top_level: 0 };
  });
  const spend = await part(tx, "spend", unreadable, async (db) => {
    const workspaces = await rawRows<{ workspace_id: string }>(
      db,
      sql`select distinct workspace_id::text as workspace_id from usage_events
        where account_id = ${accountId}::uuid and event_type = 'model.cost' limit 50`,
    );
    const total = { direct: 0, session: 0, other: 0 };
    for (const { workspace_id: workspaceId } of workspaces) {
      await rawRows(db, sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`);
      const rows = await rawRows<{ kind: keyof typeof total; micros: string }>(
        db,
        sql`select case when session_id is not null then 'session'
            when source_resource_id like 'model_call:%' then 'direct' else 'other' end as kind,
          coalesce(sum(quantity), 0)::text as micros
        from usage_events where account_id = ${accountId}::uuid and workspace_id = ${workspaceId}::uuid
          and event_type = 'model.cost' group by 1`,
      );
      for (const row of rows) total[row.kind] += Math.round(Number(row.micros));
    }
    await rawRows(db, sql`select set_config('opengeni.workspace_id', '', true)`);
    return total;
  });
  const free = await part(tx, "freeCredit", unreadable, async (db) => {
    const [row] = await rawRows<{ granted: string; used: string }>(
      db,
      sql`select coalesce(sum(p.granted_micros), 0)::text as granted,
        coalesce(sum(opengeni_private.plan_period_usage(p, clock_timestamp())), 0)::text as used
        from plan_credit_periods p where p.account_id = ${accountId}::uuid and p.plan_key = 'free'`,
    );
    return row ?? null;
  });
  const policyVersion = (hold.policy_version as string | null) ?? null;
  const deniedNetwork = policyVersion === SIGNUP_DENIED_NETWORK_POLICY_VERSION;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    accountId,
    decision: String(hold.decision),
    revision: Number(hold.revision),
    actor: String(hold.actor),
    decidedAt: iso(hold.updated_at)!,
    ruleId: (hold.rule_id as string | null) ?? null,
    policyVersion,
    reason: SIGNUP_NETWORK_HOLD_REASONS[deniedNetwork ? "denied-network-v1" : "ip-velocity-v1"],
    addressGroup: typeof hold.address_hash === "string" ? hold.address_hash.slice(0, 16) : null,
    prefixGroup: typeof hold.prefix_hash === "string" ? hold.prefix_hash.slice(0, 16) : null,
    exactGroupSize: num(evidence.exactGroupSize),
    prefixGroupSize: num(evidence.prefixGroupSize),
    deniedNetwork: deniedNetwork
      ? {
          deniedAccounts: num(evidence.deniedAccounts),
          heldAccounts: num(evidence.heldAccounts),
          matchedVia: strings(evidence.matchedVia),
          matchedAccountIds: strings(evidence.matchedAccountIds),
          lastFlaggedUseAt:
            typeof evidence.lastFlaggedUseAt === "string" ? evidence.lastFlaggedUseAt : null,
        }
      : null,
    signupAt: iso(owner?.created_at),
    setUpAt:
      iso(hold.set_up_at) ?? (typeof evidence.setUpAt === "string" ? evidence.setUpAt : null),
    emailDomain: owner?.email_domain ?? null,
    chats: chats ? chats.top_level : null,
    sessions: chats ? chats.sessions : null,
    directApiSpendMicros: spend ? spend.direct : null,
    inAppSpendMicros: spend ? spend.session : null,
    otherSpendMicros: spend ? spend.other : null,
    freeGrantedMicros: free ? Number(free.granted) : null,
    freeUsedMicros: free ? Math.round(Number(free.used)) : null,
    balance: null,
    unreadable,
  };
}

async function readHoldGroup(tx: Database, addressHash: string): Promise<SignupNetworkHoldGroup> {
  const members = await rawRows<Record<string, unknown>>(
    tx,
    sql`select s.account_id::text as account_id, s.set_up_at, s.prefix_hash,
      d.decision, coalesce(d.revision, 0)::int as revision, d.actor
    from opengeni_private.signup_network_sources s
    left join promotion_decisions d on d.account_id = s.account_id
    where s.data_schema = session_tenancy_fence_target_schema()::regnamespace::text
      and s.address_hash = ${addressHash} and s.set_up_at >= clock_timestamp() - interval '7 days'
    order by s.set_up_at, s.account_id limit 200`,
  );
  return {
    addressGroup: addressHash.slice(0, 16),
    recentOrganizations: members.length,
    prefixGroups: [...new Set(members.map((member) => String(member.prefix_hash).slice(0, 16)))],
    firstSetUpAt: iso(members[0]?.set_up_at),
    lastSetUpAt: iso(members.at(-1)?.set_up_at),
    heldAccounts: members.filter((member) => member.decision === "held").length,
    members: members.map((member) => ({
      accountId: String(member.account_id),
      setUpAt: iso(member.set_up_at)!,
      decision: (member.decision as string | null) ?? null,
      revision: Number(member.revision),
      actor: (member.actor as string | null) ?? null,
    })),
  };
}

/**
 * Captures again, account by account, the owners' sign-in networks of every
 * account that is denied or held now (the migration 1368 backfill). Safe to
 * repeat; unchanged rows are not rewritten. Owner connection only.
 */
export async function captureFlaggedSignupNetworkOwners(ownerDb: Database): Promise<{
  flaggedAccounts: number;
  capturedOwners: number;
  withoutSelfServeOwner: number;
  failed: number;
}> {
  const [row] = await rawRows<{ outcome: Record<string, unknown> }>(
    ownerDb,
    sql`select opengeni_private.capture_all_flagged_owner_session_networks(
      session_tenancy_fence_target_schema()::regnamespace::text) as outcome`,
  );
  return {
    flaggedAccounts: Number(row!.outcome.flaggedAccounts),
    capturedOwners: Number(row!.outcome.capturedOwners),
    withoutSelfServeOwner: Number(row!.outcome.withoutSelfServeOwner),
    failed: Number(row!.outcome.failed),
  };
}

/**
 * Rollback helper: releases (decision eligible) every current detector hold
 * from the network rules (both, or only the given policy versions), one
 * account per transaction through the
 * revision-fenced decision setter with an operator actor and reason, so the
 * detector never re-holds them. Owner connection only. A stale revision (an
 * account decided meanwhile) is skipped and reported, never overwritten.
 */
export async function releaseSignupNetworkHolds(
  ownerDb: Database,
  input: {
    operator: string;
    reason: string;
    limit?: number;
    dryRun?: boolean;
    policyVersions?: readonly SignupNetworkHoldPolicyVersion[];
  },
): Promise<{
  candidates: number;
  wouldRelease?: { accountId: string; revision: number }[];
  released: { accountId: string; revision: number }[];
  skipped: { accountId: string; reason: string }[];
  dryRun: boolean;
}> {
  const limit = Math.max(1, Math.min(input.limit ?? 1000, 5000));
  const policyVersions = SIGNUP_NETWORK_HOLD_POLICY_VERSIONS.filter(
    (version) => !input.policyVersions || input.policyVersions.includes(version),
  );
  if (policyVersions.length === 0) throw new Error("no network hold policy version selected");
  const candidates = await rawRows<{ account_id: string; revision: number }>(
    ownerDb,
    sql`select d.account_id::text as account_id, d.revision::int as revision
      from promotion_decisions d
      join opengeni_private.promotion_decision_history h
        on h.data_schema = session_tenancy_fence_target_schema()::regnamespace::text
        and h.account_id = d.account_id and h.revision = d.revision
      where d.decision = 'held' and d.actor = ${PROMOTION_DETECTOR_ACTOR}
        and h.policy_version = any(${`{${policyVersions.join(",")}}`}::text[])
      order by d.account_id limit ${limit}`,
  );
  const released: { accountId: string; revision: number }[] = [];
  const skipped: { accountId: string; reason: string }[] = [];
  if (!input.dryRun) {
    for (const candidate of candidates) {
      try {
        const [row] = await rawRows<{ decision: { revision: number } }>(
          ownerDb,
          sql`select opengeni_private.set_promotion_decision(
            ${candidate.account_id}::uuid, 'eligible', 'operator-v1', 'manual-review',
            ${JSON.stringify({ reason: input.reason, bulkRelease: policyVersions.join(",") })}::jsonb,
            ${input.operator}, ${candidate.revision}::bigint) as decision`,
        );
        released.push({
          accountId: candidate.account_id,
          revision: Number(row!.decision.revision),
        });
      } catch (error) {
        skipped.push({
          accountId: candidate.account_id,
          reason:
            nestedPostgresSqlState(error) === "40001"
              ? "decision changed; review it individually"
              : "release failed",
        });
      }
    }
  }
  return {
    candidates: candidates.length,
    // A dry run lists exactly what an apply run would release.
    ...(input.dryRun
      ? {
          wouldRelease: candidates.map((candidate) => ({
            accountId: candidate.account_id,
            revision: Number(candidate.revision),
          })),
        }
      : {}),
    released,
    skipped,
    dryRun: input.dryRun === true,
  };
}
