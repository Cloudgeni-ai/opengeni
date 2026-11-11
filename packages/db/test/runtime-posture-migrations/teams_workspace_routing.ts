import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Teams workspace routing: chat choices, route prompts and their options, three
 * full-DML FORCE-RLS tables. */
export default {
  migration: "1363_teams_workspace_routing",
  forceRls: { fullDml: 3 },
} satisfies RuntimePostureMigration;
