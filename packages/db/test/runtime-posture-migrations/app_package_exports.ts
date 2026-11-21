import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** App package export files and their sweep: one full-DML FORCE-RLS table. */
export default {
  migration: "1542_app_package_exports",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
