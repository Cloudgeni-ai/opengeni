import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Agent calls: read, insert and update, FORCE RLS. */
export default {
  migration: "1107_agent_calls",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
