import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Automatic top-ups: two mutable journals and one append-only consent and
 * mutation receipt table, never DELETE, all FORCE RLS. */
export default {
  migration: "1257_billing_auto_top_up",
  forceRls: { readInsertUpdate: 2, readInsert: 1 },
} satisfies RuntimePostureMigration;
