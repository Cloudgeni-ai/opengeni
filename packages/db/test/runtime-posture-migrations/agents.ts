import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Agents and their Slack installations (full DML) and agent revisions (read and
 * insert), all FORCE RLS. */
export default {
  migration: "1243_agents",
  forceRls: { fullDml: 2, readInsert: 1 },
} satisfies RuntimePostureMigration;
