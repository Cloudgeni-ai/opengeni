import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Where organization Skills work: one full-DML FORCE-RLS table. */
export default {
  migration: "1195_organization_skill_reach",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
