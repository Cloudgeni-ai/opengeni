import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Per-human consent history: runtime reads, grants and withdraws, without deletion. */
export default {
  migration: "1580_ai_processing_consent",
  forceRls: { readInsertUpdate: 1 },
} satisfies RuntimePostureMigration;
