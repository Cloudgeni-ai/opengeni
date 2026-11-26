import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Per-account credit ledger totals: read, and upserted by the ledger writers'
 * invoker trigger (no DELETE; an account deletion cascades), FORCE RLS. */
export default {
  migration: "1576_credit_ledger_account_totals",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
