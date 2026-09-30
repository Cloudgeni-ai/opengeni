/** Allowance migrations require the real 0461 Knowledge tables and 0539
 * refusal lifecycle. Historical fixtures withholding either prerequisite
 * must withhold and replay this entire ordered tail after it. */
export const allowanceMigrationTail = [
  "0552_usage_allowances.sql",
  "0553_non_model_debit_attribution.sql",
  "0554_video_allowance_refunds.sql",
] as const;
