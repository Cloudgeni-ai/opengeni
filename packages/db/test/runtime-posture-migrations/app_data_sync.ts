import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** App data sync: the executor queue and personal opt-ins, two full-DML FORCE-RLS tables. */
export default {
  migration: "1517_app_data_sync",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
