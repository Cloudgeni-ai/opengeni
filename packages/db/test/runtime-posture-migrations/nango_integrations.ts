import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Nango integrations: the operator backend switch (SELECT only) and the
 * append-only usage events (SELECT and INSERT), both FORCE RLS. */
export default {
  migration: "1406_nango_integrations",
  forceRls: { readOnly: 1, readInsert: 1 },
} satisfies RuntimePostureMigration;
