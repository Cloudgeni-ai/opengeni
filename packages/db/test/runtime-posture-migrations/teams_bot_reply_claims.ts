import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Teams reply claims: one full-DML FORCE-RLS table. */
export default {
  migration: "1301_teams_bot_reply_claims",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
