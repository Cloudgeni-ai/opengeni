import type { RuntimePostureMigration } from "../runtime-posture-migrations";

export default {
  migration: "1595_account_deletion",
  forceRls: { protectedNoDml: 1 },
} satisfies RuntimePostureMigration;
