import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Sidebar layouts (workspace default and personal changes): one full-DML FORCE-RLS table. */
export default {
  migration: "1515_sidebar_layouts",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
