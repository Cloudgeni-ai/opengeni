import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Per-turn credit totals and their per-call rows: runtime reads its
 * account's rows and writes them only through the session_events and
 * usage_events invoker triggers (RLS requires pg_trigger_depth() > 0).
 * FORCE RLS. */
export default {
  migration: "1599_session_turn_credit_totals",
  forceRls: { readInsertUpdate: 2 },
} satisfies RuntimePostureMigration;
