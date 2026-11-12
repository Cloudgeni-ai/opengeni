import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Turn timing profiles: one full-DML FORCE-RLS table. */
export default {
  migration: "1351_turn_timing_profiles",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
