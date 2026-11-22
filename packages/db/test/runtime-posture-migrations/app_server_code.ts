import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** App server code runs: one FORCE-RLS table with full DML (inserts, prune deletes);
 * stored tool data sources: FORCE RLS, read and insert. */
export default {
  migration: "1550_app_server_code",
  forceRls: { fullDml: 1, readInsert: 1 },
} satisfies RuntimePostureMigration;
