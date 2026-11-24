import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Custom credit offers: FORCE RLS, read-only; changed only by owner routines. */
export default {
  migration: "1563_custom_credit_offers",
  forceRls: { readOnly: 1 },
} satisfies RuntimePostureMigration;
