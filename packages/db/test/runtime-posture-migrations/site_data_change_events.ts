import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Site Data change outbox and insert idempotency keys: two full-DML FORCE-RLS tables. */
export default {
  migration: "1502_site_data_change_events",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
