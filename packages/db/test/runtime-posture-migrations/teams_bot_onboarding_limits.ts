import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Teams onboarding reply limits: one full-DML FORCE-RLS table. */
export default {
  migration: "1300_teams_bot_onboarding_limits",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
