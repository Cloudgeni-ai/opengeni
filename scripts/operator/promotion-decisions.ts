import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, getBillingBalance, withAccountRls } from "@opengeni/db";
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
  },
});
const modes = [
  values.show,
  values.decision,
  values.list,
  values.enforcement,
  values.observations,
  values["detector-mode"],
].filter(Boolean);
if (modes.length !== 1)
  throw new Error(
    "Choose --show, --list, --observations, --detector-mode off|observe|enforce, --enforcement on|off, or --decision eligible|verification_required|held|denied",
  );
if (
  (values.show || values.decision) &&
  (!values.account || !/^[0-9a-f-]{36}$/i.test(values.account))
)
  throw new Error("Provide --account <uuid>");
if (values.enforcement && !["on", "off"].includes(values.enforcement))
  throw new Error("--enforcement must be on or off");
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set an owner database URL (OPENGENI_MIGRATIONS_DATABASE_URL)");
const searchPath = dbSearchPath(getSettings());
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  if (values["detector-mode"]) {
    if (!values.operator?.trim()) throw new Error("Provide --operator");
    const result = await client.db.execute(sql`select opengeni_private.set_promotion_detector_mode(
      ${values["detector-mode"]}, ${`operator:${values.operator.trim()}`}) as mode`);
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
    console.log(JSON.stringify(result, null, 2));
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
