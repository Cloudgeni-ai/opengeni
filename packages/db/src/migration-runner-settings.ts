export type BatchedBackfillTransactionLocalSetting = {
  guc: `opengeni.${string}`;
  value: string;
};

/**
 * Exact owner-capability settings established before one governed batched
 * backfill statement. Keep this closed by migration filename: these GUCs may
 * open a FORCE-RLS policy arm and must never become ambient migration state.
 */
export function batchedBackfillTransactionLocalSetting(
  file: string,
): BatchedBackfillTransactionLocalSetting | null {
  if (file === "0406_new_session_draft_project_provenance_backfill.sql") {
    return {
      guc: "opengeni.new_session_draft_project_provenance_backfill_v1",
      value: "1",
    };
  }
  return null;
}
