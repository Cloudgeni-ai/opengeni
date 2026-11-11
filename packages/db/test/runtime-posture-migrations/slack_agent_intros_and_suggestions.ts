import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Slack agent intro posts and suggestions: two full-DML FORCE-RLS tables. */
export default {
  migration: "1235_slack_agent_intros_and_suggestions",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
