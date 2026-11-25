import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Deployment-wide metrics: pending outcomes and compacted totals. */
export default {
  migration: "1566_automation_run_counters",
  forceRls: { fullDml: 1, readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
