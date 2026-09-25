import { getSandboxRecoveryDiscontinuity, type Database } from "@opengeni/db";

/** v2 also recognizes system-selected checkpoint fallback receipts. A pre-v2
 * worker cannot claim a session whose filesystem has automatically diverged. */
export const FILESYSTEM_DISCONTINUITY_PROTOCOL = 2 as const;

export async function recoveryAwareSessionInstructions(
  db: Database,
  workspaceId: string,
  session: { id: string; instructions?: string | null },
  readDiscontinuity: typeof getSandboxRecoveryDiscontinuity = getSandboxRecoveryDiscontinuity,
): Promise<string> {
  const filesystemDiscontinuity = await readDiscontinuity(db, workspaceId, session.id);
  return [session.instructions, filesystemDiscontinuity].filter(Boolean).join("\n\n");
}
