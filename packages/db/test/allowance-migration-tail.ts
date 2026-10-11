/** Allowance migrations require the real 0461 Knowledge tables and 0539
 * refusal lifecycle. Historical fixtures withholding either prerequisite
 * must withhold and replay this entire ordered tail after it. */
export const allowanceMigrationTail = [
  "0552_usage_allowances.sql",
  "0553_non_model_debit_attribution.sql",
  "0554_video_allowance_refunds.sql",
  // Extends the scheduled refusal guard patched by withheld 0552.
  "0612_scheduled_model_unavailable_refusal.sql",
  // Extends attribution receipts introduced by withheld 0553.
  "0623_voice_transcription_attribution.sql",
  // Counts unbilled model calls into counters introduced by withheld 0552.
  "0638_allowance_unbilled_usage_metering.sql",
] as const;
