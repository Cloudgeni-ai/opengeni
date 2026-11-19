import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** End-user display name and email for Console: read, insert and update, FORCE RLS. */
export default {
  migration: "1507_organization_end_user_profiles",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
