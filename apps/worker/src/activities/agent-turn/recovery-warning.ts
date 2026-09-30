import { getSandboxRecoveryDiscontinuity, type Database } from "@opengeni/db";

/** v2 also recognizes system-selected checkpoint fallback receipts, and v3
 * the empty-workspace continuation receipts. A worker below the version a
 * session's receipts require cannot claim it (migrations 0526 and 0541). */
export const FILESYSTEM_DISCONTINUITY_PROTOCOL = 3 as const;

export async function recoveryAwareSessionInstructions(
  db: Database,
  workspaceId: string,
  session: { id: string; instructions?: string | null },
  readDiscontinuity: typeof getSandboxRecoveryDiscontinuity = getSandboxRecoveryDiscontinuity,
): Promise<string> {
  const filesystemDiscontinuity = await readDiscontinuity(db, workspaceId, session.id);
  return [session.instructions, filesystemDiscontinuity].filter(Boolean).join("\n\n");
}
