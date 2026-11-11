import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** GitHub installation repository removal markers: one full-DML FORCE-RLS table. */
export default {
  migration: "1293_github_installation_lookup",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
