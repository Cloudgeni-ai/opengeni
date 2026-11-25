import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** The team workspace a Personal workspace meeting is shared with: full DML, FORCE RLS. */
export default {
  migration: "1566_recording_shares",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
