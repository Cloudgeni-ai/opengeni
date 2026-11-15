import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Organization connectors: one full-DML FORCE-RLS table. */
export default {
  migration: "1175_organization_connectors",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
