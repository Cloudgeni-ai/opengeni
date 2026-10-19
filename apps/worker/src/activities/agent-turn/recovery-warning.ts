import { getSandboxRecoveryDiscontinuity, type Database } from "@opengeni/db";

/** v2 also recognizes system-selected checkpoint fallback receipts, and v3
 * the empty-workspace continuation receipts. A worker below the version a
 * session's receipts require cannot claim it (migrations 0526 and 0548).
 * v4 distinguishes explicit archive abandonment from confirmed provider loss. */
export const FILESYSTEM_DISCONTINUITY_PROTOCOL = 4 as const;

export async function recoveryAwareSessionInstructions(
  db: Database,
  workspaceId: string,
  session: { id: string; instructions?: string | null },
  readDiscontinuity: typeof getSandboxRecoveryDiscontinuity = getSandboxRecoveryDiscontinuity,
): Promise<string> {
  // New explicit decisions belong at the history tail, never in an already-sent
  // instruction prefix. Preserve the exact legacy selection for older receipts.
  const filesystemDiscontinuity = await readDiscontinuity(
    db,
    workspaceId,
    session.id,
    "legacy_instructions",
  );
  return [session.instructions, filesystemDiscontinuity].filter(Boolean).join("\n\n");
}
