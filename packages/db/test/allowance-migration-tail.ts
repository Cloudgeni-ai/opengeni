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
  // Patches the scheduled private-session proof whose personal-knowledge
  // branch is restored with this tail; replay after it.
  "0720_scheduled_task_audience.sql",
  // Requires 0720's audience column; it follows 0720.
  "0721_private_scheduled_task_summaries.sql",
  // Extends the scheduled refusal guard patched by withheld 0612 (exact
  // anchor) and meters into the allowance-era usage receipts; replay after it.
  "0773_session_usage_limits.sql",
  // Replaces the 0773 root-seed trigger with its statement-level form.
  "0781_session_usage_limit_statement_seed.sql",
  // Read-only probes and scheduling projections extend both allowance and
  // session-limit routines, so replay after those withheld definitions.
  "0847_read_only_runtime_probes.sql",
  // Moves 0638's unbilled counting into a shared helper over the counters
  // introduced by withheld 0552 and adds recording triggers; replay after it.
  "0976_recording_allowance_usage.sql",
  // Rewrites 0976's trigger function and calls its shared helper; replay after it.
  "0977_recording_credit_cost.sql",
] as const;
