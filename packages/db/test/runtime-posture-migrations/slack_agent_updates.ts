import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Slack agent update settings, recipients and deliveries: three full-DML
 * FORCE-RLS tables. */
export default {
  migration: "1153_slack_agent_updates",
  forceRls: { fullDml: 3 },
} satisfies RuntimePostureMigration;
