import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Shared Site project placements: one full-DML FORCE-RLS table. */
export default {
  migration: "1071_site_project_placements",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
