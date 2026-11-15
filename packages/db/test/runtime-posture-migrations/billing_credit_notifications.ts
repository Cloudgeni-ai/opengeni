import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Credit alert state, receipts and deliveries (full DML) and the current
 * billing recipients projection (runtime read-only), all FORCE RLS. */
export default {
  migration: "1241_billing_credit_notifications",
  forceRls: { fullDml: 3, readOnly: 1 },
} satisfies RuntimePostureMigration;
