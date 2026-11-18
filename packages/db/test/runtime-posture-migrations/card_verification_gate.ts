import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Card verification gate: the runtime-read-only switch revisions and the
 * per-organization verified card (read, insert, update), both FORCE RLS. */
export default {
  migration: "1494_card_verification_gate",
  forceRls: { readOnly: 1, readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
