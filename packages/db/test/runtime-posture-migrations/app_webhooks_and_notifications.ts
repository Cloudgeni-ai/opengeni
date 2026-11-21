import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** App webhooks (full DML) and app notifications (read and insert), two FORCE-RLS tables. */
export default {
  migration: "1539_app_webhooks_and_notifications",
  forceRls: { fullDml: 1, readInsert: 1 },
} satisfies RuntimePostureMigration;
