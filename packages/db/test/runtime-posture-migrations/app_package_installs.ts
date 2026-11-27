import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Installed app packages and their saved earlier states: two full-DML FORCE-RLS tables. */
export default {
  migration: "1669_app_package_installs",
  forceRls: { fullDml: 2 },
} satisfies RuntimePostureMigration;
