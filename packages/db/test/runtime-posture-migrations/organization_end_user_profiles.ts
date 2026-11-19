import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** End-user display name and email for Console: full DML (erased on offboarding), FORCE RLS. */
export default {
  migration: "1510_organization_end_user_profiles",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
