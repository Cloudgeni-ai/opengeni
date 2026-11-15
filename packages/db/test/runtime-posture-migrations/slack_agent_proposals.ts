import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Slack agent proposals and Ask forms: two full-DML FORCE-RLS tables. */
export default {
  migration: "1152_slack_agent_proposals",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
