import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Slack agents and their per-person state: two full-DML FORCE-RLS tables. */
export default {
  migration: "1150_slack_agents",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
