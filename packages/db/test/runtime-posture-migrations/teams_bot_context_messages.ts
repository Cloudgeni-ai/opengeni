import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Teams conversation context messages and join cutoffs: two full-DML FORCE-RLS
 * tables. */
export default {
  migration: "1258_teams_bot_context_messages",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
