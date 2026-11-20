import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** A connected agent's default workspace and app data reach: full DML, FORCE RLS. */
export default {
  migration: "1515_outside_agent_connection_settings",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
