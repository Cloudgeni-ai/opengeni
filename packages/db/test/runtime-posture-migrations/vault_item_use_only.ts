import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Use-only vault item marks: FORCE RLS, read and insert only (never undone). */
export default {
  migration: "1563_vault_item_use_only",
  forceRls: { readInsert: 1 },
} satisfies RuntimePostureMigration;
