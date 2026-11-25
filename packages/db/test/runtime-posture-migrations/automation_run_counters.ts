import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Deployment-wide outcome counters: FORCE RLS, read/insert/update. */
export default {
  migration: "1566_automation_run_counters",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
