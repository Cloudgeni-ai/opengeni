import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Teams install welcome claims: one full-DML FORCE-RLS table. */
export default {
  migration: "1294_teams_bot_welcomes",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
