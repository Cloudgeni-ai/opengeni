import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Stored tool data resets: FORCE RLS, read, insert and update. */
export default {
  migration: "1557_sticky_tool_data_marks",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
