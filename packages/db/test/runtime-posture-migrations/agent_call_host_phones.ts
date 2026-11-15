import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Agent call host phones: full DML, FORCE RLS. */
export default {
  migration: "1143_agent_call_host_phones",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
