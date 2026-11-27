import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Per-turn credit totals and their per-call rows: runtime reads its
 * scope's rows and writes or deletes them only through the session_events,
 * usage_events and sessions invoker triggers (RLS requires
 * pg_trigger_depth() > 0). FORCE RLS. */
export default {
  migration: "1663_session_turn_credit_totals",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
