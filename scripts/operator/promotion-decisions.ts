import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  captureFlaggedSignupNetworkOwners,
  createDb,
  getBillingBalance,
  HEEDEO_SIGNUP_MODES,
  listSignupHeedeoVerdicts,
  listSignupNetworkHolds,
  readSignupNetworkVelocitySettings,
  releaseSignupNetworkHolds,
  setSignupNetworkVelocitySettings,
  SIGNUP_NETWORK_HOLD_POLICY_VERSIONS,
  withAccountRls,
  type SignupNetworkHoldPolicyVersion,
  type SignupNetworkVelocityChanges,
} from "@opengeni/db";
import { sql } from "drizzle-orm";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    account: { type: "string" },
    decision: { type: "string" },
    operator: { type: "string" },
    list: { type: "boolean" },
    observations: { type: "boolean" },
    "detector-mode": { type: "string" },
    enforcement: { type: "string" },
    "all-readers-upgraded": { type: "boolean" },
    reason: { type: "string" },
    revision: { type: "string" },
    show: { type: "boolean" },
    "free-credit-cutoff": { type: "string" },
    "free-credit-cutoff-history": { type: "boolean" },
    // Signup network velocity (migration 1354).
    "network-velocity": { type: "boolean" },
    "network-velocity-set": { type: "boolean" },
    mode: { type: "string" },
    "window-hours": { type: "string" },
    "exact-threshold": { type: "string" },
    "prefix-threshold": { type: "string" },
    "rate-limit": { type: "string" },
    "rate-limit-max": { type: "string" },
    // Denied network rule (migration 1368).
    "denied-network-mode": { type: "string" },
    // Sign-in network velocity (migration 1471).
    "sign-in-network-mode": { type: "string" },
    // Email clusters (migration 1489).
    "email-domain-mode": { type: "string" },
    "email-domain-threshold": { type: "string" },
    "email-domain-window-minutes": { type: "string" },
    "burst-mode": { type: "string" },
    "burst-threshold": { type: "string" },
    "burst-window-seconds": { type: "string" },
    "denied-domain-mode": { type: "string" },
    "denied-domain-threshold": { type: "string" },
    "denied-domain-lookback-days": { type: "string" },
    // Disposable mail and slow domain legs (migration 1493).
    "disposable-mail-mode": { type: "string" },
    "slow-domain-mode": { type: "string" },
    "card-verification-mode": { type: "string" },
    // Heedeo signup scoring (migration 1565).
    "heedeo-signup-mode": { type: "string" },
    "heedeo-verdicts": { type: "boolean" },
    "slow-domain-threshold": { type: "string" },
    "slow-domain-window-hours": { type: "string" },
    rule: { type: "string" },
    "network-holds": { type: "boolean" },
    "network-capture-flagged": { type: "boolean" },
    "network-release-holds": { type: "boolean" },
    "dry-run": { type: "boolean" },
    limit: { type: "string" },
  },
});
const modes = [
  values.show,
  values.decision,
  values.list,
  values.enforcement,
  values.observations,
  values["detector-mode"],
  values["free-credit-cutoff"],
  values["free-credit-cutoff-history"],
  values["network-velocity"],
  values["network-velocity-set"],
  values["network-holds"],
  values["network-capture-flagged"],
  values["network-release-holds"],
  values["heedeo-verdicts"],
].filter(Boolean);
if (modes.length !== 1)
  throw new Error(
    "Choose --show, --list, --observations, --detector-mode off|observe|enforce, --enforcement on|off, --free-credit-cutoff <timestamp|none>, --free-credit-cutoff-history, --network-velocity, --network-velocity-set, --network-holds, --network-capture-flagged, --network-release-holds, --heedeo-verdicts, or --decision eligible|verification_required|held|denied",
  );
if (
  (values.show || values.decision) &&
  (!values.account || !/^[0-9a-f-]{36}$/i.test(values.account))
)
  throw new Error("Provide --account <uuid>");
if (values["heedeo-verdicts"] && values.account && !/^[0-9a-f-]{36}$/i.test(values.account))
  throw new Error("--account must be a uuid");
if (values.enforcement && !["on", "off"].includes(values.enforcement))
  throw new Error("--enforcement must be on or off");
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set an owner database URL (OPENGENI_MIGRATIONS_DATABASE_URL)");
const searchPath = dbSearchPath(getSettings());
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
/** Changes for --network-velocity-set; only the flags given are changed. */
function networkVelocityChanges(): SignupNetworkVelocityChanges {
  const changes: SignupNetworkVelocityChanges = {};
  const integer = (flag: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`--${flag} must be a whole number`);
    return Number(value);
  };
  if (values.mode !== undefined) {
    if (!["off", "observe", "enforce"].includes(values.mode))
      throw new Error("--mode must be off, observe or enforce");
    changes.mode = values.mode as "off" | "observe" | "enforce";
  }
  const windowHours = integer("window-hours", values["window-hours"]);
  if (windowHours !== undefined) changes.windowHours = windowHours;
  const exact = integer("exact-threshold", values["exact-threshold"]);
  if (exact !== undefined) changes.exactHoldThreshold = exact;
  if (values["prefix-threshold"] !== undefined)
    changes.prefixHoldThreshold =
      values["prefix-threshold"] === "none"
        ? null
        : integer("prefix-threshold", values["prefix-threshold"])!;
  if (values["rate-limit"] !== undefined) {
    if (!["on", "off"].includes(values["rate-limit"]))
      throw new Error("--rate-limit must be on or off");
    changes.rateLimitEnabled = values["rate-limit"] === "on";
  }
  const rateLimitMax = integer("rate-limit-max", values["rate-limit-max"]);
  if (rateLimitMax !== undefined) changes.rateLimitMax = rateLimitMax;
  if (values["denied-network-mode"] !== undefined) {
    if (!["off", "observe", "enforce"].includes(values["denied-network-mode"]))
      throw new Error("--denied-network-mode must be off, observe or enforce");
    changes.deniedNetworkMode = values["denied-network-mode"] as "off" | "observe" | "enforce";
  }
  if (values["sign-in-network-mode"] !== undefined) {
    if (!["off", "observe", "enforce"].includes(values["sign-in-network-mode"]))
      throw new Error("--sign-in-network-mode must be off, observe or enforce");
    changes.signInNetworkMode = values["sign-in-network-mode"] as "off" | "observe" | "enforce";
  }
  const legModes = [
    ["email-domain-mode", "emailDomainMode"],
    ["burst-mode", "burstMode"],
    ["denied-domain-mode", "deniedDomainMode"],
    ["disposable-mail-mode", "disposableMailMode"],
    ["slow-domain-mode", "slowDomainMode"],
  ] as const;
  for (const [flag, key] of legModes) {
    const value = values[flag];
    if (value === undefined) continue;
    if (value !== "off" && value !== "observe" && value !== "enforce")
      throw new Error(`--${flag} must be off, observe or enforce`);
    changes[key] = value;
  }
  if (values["card-verification-mode"] !== undefined) {
    const mode = values["card-verification-mode"];
    if (mode !== "off" && mode !== "enforce")
      throw new Error("--card-verification-mode must be off or enforce");
    changes.cardVerificationMode = mode;
  }
  if (values["heedeo-signup-mode"] !== undefined) {
    const mode = values["heedeo-signup-mode"];
    if (!(HEEDEO_SIGNUP_MODES as readonly string[]).includes(mode))
      throw new Error("--heedeo-signup-mode must be off, shadow or enforce");
    changes.heedeoSignupMode = mode as (typeof HEEDEO_SIGNUP_MODES)[number];
  }
  const emailDomainThreshold = integer("email-domain-threshold", values["email-domain-threshold"]);
  if (emailDomainThreshold !== undefined) changes.emailDomainHoldThreshold = emailDomainThreshold;
  const emailDomainWindow = integer(
    "email-domain-window-minutes",
    values["email-domain-window-minutes"],
  );
  if (emailDomainWindow !== undefined) changes.emailDomainWindowMinutes = emailDomainWindow;
  const burstThreshold = integer("burst-threshold", values["burst-threshold"]);
  if (burstThreshold !== undefined) changes.burstHoldThreshold = burstThreshold;
  const burstWindow = integer("burst-window-seconds", values["burst-window-seconds"]);
  if (burstWindow !== undefined) changes.burstWindowSeconds = burstWindow;
  const deniedDomainThreshold = integer(
    "denied-domain-threshold",
    values["denied-domain-threshold"],
  );
  if (deniedDomainThreshold !== undefined)
    changes.deniedDomainHoldThreshold = deniedDomainThreshold;
  const deniedDomainLookback = integer(
    "denied-domain-lookback-days",
    values["denied-domain-lookback-days"],
  );
  if (deniedDomainLookback !== undefined) changes.deniedDomainLookbackDays = deniedDomainLookback;
  const slowDomainThreshold = integer("slow-domain-threshold", values["slow-domain-threshold"]);
  if (slowDomainThreshold !== undefined) changes.slowDomainHoldThreshold = slowDomainThreshold;
  const slowDomainWindow = integer("slow-domain-window-hours", values["slow-domain-window-hours"]);
  if (slowDomainWindow !== undefined) changes.slowDomainWindowHours = slowDomainWindow;
  if (Object.keys(changes).length === 0)
    throw new Error(
      "Give at least one of --mode, --window-hours, --exact-threshold, --prefix-threshold, --rate-limit, --rate-limit-max, --denied-network-mode, --sign-in-network-mode, --email-domain-mode, --email-domain-threshold, --email-domain-window-minutes, --burst-mode, --burst-threshold, --burst-window-seconds, --denied-domain-mode, --denied-domain-threshold, --denied-domain-lookback-days, --disposable-mail-mode, --slow-domain-mode, --slow-domain-threshold, --slow-domain-window-hours, --card-verification-mode, --heedeo-signup-mode",
    );
  return changes;
}

try {
  if (values["network-velocity"]) {
    const db = client.db;
    console.log(JSON.stringify(await readSignupNetworkVelocitySettings(db), null, 2));
  } else if (values["network-velocity-set"]) {
    // Owner-only, revision-fenced (0 before the first write). The database
    // validates the values, the reason (6-1000 bytes) and the operator.
    if (
      !values.operator?.trim() ||
      !values.reason ||
      !values.revision ||
      !/^\d+$/.test(values.revision)
    )
      throw new Error(
        "Provide --operator, --reason, and --revision <current network velocity revision, 0 for none>",
      );
    const result = await setSignupNetworkVelocitySettings(client.db, {
      changes: networkVelocityChanges(),
      operator: `operator:${values.operator.trim()}`,
      reason: values.reason.trim(),
      expectedRevision: Number(values.revision),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (values["network-holds"]) {
    // Read-only, rolled back. Email domains, 16-hex network groups and
    // account UUIDs only; never full emails or addresses.
    const limit = values.limit && /^\d+$/.test(values.limit) ? Number(values.limit) : undefined;
    const result = await listSignupNetworkHolds(client.db, {
      ...(limit ? { limit } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (values["heedeo-verdicts"]) {
    // Read-only, rolled back. Recent Heedeo signup verdicts with the
    // organization the signup created and our own promotion decision on it.
    // UUIDs, codes and numbers only; never emails or addresses.
    const limit = values.limit && /^\d+$/.test(values.limit) ? Number(values.limit) : undefined;
    const result = await listSignupHeedeoVerdicts(client.db, {
      ...(limit ? { limit } : {}),
      ...(values.account ? { accountId: values.account } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (values["network-capture-flagged"]) {
    // Re-runs the 1368 backfill: captures the owners' sign-in networks of
    // every denied or held account (keyed hashes only). Safe to repeat.
    console.log(JSON.stringify(await captureFlaggedSignupNetworkOwners(client.db), null, 2));
  } else if (values["network-release-holds"]) {
    // Rollback: releases current detector holds of the network rules (both,
    // or one with --rule ip-velocity-v1|denied-network-v1|email-cluster-v1|additional-organization-v1).
    if (!values.operator?.trim() || !values.reason || values.reason.trim().length < 6)
      throw new Error("Provide --operator and --reason (six characters)");
    const limit = values.limit && /^\d+$/.test(values.limit) ? Number(values.limit) : undefined;
    const rule = values.rule as SignupNetworkHoldPolicyVersion | undefined;
    if (rule !== undefined && !SIGNUP_NETWORK_HOLD_POLICY_VERSIONS.includes(rule))
      throw new Error(`--rule must be one of ${SIGNUP_NETWORK_HOLD_POLICY_VERSIONS.join(", ")}`);
    const result = await releaseSignupNetworkHolds(client.db, {
      operator: `operator:${values.operator.trim()}`,
      reason: values.reason.trim(),
      dryRun: values["dry-run"] === true,
      ...(limit ? { limit } : {}),
      ...(rule ? { policyVersions: [rule] } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (values["detector-mode"]) {
    if (!values.operator?.trim()) throw new Error("Provide --operator");
    const result = await client.db.execute(sql`select opengeni_private.set_promotion_detector_mode(
      ${values["detector-mode"]}, ${`operator:${values.operator.trim()}`}) as mode`);
    console.log(JSON.stringify(result, null, 2));
  } else if (values["free-credit-cutoff"]) {
    // Owner-only, revision-fenced (0 before the first write). "none" clears it.
    // The database validates the reason (6-1000 bytes) and operator.
    if (
      !values.operator?.trim() ||
      !values.reason ||
      !values.revision ||
      !/^\d+$/.test(values.revision)
    )
      throw new Error(
        "Provide --operator, --reason, and --revision <current cutoff revision, 0 for none>",
      );
    const cutoff = values["free-credit-cutoff"].trim();
    // A zoneless timestamp would be read in the session time zone.
    if (
      cutoff !== "none" &&
      !/\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(cutoff)
    )
      throw new Error(
        "--free-credit-cutoff needs an explicit zone, for example 2026-10-29T15:08:00Z",
      );
    const notBefore = cutoff === "none" ? null : cutoff;
    const result = await client.db
      .execute(sql`select opengeni_private.set_free_credit_signup_cutoff(
      ${notBefore}::timestamptz, ${`operator:${values.operator.trim()}`}, ${values.reason.trim()}, ${values.revision}::bigint) as cutoff`);
    console.log(JSON.stringify(result, null, 2));
  } else if (values["free-credit-cutoff-history"]) {
    const result = await client.db
      .execute(sql`select revision, not_before, operator, reason, database_role, changed_at
      from opengeni_private.free_credit_signup_cutoff_revisions
      where data_schema=session_tenancy_fence_target_schema()::regnamespace::text
      order by revision desc limit 100`);
    console.log(JSON.stringify(result, null, 2));
  } else if (values.observations) {
    const result = await client.db
      .execute(sql`select * from opengeni_private.promotion_detector_observations
      where data_schema=session_tenancy_fence_target_schema()::regnamespace::text
      order by last_seen_at desc,account_id limit 100`);
    console.log(JSON.stringify(result, null, 2));
  } else if (values.list) {
    // Operator-only evidence inventory; never exposed through a public route.
    const rows = await client.db.execute(sql`select d.*, h.rule_id, h.policy_version, h.evidence
      from promotion_decisions d join opengeni_private.promotion_decision_history h
      on h.data_schema=session_tenancy_fence_target_schema()::regnamespace::text and h.account_id=d.account_id and h.revision=d.revision
      order by d.updated_at desc,d.account_id limit 100`);
    const result = [];
    for (const row of rows) {
      const accountId = String(row.account_id);
      const funding = await withAccountRls(client.db, accountId, async (tx) => {
        const [totals] =
          await tx.execute(sql`select coalesce(sum(p.granted_micros),0)::text as free_granted_micros,
          coalesce(sum(opengeni_private.plan_period_usage(p,clock_timestamp())),0)::text as free_spent_micros
          from plan_credit_periods p where p.account_id=${accountId}::uuid and p.plan_key='free'`);
        const balance = await getBillingBalance(tx, accountId);
        return {
          ...totals,
          held_credit_micros: balance.heldCreditMicros,
          balance_micros: balance.balanceMicros,
        };
      });
      result.push({ ...row, ...funding });
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (values.enforcement) {
    if (!values.operator?.trim() || !values.reason || values.reason.trim().length < 6)
      throw new Error("Provide --operator and --reason (six characters)");
    const result = await client.db.execute(sql`select opengeni_private.set_promotion_enforcement(
      ${values.enforcement === "on"},${values.operator.trim()},${values.reason.trim()},
      ${values["all-readers-upgraded"] === true}) as revision`);
    console.log(JSON.stringify(result, null, 2));
  } else if (values.show) {
    const result = await client.db
      .execute(sql`select * from opengeni_private.promotion_decision_history
      where data_schema=session_tenancy_fence_target_schema()::regnamespace::text and account_id=${values.account}::uuid
      order by revision desc limit 100`);
    // The owners' Heedeo signup verdicts beside our own decision history.
    const heedeoVerdicts = await listSignupHeedeoVerdicts(client.db, {
      accountId: values.account!,
      limit: 20,
    }).catch((error: unknown) => ({
      unavailable: error instanceof Error ? error.message : String(error),
    }));
    console.log(JSON.stringify({ history: result, heedeoVerdicts }, null, 2));
  } else {
    if (
      !values.operator?.trim() ||
      !values.reason ||
      values.reason.trim().length < 6 ||
      !values.revision ||
      !/^\d+$/.test(values.revision)
    )
      throw new Error(
        "Provide --operator, --reason (six characters), and --revision <current revision, 0 for new>",
      );
    const result = await client.db.execute(sql`select opengeni_private.set_promotion_decision(
      ${values.account}::uuid, ${values.decision!}, 'operator-v1', 'manual-review',
      ${JSON.stringify({ reason: values.reason.trim() })}::jsonb,
      ${`operator:${values.operator.trim()}`}, ${values.revision}::bigint) as decision`);
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await client.close();
}
