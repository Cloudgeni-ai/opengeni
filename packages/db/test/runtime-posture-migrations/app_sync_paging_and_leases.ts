import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** App data sync round two: the keys each sync wrote, one full-DML FORCE-RLS table. */
export default {
  migration: "1522_app_sync_paging_and_leases",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
