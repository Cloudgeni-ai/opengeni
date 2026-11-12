import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Opengeni Console: managed workspace markers and review settings (full DML),
 * the append-only audit log and end-user labels (SELECT and INSERT), all FORCE RLS. */
export default {
  migration: "1377_opengeni_console",
  forceRls: { fullDml: 2, readInsert: 2 },
} satisfies RuntimePostureMigration;
