import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Credential profiles: one full-DML FORCE-RLS table. */
export default {
  migration: "1061_credential_profiles",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
