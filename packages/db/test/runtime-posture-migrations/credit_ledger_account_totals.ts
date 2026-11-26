import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Per-account credit ledger totals: runtime reads its account's row and
 * writes it only through the ledger's invoker triggers (RLS requires
 * pg_trigger_depth() > 0). FORCE RLS. */
export default {
  migration: "1576_credit_ledger_account_totals",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
