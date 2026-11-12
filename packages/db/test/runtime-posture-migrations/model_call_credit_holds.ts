import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Model call credit holds: one full-DML FORCE-RLS table. */
export default {
  migration: "1295_model_call_credit_holds",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
