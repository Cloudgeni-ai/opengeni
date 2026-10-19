/** Retry only the task-head fence before a producer has been admitted. The
 * operation must re-read the task and resolve fresh authority, not resubmit the
 * rejected snapshot. Already accepted producers retain their normal replay path.
 * Persistent contention still falls back to the bounded Temporal activity retry.
 */
export async function retryScheduledTaskAdmission<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !isScheduledTaskAdmissionConflict(error)) throw error;
    }
  }
}

function isScheduledTaskAdmissionConflict(error: unknown): boolean {
  // Drizzle wraps the postgres.js error in a cause. Match both the SQLSTATE and
  // exact server diagnostic; other serialization/authority failures are not a
  // license to resolve new authority for an already accepted occurrence.
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      record.code === "40001" &&
      record.message === "scheduled agent run task changed before producer admission"
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
