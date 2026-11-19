import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Console roles of organization members and invitations: read, insert and
 * update (no delete; 'none' clears a role), FORCE RLS. */
export default {
  migration: "1510_organization_console_roles",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
