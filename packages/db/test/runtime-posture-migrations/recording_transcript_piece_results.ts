import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Transcribed pieces kept for a version's retries: full DML, FORCE RLS. */
export default {
  migration: "1227_recording_transcript_piece_results",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
