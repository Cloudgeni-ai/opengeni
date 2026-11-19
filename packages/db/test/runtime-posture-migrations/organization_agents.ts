import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Console agents: organization tool servers, end users' tool logins and agent
 * workspace access (full DML), and publish operations (read, insert and
 * update), all FORCE RLS. */
export default {
  migration: "1502_organization_agents",
  forceRls: { fullDml: 3, readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
